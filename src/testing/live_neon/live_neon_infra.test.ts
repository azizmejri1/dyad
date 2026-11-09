// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Semaphore, TokenBucket, parseRetryAfter } from "./budget";
import { LIVE_ENV, campaignNamePrefix, liveNeonGate } from "./config";
import { FaultController } from "./faults";
import {
  CampaignJournal,
  deriveCampaignState,
  estimatedActiveEndpoints,
  readJournal,
} from "./journal";
import {
  normalizeEndpoint,
  percentile,
  summarizeRequests,
  type MetricSample,
} from "./metrics";
import { createRedactor, sanitizeError, scanForSecrets } from "./redact";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-neon-infra-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});

describe("liveNeonGate", () => {
  it("stays inert without the opt-in even when a key is present", () => {
    const gate = liveNeonGate({
      [LIVE_ENV.apiKey]: "napi_abcdefghijklmnopqrstuvwxyz",
    });
    expect(gate.enabled).toBe(false);
  });

  it("fails loudly when the opt-in is set but configuration is missing", () => {
    expect(() => liveNeonGate({ [LIVE_ENV.optIn]: "1" })).toThrow(
      /misconfigured[\s\S]*DYAD_LIVE_NEON_API_KEY is not set[\s\S]*DYAD_LIVE_NEON_ORG_ID/,
    );
  });

  it("enables a fully configured supervisor run", () => {
    const journal = path.join(dir, "journal.jsonl");
    fs.writeFileSync(journal, "");
    const gate = liveNeonGate({
      [LIVE_ENV.optIn]: "1",
      [LIVE_ENV.apiKey]: "napi_abcdefghijklmnopqrstuvwxyz",
      [LIVE_ENV.orgId]: "org-test-123",
      [LIVE_ENV.campaignId]: "20261109t1530-ab12",
      [LIVE_ENV.journal]: journal,
      [LIVE_ENV.runDir]: dir,
      [LIVE_ENV.profile]: "smoke",
      [LIVE_ENV.seed]: "7",
      [LIVE_ENV.deadline]: String(Date.now() + 60_000),
    });
    expect(gate.enabled).toBe(true);
    if (gate.enabled) {
      expect(gate.config.keyMode).toBe("organization");
      expect(gate.config.namePrefix).toBe(
        campaignNamePrefix("20261109t1530-ab12"),
      );
      expect(gate.config.seed).toBe(7);
    }
  });
});

describe("redaction", () => {
  const secret = "napi_SyntheticSecretValue0123456789";
  const redact = createRedactor([secret]);

  it("removes known secrets and credential shapes", () => {
    const text = [
      `key=${secret}`,
      "postgresql://neondb_owner:npg_AbCdEf123456@ep-cool-river-123.us-east-2.aws.neon.tech/neondb?sslmode=require",
      "Authorization: Bearer abcdefghijklmnop.qrstuv",
      '{"password":"hunter22","name":"ok"}',
      "Cookie: better-auth.session_token=abc123def456; other=1",
      "DATABASE_URL=postgres://u:p@h/db",
    ].join("\n");
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).not.toContain("npg_AbCdEf123456");
    expect(out).not.toContain("abcdefghijklmnop.qrstuv");
    expect(out).not.toContain("hunter22");
    expect(out).not.toContain("abc123def456");
    expect(out).toContain(
      "neondb_owner:[REDACTED]@ep-cool-river-123.us-east-2.aws.neon.tech",
    );
    expect(out).toContain('"name":"ok"');
    expect(out).toContain("DATABASE_URL=[REDACTED]");
  });

  it("projects SDK errors without config, headers or bodies", () => {
    const sdkError = Object.assign(
      new Error("Request failed with status code 423"),
      {
        name: "AxiosError",
        code: "ERR_BAD_REQUEST",
        config: { headers: { Authorization: `Bearer ${secret}` } },
        response: {
          status: 423,
          data: { code: "LOCKED", message: `project locked; key ${secret}` },
          headers: { "x-neon-ret-request-id": "req-1" },
        },
      },
    );
    const sanitized = sanitizeError(sdkError, redact);
    expect(sanitized).toEqual({
      name: "AxiosError",
      message: "project locked; key [REDACTED]",
      status: 423,
      code: "ERR_BAD_REQUEST",
      providerCode: "LOCKED",
      requestId: "req-1",
    });
    expect(JSON.stringify(sanitized)).not.toContain(secret);
  });

  it("scans retained artifacts and reports location, not the secret", () => {
    fs.mkdirSync(path.join(dir, "logs"));
    fs.writeFileSync(
      path.join(dir, "logs", "clean.log"),
      redact(`ok ${secret}\n`),
    );
    fs.writeFileSync(
      path.join(dir, "logs", "leak.log"),
      `line one\nleaked ${secret}\n`,
    );
    fs.writeFileSync(path.join(dir, "shot.png"), "binary");
    const { findings, unscannable } = scanForSecrets(dir, [secret]);
    expect(findings).toEqual(
      expect.arrayContaining([
        {
          file: path.join("logs", "leak.log"),
          detector: "known-secret",
          line: 2,
        },
      ]),
    );
    expect(findings.some((f) => f.file.endsWith("clean.log"))).toBe(false);
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(unscannable).toEqual(["shot.png"]);
  });
});

