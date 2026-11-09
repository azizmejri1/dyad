// @vitest-environment node
// The journaled client and campaign cleanup against a local stand-in for the
// Neon Management API. Proves ownership is journaled at the SDK boundary,
// guards refuse unowned mutations, and cleanup reconciles lost creates
// without touching baseline or sentinel projects.
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TokenBucket } from "./budget";
import { cleanupCampaign, cleanupIsClean } from "./cleanup";
import { FaultController } from "./faults";
import { CampaignJournal } from "./journal";
import { CampaignGuardError, createJournaledNeonClient } from "./live_client";

const PREFIX = "dyad-live-20261109t1530-ab12";
const ORG = "org-test-123";

interface FakeProject {
  id: string;
  name: string;
  org_id: string;
  created_at: string;
  branches: Array<{ id: string; name: string; parent_id?: string }>;
}

class FakeNeonApi {
  projects = new Map<string, FakeProject>();
  requests: Array<{ method: string; path: string }> = [];
  /** Called before handling; may throw to fail the test from inside the server. */
  onRequest?: (method: string, path: string) => void;
  failDeletes = false;
  failNextCreate?: number;
  rateLimitNext = false;
  private seq = 0;
  private server = http.createServer((req, res) => this.handle(req, res));

  async start(): Promise<string> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/api/v2`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  seed(name: string, createdAt = new Date().toISOString()): FakeProject {
    const project: FakeProject = {
      id: `seed-${++this.seq}`,
      name,
      org_id: ORG,
      created_at: createdAt,
      branches: [{ id: `br-main-${this.seq}`, name: "main" }],
    };
    this.projects.set(project.id, project);
    return project;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const p = url.pathname.replace(/^\/api\/v2/, "");
      const method = req.method ?? "GET";
      this.requests.push({ method, path: p });
      const send = (
        status: number,
        data: unknown,
        headers: Record<string, string> = {},
      ) => {
        res.writeHead(status, {
          "content-type": "application/json",
          ...headers,
        });
        res.end(JSON.stringify(data));
      };
      try {
        this.onRequest?.(method, p);
      } catch (error) {
        return send(599, { message: String(error) });
      }
      if (this.rateLimitNext) {
        this.rateLimitNext = false;
        return send(429, { message: "slow down" }, { "retry-after": "0" });
      }
      let m: RegExpExecArray | null;
      if (method === "GET" && p === "/projects") {
        const search = url.searchParams.get("search");
        const list = [...this.projects.values()].filter(
          (x) => !search || x.name.includes(search),
        );
        return send(200, { projects: list });
      }
      if (method === "POST" && p === "/projects") {
        if (this.failNextCreate) {
          const status = this.failNextCreate;
          this.failNextCreate = undefined;
          // A 5xx after committing: the project exists, the caller is told it failed.
          if (status >= 500) {
            const { project } = JSON.parse(body);
            this.create(project.name, project.org_id);
          }
          return send(status, { message: "boom" });
        }
        const { project } = JSON.parse(body);
        const created = this.create(project.name, project.org_id);
        return send(201, {
          project: created,
          branch: created.branches[0],
          connection_uris: [
            {
              connection_uri:
                "postgresql://owner:npg_secret123456@ep-x.neon.tech/db",
            },
          ],
          operations: [{ id: "op-1" }],
        });
      }
      if ((m = /^\/projects\/([^/]+)$/.exec(p))) {
        const project = this.projects.get(m[1]);
        if (!project) return send(404, { message: "not found" });
        if (method === "GET") return send(200, { project });
        if (method === "DELETE") {
          if (this.failDeletes) return send(500, { message: "delete failed" });
          this.projects.delete(m[1]);
          return send(200, { project });
        }
      }
      if ((m = /^\/projects\/([^/]+)\/operations$/.exec(p))) {
        return send(200, { operations: [] });
      }
      if ((m = /^\/projects\/([^/]+)\/branches$/.exec(p))) {
        const project = this.projects.get(m[1]);
        if (!project) return send(404, { message: "not found" });
        if (method === "GET") return send(200, { branches: project.branches });
        if (method === "POST") {
          const { branch, endpoints } = JSON.parse(body);
          const created = {
            id: `br-${++this.seq}`,
            name: branch.name,
            parent_id: branch.parent_id,
          };
          project.branches.push(created);
          return send(201, {
            branch: created,
            endpoints: (endpoints ?? []).map(() => ({ id: `ep-${this.seq}` })),
          });
        }
      }
      if ((m = /^\/projects\/([^/]+)\/branches\/([^/]+)$/.exec(p))) {
        const project = this.projects.get(m[1]);
        const branch = project?.branches.find((b) => b.id === m![2]);
        if (!project || !branch) return send(404, { message: "not found" });
        if (method === "GET") return send(200, { branch });
        if (method === "DELETE") {
          project.branches = project.branches.filter((b) => b.id !== branch.id);
          return send(200, { branch });
        }
      }
      return send(404, { message: `no route ${method} ${p}` });
    });
  }

  private create(name: string, orgId: string): FakeProject {
    const project: FakeProject = {
      id: `proj-${++this.seq}`,
      name,
      org_id: orgId,
      created_at: new Date().toISOString(),
      branches: [{ id: `br-main-${this.seq}`, name: "main" }],
    };
    this.projects.set(project.id, project);
    return project;
  }
}

let api: FakeNeonApi;
let baseURL: string;
let dir: string;
let journal: CampaignJournal;
let faults: FaultController;

function client(
  actor: "product" | "fixture" | "supervisor" = "product",
  extra: { fencePath?: string } = {},
) {
  return createJournaledNeonClient({
    config: {
      apiKey: "napi_unit_test_key_value_0000",
      namePrefix: PREFIX,
      orgId: ORG,
    },
    journal,
    actor,
    budget: new TokenBucket("test", 1000, 1000),
    faults,
    baseURL,
    ...extra,
  });
}

function startCampaign(baseline: string[] = []) {
  journal.append({
    type: "campaign-start",
    campaignId: "20261109t1530-ab12",
    profile: "smoke",
    namePrefix: PREFIX,
    keyMode: "organization",
    orgId: ORG,
    baselineProjectIds: baseline,
    baselineComplete: true,
  });
}

beforeEach(async () => {
  api = new FakeNeonApi();
  baseURL = await api.start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "live-neon-client-"));
  journal = CampaignJournal.create(path.join(dir, "journal.jsonl"), "unit");
  faults = new FaultController();
});

afterEach(async () => {
  await api.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("journaled Neon client", () => {
  it("journals intent before sending and the ID before the caller sees it", async () => {
    startCampaign();
    api.onRequest = (method, p) => {
      if (method === "POST" && p === "/projects") {
        const state = journal.state();
        expect(state.ambiguousIntents.map((i) => i.name)).toEqual([
          `${PREFIX}-a`,
        ]);
        expect(state.projects.size).toBe(0);
      }
    };
    const { data } = await client().createProject({
      project: { name: `${PREFIX}-a`, org_id: ORG },
    });
    expect(journal.state().projects.get(data.project.id)).toMatchObject({
      name: `${PREFIX}-a`,
      actor: "product",
    });
    expect(journal.state().ambiguousIntents).toEqual([]);
    // Connection strings in responses never reach the journal.
    expect(fs.readFileSync(journal.path, "utf8")).not.toContain("npg_secret");

    const { data: branch } = await client().createProjectBranch(
      data.project.id,
      {
        endpoints: [{ type: "read_write" as never }],
        branch: { name: "development" },
      },
    );
    expect(journal.state().branches.get(branch.branch.id)).toMatchObject({
      hasEndpoint: true,
    });
  });

  it("refuses creates outside the campaign prefix and mutations of projects it does not own", async () => {
    const existing = api.seed(`${PREFIX}-baseline`);
    startCampaign([existing.id]);
    await expect(
      client().createProject({ project: { name: "someone-else" } }),
    ).rejects.toBeInstanceOf(CampaignGuardError);
    await expect(client().deleteProject(existing.id)).rejects.toThrow(
      /not created by this campaign/,
    );
    await expect(
      client().createProjectBranch(existing.id, { branch: { name: "x" } }),
    ).rejects.toThrow(/not created by this campaign/);
    // Reads are fine.
    await expect(client().getProject(existing.id)).resolves.toBeTruthy();
    expect(api.requests.filter((r) => r.method !== "GET")).toEqual([]);
    expect(api.projects.has(existing.id)).toBe(true);
  });

  it("enforces the concurrent-project budget and the fence", async () => {
    startCampaign();
    await client().createProject({ project: { name: `${PREFIX}-1` } });
    const { data: second } = await client().createProject({
      project: { name: `${PREFIX}-2` },
    });
    await expect(
      client().createProject({ project: { name: `${PREFIX}-3` } }),
    ).rejects.toThrow(/at most 2 owned projects/);
    const fencePath = path.join(dir, "FENCE");
    fs.writeFileSync(fencePath, "");
    await client().deleteProject(second.project.id);
    await expect(
      client("product", { fencePath }).createProject({
        project: { name: `${PREFIX}-4` },
      }),
    ).rejects.toThrow(/fenced/);
    // Deletion still works after the fence.
    const state = journal.state();
    const live = [...state.projects.values()].filter((p) => !p.deleted);
    expect(live).toHaveLength(1);
    await expect(
      client("product", { fencePath }).deleteProject(live[0].projectId),
    ).resolves.toBeTruthy();
  });

  it("classifies injected faults: never-sent is definitive, a server 5xx is ambiguous", async () => {
    startCampaign();
    faults.add({
      id: "locked",
      transport: "management",
      method: "POST",
      path: /^\/projects$/,
      action: { kind: "status", status: 423 },
    });
    const injected = await client()
      .createProject({ project: { name: `${PREFIX}-locked` } })
      .catch((e) => e);
    expect(injected.response.status).toBe(423);
    expect(injected.isInjectedFault).toBe(true);
    expect(api.requests.some((r) => r.method === "POST")).toBe(false);

    api.failNextCreate = 503;
    await expect(
      client().createProject({ project: { name: `${PREFIX}-flaky` } }),
    ).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(journal.state().ambiguousIntents.map((i) => i.name)).toEqual([
      `${PREFIX}-flaky`,
    ]);
  });

  it("backs off after a provider 429", async () => {
    startCampaign();
    const bucket = new TokenBucket("t", 1000, 1000);
    const c = createJournaledNeonClient({
      config: {
        apiKey: "napi_unit_test_key_value_0000",
        namePrefix: PREFIX,
        orgId: ORG,
      },
      journal,
      actor: "verifier",
      budget: bucket,
      baseURL,
    });
    api.rateLimitNext = true;
    await expect(c.listProjects({})).rejects.toMatchObject({
      response: { status: 429 },
    });
    expect(bucket.throttleEvents).toBe(1);
    expect(bucket.currentRatePerSecond).toBe(500);
  });
});

describe("campaign cleanup", () => {
  it("reconciles a lost create by exact name and leaves baseline and sentinel projects alone", async () => {
    // Pre-existing projects, one even sharing the campaign prefix.
    const baseline = api.seed(`${PREFIX}-preexisting`);
    const unrelated = api.seed("customer-prod");
    startCampaign([baseline.id, unrelated.id]);
    const sentinel = api.seed(`${PREFIX}-sentinel`);
    journal.append({
      type: "sentinel",
      kind: "project",
      projectId: sentinel.id,
      name: sentinel.name,
    });

    // A normal create whose test never cleaned up.
    const { data: owned } = await client("fixture").createProject({
      project: { name: `${PREFIX}-owned` },
    });
    // A create whose response was lost after Neon committed it.
    faults.add({
      id: "lost",
      transport: "management",
      method: "POST",
      path: /^\/projects$/,
      action: { kind: "lose-response" },
    });
    await expect(
      client().createProject({ project: { name: `${PREFIX}-lost` } }),
    ).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    const lost = [...api.projects.values()].find(
      (p) => p.name === `${PREFIX}-lost`,
    )!;
    expect(lost).toBeDefined();
    expect(journal.state().projects.has(lost.id)).toBe(false);

    const report = await cleanupCampaign({
      journal,
      client: client("supervisor"),
      timeoutMs: 30_000,
    });
    expect(report.reconciled).toEqual([
      {
        projectId: lost.id,
        name: lost.name,
        reason: "ambiguous create reconciled by exact name",
      },
    ]);
    expect(
      report.supervisorDeleted.map((d) => [d.projectId, d.createdBy]).sort(),
    ).toEqual(
      [
        [owned.project.id, "fixture"],
        [lost.id, "product"],
      ].sort(),
    );
    expect(report.sentinels).toEqual([
      {
        projectId: sentinel.id,
        branchId: undefined,
        name: sentinel.name,
        intact: true,
      },
    ]);
    expect(api.projects.has(baseline.id)).toBe(true);
    expect(api.projects.has(unrelated.id)).toBe(true);
    expect(api.projects.has(sentinel.id)).toBe(true);
    expect(api.projects.has(owned.project.id)).toBe(false);
    expect(api.projects.has(lost.id)).toBe(false);
    expect(report.remainingCampaignProjects).toEqual([]);
    expect(cleanupIsClean(report)).toBe(true);

    // Idempotent: a second cleanup-only pass finds nothing to do.
    const again = await cleanupCampaign({
      journal,
      client: client("supervisor"),
      timeoutMs: 30_000,
    });
    expect(again.supervisorDeleted).toEqual([]);
    expect(cleanupIsClean(again)).toBe(true);
  });

  it("sweeps campaign-named projects missing from the journal but never older baseline ones", async () => {
    const old = api.seed(`${PREFIX}-old`);
    startCampaign([old.id]);
    const stray = api.seed(`${PREFIX}-stray`);
    const report = await cleanupCampaign({
      journal,
      client: client("supervisor"),
      timeoutMs: 30_000,
    });
    expect(report.reconciled.map((r) => r.projectId)).toEqual([stray.id]);
    expect(api.projects.has(old.id)).toBe(true);
    expect(api.projects.has(stray.id)).toBe(false);
  });

  it("only lists, without retries or deletes, when the journal records no creation attempts", async () => {
    startCampaign();
    const report = await cleanupCampaign({
      journal,
      client: client("supervisor"),
      timeoutMs: 3_000,
    });
    expect(
      api.requests.every((r) => r.method === "GET" && r.path === "/projects"),
    ).toBe(true);
    expect(cleanupIsClean(report)).toBe(true);

    api.rateLimitNext = true;
    const started = Date.now();
    const outage = await cleanupCampaign({
      journal,
      client: client("supervisor"),
      timeoutMs: 60_000,
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(outage.inventoryComplete).toBe(false);
  });

  it("reports deletions it cannot complete instead of claiming success", async () => {
    startCampaign();
    const { data } = await client("fixture").createProject({
      project: { name: `${PREFIX}-stuck` },
    });
    api.failDeletes = true;
    const report = await cleanupCampaign({
      journal,
      client: client("supervisor"),
      timeoutMs: 3_000,
    });
    expect(report.unresolved.map((u) => u.projectId)).toEqual([
      data.project.id,
    ]);
    expect(report.remainingCampaignProjects.map((r) => r.projectId)).toEqual([
      data.project.id,
    ]);
    expect(cleanupIsClean(report)).toBe(false);
    expect(journal.state().unresolved).toHaveLength(1);
  });
});