describe("ownership journal", () => {
  it("derives ownership, ambiguity and deletions", () => {
    const journal = CampaignJournal.create(
      path.join(dir, "journal.jsonl"),
      "test",
    );
    journal.append({
      type: "project-create-intent",
      intentId: "i1",
      name: "p1",
      actor: "product",
    });
    journal.append({
      type: "project-created",
      intentId: "i1",
      projectId: "proj-1",
      name: "p1",
      actor: "product",
    });
    journal.append({
      type: "project-create-intent",
      intentId: "i2",
      name: "p2",
      actor: "product",
    });
    journal.append({
      type: "project-create-failed",
      intentId: "i2",
      status: 503,
      ambiguous: true,
      actor: "product",
    });
    journal.append({
      type: "project-create-intent",
      intentId: "i3",
      name: "p3",
      actor: "fixture",
    });
    journal.append({
      type: "project-create-failed",
      intentId: "i3",
      status: 422,
      ambiguous: false,
      actor: "fixture",
    });
    journal.append({
      type: "project-create-intent",
      intentId: "i4",
      name: "p4",
      actor: "fixture",
    });
    journal.append({
      type: "branch-created",
      projectId: "proj-1",
      branchId: "br-1",
      name: "dev",
      hasEndpoint: true,
      actor: "product",
    });
    let state = journal.state();
    expect(state.projectIntents).toBe(4);
    expect(state.ambiguousIntents.map((i) => i.name)).toEqual(["p2", "p4"]);
    expect(state.projects.get("proj-1")).toMatchObject({
      actor: "product",
      deleted: false,
    });
    expect(estimatedActiveEndpoints(state)).toBe(2);

    journal.append({
      type: "deleted",
      kind: "project",
      projectId: "proj-1",
      actor: "verifier",
      verified: true,
    });
    state = journal.state();
    expect(state.projects.get("proj-1")).toMatchObject({
      deleted: true,
      verified: true,
      deletedBy: "verifier",
    });
    expect(state.branches.get("br-1")).toMatchObject({
      deleted: true,
      verified: true,
    });
    expect(estimatedActiveEndpoints(state)).toBe(0);
  });

  it("tolerates a torn final record but not a corrupt middle one", () => {
    const file = path.join(dir, "journal.jsonl");
    const journal = CampaignJournal.create(file, "test");
    journal.append({ type: "note", message: "one" });
    fs.appendFileSync(file, '{"type":"project-create-intent","intentId":"x"');
    expect(readJournal(file)).toHaveLength(1);
    fs.appendFileSync(file, '\n{"type":"note","message":"after"}\n');
    expect(() => readJournal(file)).toThrow(/Corrupt journal record/);
  });

  it("refuses to reuse an existing journal file", () => {
    const file = path.join(dir, "journal.jsonl");
    CampaignJournal.create(file, "test");
    expect(() => CampaignJournal.create(file, "test")).toThrow();
  });

  it("tracks sentinels until retired", () => {
    const records = [
      {
        type: "sentinel",
        kind: "project",
        projectId: "s1",
        name: "keep",
        at: "",
        pid: 1,
        writer: "t",
      },
      {
        type: "sentinel-retired",
        projectId: "s1",
        at: "",
        pid: 1,
        writer: "t",
      },
    ] as const;
    expect(deriveCampaignState([records[0]] as never).sentinels.size).toBe(1);
    expect(deriveCampaignState([...records] as never).sentinels.size).toBe(0);
  });
});

describe("budgets", () => {
  it("serves the burst, then paces to the rate, and backs off on throttling", async () => {
    vi.useFakeTimers();
    const bucket = new TokenBucket("t", 1, 2);
    const times: number[] = [];
    const start = Date.now();
    const takes = [0, 1, 2].map(() =>
      bucket.take().then(() => times.push(Date.now() - start)),
    );
    await vi.advanceTimersByTimeAsync(1_100);
    await Promise.all(takes);
    expect(times[0]).toBe(0);
    expect(times[1]).toBe(0);
    expect(times[2]).toBeGreaterThanOrEqual(1_000);

    bucket.onThrottle(5);
    expect(bucket.currentRatePerSecond).toBe(0.5);
    expect(bucket.throttleEvents).toBe(1);
    let done = false;
    const throttled = bucket.take().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(3_100);
    await throttled;
    expect(done).toBe(true);
  });

  it("caps concurrency", async () => {
    const semaphore = new Semaphore("sql", 2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active -= 1;
        }),
      ),
    );
    expect(peak).toBe(2);
    expect(semaphore.peak).toBe(2);
  });

  it("parses Retry-After seconds and dates", () => {
    expect(parseRetryAfter("3")).toBe(3);
    expect(parseRetryAfter(undefined)).toBeUndefined();
    const inTwoSeconds = new Date(Date.now() + 2_000).toUTCString();
    expect(parseRetryAfter(inTwoSeconds)).toBeGreaterThan(0);
  });
});

describe("fault controller", () => {
  it("targets the nth matching request and counts hits", () => {
    const faults = new FaultController();
    const handle = faults.add({
      id: "second-branch",
      transport: "management",
      method: "POST",
      path: /^\/projects\/[^/]+\/branches$/,
      skip: 1,
      action: { kind: "status", status: 503 },
    });
    expect(
      faults.match("management", "POST", "/projects/p/branches"),
    ).toBeUndefined();
    expect(
      faults.match("management", "GET", "/projects/p/branches"),
    ).toBeUndefined();
    expect(faults.match("sql", "POST", "/projects/p/branches")).toBeUndefined();
    expect(
      faults.match("management", "POST", "/projects/p/branches")?.action,
    ).toEqual({
      kind: "status",
      status: 503,
    });
    expect(
      faults.match("management", "POST", "/projects/p/branches"),
    ).toBeUndefined();
    expect(handle.hits()).toBe(1);
    expect(faults.hits.map((h) => h.ruleId)).toEqual(["second-branch"]);
  });

  it("holds gated requests until released", async () => {
    const faults = new FaultController();
    const handle = faults.add({
      id: "gate",
      transport: "sql",
      action: { kind: "gate" },
    });
    const hit = faults.match("sql", "POST", "/sql");
    let passed = false;
    const waiting = hit!.wait().then(() => (passed = true));
    await handle.reached;
    await Promise.resolve();
    expect(passed).toBe(false);
    handle.release();
    await waiting;
    expect(passed).toBe(true);
  });
});

describe("metrics", () => {
  it("computes nearest-rank percentiles", () => {
    expect(percentile([], 50)).toBeUndefined();
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
  });

  it("groups endpoints by template", () => {
    expect(normalizeEndpoint("post", "/projects/cool-river-1/branches")).toBe(
      "POST /projects/{id}/branches",
    );
    expect(
      normalizeEndpoint(
        "GET",
        "/projects/p/branches/br-x/roles/neondb_owner/reveal_password",
      ),
    ).toBe("GET /projects/{id}/branches/{id}/roles/{id}/reveal_password");
    const samples = [
      {
        kind: "request",
        transport: "management",
        op: "GET /projects",
        ok: true,
        status: 200,
        ms: 10,
        at: "",
        pid: 1,
      },
      {
        kind: "request",
        transport: "management",
        op: "GET /projects",
        ok: false,
        status: 429,
        ms: 30,
        injected: "status",
        at: "",
        pid: 1,
      },
    ] as MetricSample[];
    expect(
      summarizeRequests(samples)["management GET /projects"],
    ).toMatchObject({
      count: 2,
      p50: 10,
      max: 30,
      statuses: { "200": 1, "429": 1 },
      injected: 1,
    });
  });
});
