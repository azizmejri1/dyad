// Live Neon campaign supervisor and cleanup-only command.
//
//   npm run test:neon:live -- --profile smoke|standard|soak [--phase <id>] [--seed <n>]
//   npm run test:neon:live:preflight
//   npm run test:neon:live:cleanup -- --journal neon-live-runs/<campaign>/journal.jsonl
//   npm run test:neon:live:scan -- --dir neon-live-runs/<campaign>
//
// Credentials come only from the environment (DYAD_LIVE_NEON_API_KEY). They
// are never written to the journal, logs, metrics or reports, and the run
// directory is scanned for them before the command exits.
//
// Run through jiti; relative imports only.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import type { Api } from "@neondatabase/api-client";

import { TokenBucket } from "./budget";
import { cleanupCampaign, cleanupIsClean, type CleanupReport } from "./cleanup";
import {
  CAMPAIGN_LIMITS,
  LIVE_ENV,
  PROFILE_WORKLOAD,
  campaignNamePrefix,
  isProfile,
  type LiveNeonProfile,
} from "./config";
import { CampaignJournal, readJournal, type JournalRecord } from "./journal";
import { createJournaledNeonClient } from "./live_client";
import { readMetrics, summarizeRequests, type MetricSample } from "./metrics";
import {
  deleteProjectVerified,
  httpStatus,
  listAllProjects,
  listBranches,
  projectExists,
  waitForOperations,
} from "./neon_ops";
import { COVERAGE, PHASES, phasesFor, type PhaseDef } from "./phases";
import {
  createRedactor,
  sanitizeError,
  scanForSecrets,
  type Redactor,
} from "./redact";

const REPO_ROOT = process.cwd();
const RUNS_DIR = path.join(REPO_ROOT, "neon-live-runs");
const CLI_PATH = path.relative(
  REPO_ROOT,
  path.join(REPO_ROOT, "src/testing/live_neon/cli.ts"),
);

interface Env {
  apiKey: string;
  orgId?: string;
  projectId?: string;
  region?: string;
}

function fail(message: string): never {
  process.stderr.write(`\n[neon-live] ${message}\n`);
  process.exit(2);
}

function readEnv(): Env {
  const apiKey = process.env[LIVE_ENV.apiKey]?.trim();
  if (!apiKey) {
    fail(
      `${LIVE_ENV.apiKey} is not set. Provide it through your secret manager/environment, never on the command line.`,
    );
  }
  const orgId = process.env[LIVE_ENV.orgId]?.trim() || undefined;
  const projectId = process.env[LIVE_ENV.projectId]?.trim() || undefined;
  if (!orgId && !projectId) {
    fail(
      `Set ${LIVE_ENV.orgId} (expected organization for a personal/org key) or ${LIVE_ENV.projectId} (pre-created project for a project-scoped key).`,
    );
  }
  return {
    apiKey,
    orgId,
    projectId,
    region: process.env[LIVE_ENV.region]?.trim() || undefined,
  };
}

function log(redact: Redactor, message: string) {
  process.stdout.write(`${redact(`[neon-live] ${message}`)}\n`);
}

function supervisorClient(
  env: Env,
  journal: CampaignJournal,
  namePrefix: string,
  maxProjectsPerCampaign?: number,
): Api<unknown> {
  return createJournaledNeonClient({
    config: {
      apiKey: env.apiKey,
      namePrefix,
      orgId: env.orgId,
      projectId: env.projectId,
    },
    journal,
    actor: "supervisor",
    maxProjectsPerCampaign,
    budget: new TokenBucket(
      "supervisor",
      CAMPAIGN_LIMITS.managementRequestsPerSecond,
      CAMPAIGN_LIMITS.managementBurst,
    ),
  });
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

interface Preflight {
  keyMode: "organization" | "project";
  baselineProjectIds: string[];
  baselineComplete: boolean;
  quotas: Record<string, unknown>;
  problems: string[];
  notes: string[];
}

async function preflight(env: Env, client: Api<unknown>): Promise<Preflight> {
  const result: Preflight = {
    keyMode: env.orgId ? "organization" : "project",
    baselineProjectIds: [],
    baselineComplete: false,
    quotas: {},
    problems: [],
    notes: [],
  };
  try {
    const { data } = await client.getCurrentUserInfo();
    result.quotas = {
      plan: data.plan,
      projects_limit: data.projects_limit,
      branches_limit: data.branches_limit,
      max_autoscaling_limit: data.max_autoscaling_limit,
    };
  } catch (error) {
    result.notes.push(
      `user info unavailable (status ${httpStatus(error) ?? "network"}); quotas are discovered from provider rejections instead`,
    );
  }
  if (env.orgId) {
    try {
      const { data } = await client.getOrganization(env.orgId);
      result.quotas.organization_plan = (data as { plan?: unknown }).plan;
    } catch (error) {
      result.notes.push(
        `organization details unavailable (status ${httpStatus(error) ?? "network"})`,
      );
    }
    try {
      const listed = await listAllProjects(client, { orgId: env.orgId });
      result.baselineProjectIds = listed.projects.map((p) => p.id);
      result.baselineComplete = listed.complete;
      if (!listed.complete)
        result.problems.push(
          "project inventory is incomplete; cannot establish a baseline",
        );
      const limit = Number(result.quotas.projects_limit);
      if (
        Number.isFinite(limit) &&
        limit > 0 &&
        listed.projects.length + CAMPAIGN_LIMITS.maxConcurrentProjects > limit
      ) {
        result.problems.push(
          `the account has ${listed.projects.length} projects and a limit of ${limit}; the campaign needs ${CAMPAIGN_LIMITS.maxConcurrentProjects} free. Existing projects are never deleted by the campaign.`,
        );
      }
      result.notes.push(
        `baseline inventory: ${listed.projects.length} existing project(s), left untouched`,
      );
    } catch (error) {
      result.problems.push(
        `cannot list projects in organization ${env.orgId} (status ${httpStatus(error) ?? "network"}): wrong key scope or organization`,
      );
    }
  }
  if (env.projectId) {
    try {
      const branches = await listBranches(client, env.projectId);
      const free = CAMPAIGN_LIMITS.maxBranchesPerProject - branches.length;
      result.notes.push(
        `project ${env.projectId}: ${branches.length} branch(es), ${free} free under the campaign cap`,
      );
      if (free < 2 + CAMPAIGN_LIMITS.reservedBranchSlots) {
        result.problems.push(
          `project ${env.projectId} has too few free branch slots (${free})`,
        );
      }
      if (!env.orgId) {
        result.notes.push(
          "project-scoped key: project lifecycle scenarios (create/delete) are skipped and reported as such",
        );
      }
    } catch (error) {
      result.problems.push(
        `cannot read project ${env.projectId} (status ${httpStatus(error) ?? "network"})`,
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Running vitest children
// ---------------------------------------------------------------------------

interface VitestCounts {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: Array<{ test: string; message: string }>;
  skippedTests: string[];
}

interface ChildResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  durationMs: number;
  counts?: VitestCounts;
}

function lineRedactingSink(
  redact: Redactor,
  logFile: string,
  echo: NodeJS.WritableStream,
) {
  let buffer = "";
  const out = fs.createWriteStream(logFile, { flags: "a", mode: 0o600 });
  const flush = (text: string) => {
    const clean = redact(text);
    echo.write(clean);
    out.write(clean);
  };
  return {
    // Buffer partial lines: a secret split across chunks must still match.
    write(chunk: Buffer) {
      buffer += chunk.toString("utf8");
      const lastNewline = buffer.lastIndexOf("\n");
      if (lastNewline >= 0) {
        flush(buffer.slice(0, lastNewline + 1));
        buffer = buffer.slice(lastNewline + 1);
      }
    },
    end() {
      if (buffer) flush(`${buffer}\n`);
      buffer = "";
      out.end();
    },
  };
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function readVitestJson(
  file: string,
  redact: Redactor,
): VitestCounts | undefined {
  if (!fs.existsSync(file)) return undefined;
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    numTotalTests: number;
    numPassedTests: number;
    numFailedTests: number;
    numPendingTests: number;
    numTodoTests?: number;
    testResults: Array<{
      name: string;
      message?: string;
      assertionResults: Array<{
        fullName: string;
        status: string;
        failureMessages: string[];
      }>;
    }>;
  };
  const failures: VitestCounts["failures"] = [];
  const skippedTests: string[] = [];
  for (const file of raw.testResults) {
    if (file.message && file.assertionResults.length === 0) {
      failures.push({
        test: path.relative(REPO_ROOT, file.name),
        message: redact(stripAnsi(file.message)).slice(0, 4000),
      });
    }
    for (const test of file.assertionResults) {
      if (test.status === "failed") {
        failures.push({
          test: test.fullName,
          message: redact(stripAnsi(test.failureMessages.join("\n"))).slice(
            0,
            4000,
          ),
        });
      } else if (
        test.status === "pending" ||
        test.status === "skipped" ||
        test.status === "todo"
      ) {
        skippedTests.push(test.fullName);
      }
    }
  }
  // Failure messages can quote credentials; persist only the redacted form.
  fs.writeFileSync(file, redact(JSON.stringify(raw)), { mode: 0o600 });
  return {
    total: raw.numTotalTests,
    passed: raw.numPassedTests,
    failed: raw.numFailedTests,
    skipped: raw.numPendingTests + (raw.numTodoTests ?? 0),
    failures,
    skippedTests,
  };
}

function runChild(
  command: string,
  args: string[],
  {
    env,
    timeoutMs,
    logFile,
    redact,
  }: {
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    logFile: string;
    redact: Redactor;
  },
): Promise<Omit<ChildResult, "counts">> {
  return new Promise((resolve) => {
    const start = Date.now();
    const posix = process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: posix,
    });
    const stdout = lineRedactingSink(redact, logFile, process.stdout);
    const stderr = lineRedactingSink(redact, logFile, process.stderr);
    child.stdout.on("data", (c: Buffer) => stdout.write(c));
    child.stderr.on("data", (c: Buffer) => stderr.write(c));
    let timedOut = false;
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (posix && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // Already gone.
      }
    };
    const timer = setTimeout(
      () => {
        timedOut = true;
        killTree("SIGTERM");
        setTimeout(() => killTree("SIGKILL"), 20_000).unref();
      },
      Math.max(1_000, timeoutMs),
    );
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      stdout.end();
      stderr.end();
      resolve({ exitCode, signal, timedOut, durationMs: Date.now() - start });
    });
  });
}

interface CampaignContext {
  env: Env;
  profile: LiveNeonProfile;
  seed: number;
  campaignId: string;
  namePrefix: string;
  runDir: string;
  journal: CampaignJournal;
  client: Api<unknown>;
  redact: Redactor;
  workloadDeadline: number;
}

function childEnv(
  ctx: CampaignContext,
  overrides: {
    phase: string;
    journal?: string;
    campaignId?: string;
    runDir?: string;
    crashProbe?: string;
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.E2E_TEST_BUILD;
  delete env[LIVE_ENV.crashProbe];
  Object.assign(env, {
    [LIVE_ENV.optIn]: "1",
    [LIVE_ENV.campaignId]: overrides.campaignId ?? ctx.campaignId,
    [LIVE_ENV.journal]: overrides.journal ?? ctx.journal.path,
    [LIVE_ENV.runDir]: overrides.runDir ?? ctx.runDir,
    [LIVE_ENV.profile]: ctx.profile,
    [LIVE_ENV.seed]: String(ctx.seed),
    [LIVE_ENV.phase]: overrides.phase,
    [LIVE_ENV.deadline]: String(ctx.workloadDeadline),
    NODE_OPTIONS: "--no-deprecation",
    VITE_CJS_IGNORE_WARNING: "true",
    FORCE_COLOR: "0",
  });
  if (overrides.crashProbe) env[LIVE_ENV.crashProbe] = overrides.crashProbe;
  return env;
}

async function runVitest(
  ctx: CampaignContext,
  phaseId: string,
  files: string[],
  timeoutMs: number,
  overrides: Parameters<typeof childEnv>[1] = { phase: phaseId },
): Promise<ChildResult> {
  const outDir = overrides.runDir ?? ctx.runDir;
  const jsonFile = path.join(outDir, `vitest-${phaseId}-${Date.now()}.json`);
  const result = await runChild(
    process.execPath,
    [
      path.join(REPO_ROOT, "node_modules/vitest/vitest.mjs"),
      "run",
      "--project",
      "integration",
      "--no-file-parallelism",
      "--maxWorkers=1",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${jsonFile}`,
      ...files,
    ],
    {
      env: childEnv(ctx, overrides),
      timeoutMs,
      logFile: path.join(outDir, `${phaseId}.log`),
      redact: ctx.redact,
    },
  );
  return { ...result, counts: readVitestJson(jsonFile, ctx.redact) };
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

type PhaseStatus = "passed" | "failed" | "incomplete" | "timed-out" | "not-run";

interface PhaseResult {
  id: string;
  title: string;
  status: PhaseStatus;
  durationMs: number;
  detail: string[];
  counts?: VitestCounts;
  iterations?: number;
  crash?: Record<string, unknown>;
  findings: Finding[];
}

interface Finding {
  classification:
    | "dyad-defect"
    | "provider-constraint"
    | "harness-defect"
    | "environment"
    | "needs-triage";
  title: string;
  evidence: string;
}

function vitestStatus(result: ChildResult): {
  status: PhaseStatus;
  detail: string[];
} {
  const detail: string[] = [];
  if (result.timedOut)
    return {
      status: "timed-out",
      detail: ["phase deadline reached; child killed"],
    };
  const counts = result.counts;
  if (!counts) {
    return {
      status: "failed",
      detail: [
        `no vitest report (exit ${result.exitCode ?? result.signal}); collection or startup failed`,
      ],
    };
  }
  if (counts.total === 0) {
    return {
      status: "failed",
      detail: ["zero tests ran: a live run must never pass vacuously"],
    };
  }
  if (counts.failed > 0 || result.exitCode !== 0) {
    detail.push(`${counts.failed} failed of ${counts.total}`);
    return { status: "failed", detail };
  }
  if (counts.skipped > 0) {
    detail.push(`${counts.skipped} skipped: ${counts.skippedTests.join("; ")}`);
    return { status: "incomplete", detail };
  }
  return {
    status: "passed",
    detail: [`${counts.passed}/${counts.total} passed`],
  };
}

async function runVitestPhase(
  ctx: CampaignContext,
  phase: PhaseDef,
): Promise<PhaseResult> {
  const start = Date.now();
  const findings: Finding[] = [];
  const phaseDeadline = Math.min(
    start + phase.timeoutMs,
    phase.repeatUntilDeadline ? Infinity : ctx.workloadDeadline,
  );
  let iterations = 0;
  let last: ChildResult | undefined;
  let status: PhaseStatus = "passed";
  let detail: string[] = [];
  const aggregate: VitestCounts = {
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failures: [],
    skippedTests: [],
  };
  do {
    iterations += 1;
    last = await runVitest(
      ctx,
      `${phase.id}${phase.repeatUntilDeadline ? `-${iterations}` : ""}`,
      phase.files,
      phaseDeadline - Date.now(),
      {
        phase: phase.id,
      },
    );
    ({ status, detail } = vitestStatus(last));
    if (last.counts) {
      aggregate.total += last.counts.total;
      aggregate.passed += last.counts.passed;
      aggregate.failed += last.counts.failed;
      aggregate.skipped += last.counts.skipped;
      aggregate.failures.push(...last.counts.failures);
      aggregate.skippedTests.push(...last.counts.skippedTests);
    }
  } while (
    phase.repeatUntilDeadline &&
    status === "passed" &&
    phaseDeadline - Date.now() > 10 * 60_000
  );
  for (const failure of aggregate.failures) {
    findings.push({
      classification: "needs-triage",
      title: failure.test,
      evidence: failure.message.split("\n").slice(0, 12).join("\n"),
    });
  }
  return {
    id: phase.id,
    title: phase.title,
    status,
    durationMs: Date.now() - start,
    detail,
    counts: aggregate,
    iterations: phase.repeatUntilDeadline ? iterations : undefined,
    findings,
  };
}

async function runCrashPhase(
  ctx: CampaignContext,
  phase: PhaseDef,
): Promise<PhaseResult> {
  const start = Date.now();
  const detail: string[] = [];
  const findings: Finding[] = [];
  const crash: Record<string, unknown> = { variant: phase.crashVariant };
  if (!ctx.env.orgId) {
    return {
      id: phase.id,
      title: phase.title,
      status: "incomplete",
      durationMs: 0,
      detail: [
        "skipped: needs an organization/personal key to create projects",
      ],
      findings,
    };
  }
  const subDir = path.join(ctx.runDir, `crash-${phase.id}`);
  fs.mkdirSync(subDir, { recursive: true, mode: 0o700 });
  const subCampaignId = `${ctx.campaignId}-${phase.crashVariant === "fixture" ? "cf" : "cp"}`;
  const subPrefix = campaignNamePrefix(subCampaignId);
  const subJournalPath = path.join(subDir, "journal.jsonl");

  // A pre-existing resource whose name even matches the probe's prefix: the
  // probe's cleanup must leave it untouched.
  const sentinelName = `${subPrefix}-sentinel-${randomBytes(3).toString("hex")}`;
  const { data: sentinelData } = await ctx.client.createProject({
    project: { name: sentinelName, org_id: ctx.env.orgId },
  });
  const sentinelId = sentinelData.project.id;
  ctx.journal.append({
    type: "sentinel",
    kind: "project",
    projectId: sentinelId,
    name: sentinelName,
  });
  let status: PhaseStatus = "failed";
  try {
    await waitForOperations(ctx.client, sentinelId);
    const inventory = await listAllProjects(ctx.client, {
      orgId: ctx.env.orgId,
    });
    const subJournal = CampaignJournal.create(subJournalPath, "supervisor");
    subJournal.append({
      type: "campaign-start",
      campaignId: subCampaignId,
      profile: ctx.profile,
      namePrefix: subPrefix,
      keyMode: "organization",
      orgId: ctx.env.orgId,
      region: ctx.env.region,
      baselineProjectIds: inventory.projects.map((p) => p.id),
      baselineComplete: inventory.complete,
    });
    subJournal.append({
      type: "sentinel",
      kind: "project",
      projectId: sentinelId,
      name: sentinelName,
    });

    const child = await runVitest(ctx, phase.id, phase.files, phase.timeoutMs, {
      phase: phase.id,
      journal: subJournalPath,
      campaignId: subCampaignId,
      runDir: subDir,
      crashProbe: phase.crashVariant,
    });
    const subState = subJournal.state();
    const created = [...subState.projects.values()];
    const createdIds = new Set(created.map((p) => p.projectId));
    const workerExit = readJournal(subJournalPath).some(
      (r) => r.type === "worker" && r.event === "exit",
    );
    const crashed = !child.timedOut && child.exitCode !== 0 && !workerExit;
    crash.childExit = child.exitCode ?? child.signal;
    crash.crashedAfterCreate = crashed && created.length > 0;
    crash.createdProjects = created.length;
    crash.productDeletedBeforeCleanup = created.filter((p) => p.deleted).length;
    if (!crashed) detail.push("probe did not die abruptly (harness defect)");
    if (created.length === 0)
      detail.push(
        "probe crashed before Neon created anything (harness defect)",
      );

    // The cleanup-only command, as a separate process, against the probe's journal.
    const cleanupJson = path.join(subDir, "cleanup.json");
    const cleanupRun = await runChild(
      process.execPath,
      [
        path.join(REPO_ROOT, "node_modules/jiti/lib/jiti-cli.mjs"),
        CLI_PATH,
        "cleanup",
        "--journal",
        subJournalPath,
        "--json",
        cleanupJson,
      ],
      {
        env: { ...process.env, FORCE_COLOR: "0" },
        timeoutMs: CAMPAIGN_LIMITS.cleanupWindowMs,
        logFile: path.join(subDir, "cleanup.log"),
        redact: ctx.redact,
      },
    );
    const report: CleanupReport | undefined = fs.existsSync(cleanupJson)
      ? (JSON.parse(fs.readFileSync(cleanupJson, "utf8")) as CleanupReport)
      : undefined;
    crash.cleanupExit = cleanupRun.exitCode;
    crash.cleanup = report;
    const rescued =
      report?.supervisorDeleted.filter((d) => createdIds.has(d.projectId)) ??
      [];
    const sentinelOk =
      report?.sentinels.find((s) => s.projectId === sentinelId)?.intact ===
      true;
    const sentinelStillThere =
      (await projectExists(ctx.client, sentinelId)) &&
      (await ctx.client.getProject(sentinelId)).data.project.name ===
        sentinelName;
    crash.sentinelIntact = sentinelOk && sentinelStillThere;
    if (!report) detail.push("cleanup-only command produced no report");
    else if (!cleanupIsClean(report))
      detail.push(
        "cleanup-only command left unresolved or remaining resources",
      );
    if (!sentinelOk || !sentinelStillThere)
      detail.push("sentinel project was modified or deleted");
    if (
      created.length > 0 &&
      rescued.length + (report?.verifiedAbsent ?? 0) < created.length
    ) {
      detail.push("cleanup did not account for every created project");
    }
    for (const project of rescued) {
      if (project.createdBy === "product") {
        findings.push({
          classification: "dyad-defect",
          title:
            "Crash during Neon project provisioning leaves an orphaned project",
          evidence: `Dyad created project ${project.projectId} (${project.name}) and was killed before linking it; nothing in Dyad recorded or recovered it. The supervisor deleted it from the journal.`,
        });
      }
    }
    status = detail.length === 0 ? "passed" : "failed";
    if (status === "passed") {
      // Local temp state of the killed worker (contains dead credentials).
      for (const record of readJournal(subJournalPath)) {
        if (
          record.type === "worker" &&
          record.event === "start" &&
          record.userDataDir
        ) {
          const tmpRoot = path.dirname(record.userDataDir);
          if (path.basename(tmpRoot).startsWith("dyad-chat-flow-")) {
            fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 3 });
          }
        }
      }
    } else {
      detail.push(
        "the killed worker's temp directory was kept for review; it holds dead credentials, delete it afterwards",
      );
    }
    // Account for the probe's projects in the campaign journal too.
    for (const project of created) {
      ctx.journal.append({
        type: "project-adopted",
        projectId: project.projectId,
        name: project.name,
        reason: `crash probe ${phase.id}`,
      });
      if (
        rescued.some((r) => r.projectId === project.projectId) ||
        project.verified
      ) {
        ctx.journal.append({
          type: "deleted",
          kind: "project",
          projectId: project.projectId,
          actor: "supervisor",
          verified: true,
        });
      }
    }
  } catch (error) {
    detail.push(
      `supervisor error: ${sanitizeError(error, ctx.redact).message}`,
    );
    status = "failed";
  } finally {
    ctx.journal.append({ type: "sentinel-retired", projectId: sentinelId });
    try {
      const result = await deleteProjectVerified(ctx.client, sentinelId);
      if (result.deleted) {
        ctx.journal.append({
          type: "deleted",
          kind: "project",
          projectId: sentinelId,
          actor: "supervisor",
          verified: true,
        });
      } else {
        detail.push(
          `sentinel ${sentinelId} could not be deleted; final cleanup will retry`,
        );
      }
    } catch (error) {
      detail.push(
        `sentinel delete failed: ${sanitizeError(error, ctx.redact).message}`,
      );
    }
  }
  return {
    id: phase.id,
    title: phase.title,
    status,
    durationMs: Date.now() - start,
    detail,
    crash,
    findings,
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function gitInfo() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const dirty =
      execFileSync("git", ["status", "--porcelain"], {
        cwd: REPO_ROOT,
        encoding: "utf8",
      }).trim().length > 0;
    return { commit, dirty };
  } catch {
    return { commit: "unknown", dirty: true };
  }
}

function packageVersion(name: string): string {
  try {
    return JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "node_modules", name, "package.json"),
        "utf8",
      ),
    ).version;
  } catch {
    return "unknown";
  }
}

function peakResources(records: JournalRecord[]) {
  const projects = new Set<string>();
  const branches = new Set<string>();
  let peakProjects = 0;
  let peakBranches = 0;
  for (const record of records) {
    if (record.type === "project-created" || record.type === "project-adopted")
      projects.add(record.projectId);
    if (record.type === "branch-created") branches.add(record.branchId);
    if (record.type === "deleted") {
      if (record.kind === "project") projects.delete(record.projectId);
      else if (record.branchId) branches.delete(record.branchId);
    }
    peakProjects = Math.max(peakProjects, projects.size);
    peakBranches = Math.max(peakBranches, branches.size);
  }
  return { peakProjects, peakCreatedBranches: peakBranches };
}

function scenarioSummary(samples: MetricSample[]) {
  const out: Record<
    string,
    {
      completed: number;
      failed: number;
      cancelled: number;
      skipped: number;
      p50Ms?: number;
      maxMs?: number;
    }
  > = {};
  const durations = new Map<string, number[]>();
  for (const sample of samples) {
    if (sample.kind !== "scenario") continue;
    const entry = (out[sample.scenario] ??= {
      completed: 0,
      failed: 0,
      cancelled: 0,
      skipped: 0,
    });
    entry[sample.outcome] += 1;
    const list = durations.get(sample.scenario) ?? [];
    list.push(sample.ms);
    durations.set(sample.scenario, list);
  }
  for (const [name, list] of durations) {
    const sorted = [...list].sort((a, b) => a - b);
    out[name].p50Ms = sorted[Math.ceil(sorted.length / 2) - 1];
    out[name].maxMs = sorted[sorted.length - 1];
  }
  return out;
}

function teardownSummary(records: JournalRecord[]) {
  const createdBy = new Map<string, string>();
  for (const r of records)
    if (r.type === "project-created") createdBy.set(r.projectId, r.actor);
  const deletedBy: Record<string, number> = {};
  for (const r of records) {
    if (r.type === "deleted" && r.kind === "project" && r.verified) {
      deletedBy[r.actor] = (deletedBy[r.actor] ?? 0) + 1;
    }
  }
  return {
    projectsCreated: createdBy.size,
    verifiedDeletionsByActor: deletedBy,
  };
}

function renderMarkdown(report: Record<string, any>): string {
  const lines: string[] = [];
  lines.push(`# Live Neon campaign ${report.campaignId}`, "");
  lines.push(
    `Verdict: **${report.verdict.toUpperCase()}** — ${report.verdictReasons.join("; ") || "all scheduled phases passed and cleanup was verified"}`,
    "",
  );
  lines.push(
    `Profile ${report.profile}, seed ${report.seed}, commit ${report.git.commit}${report.git.dirty ? " (dirty tree)" : ""}, key mode ${report.keyMode}, region ${report.region ?? "unrecorded"}.`,
    "",
  );
  lines.push(`Rerun: \`${report.rerun}\``, "");
  lines.push(
    "Results with injected faults are **live Neon with injected transport faults**; the rest are unmodified live Neon.",
    "",
  );
  lines.push(
    "## Phases",
    "",
    "| Phase | Status | Duration | Detail |",
    "| --- | --- | --- | --- |",
  );
  for (const phase of report.phases as PhaseResult[]) {
    lines.push(
      `| ${phase.id} | ${phase.status} | ${Math.round(phase.durationMs / 1000)}s | ${phase.detail.join("; ").replace(/\|/g, "\\|")} |`,
    );
  }
  lines.push(
    "",
    "## Coverage",
    "",
    "| Priority | Area | Tests | Phase results | Notes |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const row of report.coverage as Array<Record<string, any>>) {
    lines.push(
      `| ${row.priority} | ${row.area} | ${row.status} | ${row.phaseResults || "—"} | ${row.notes} |`,
    );
  }
  lines.push("", "## Findings", "");
  if ((report.findings as Finding[]).length === 0) lines.push("None.");
  for (const finding of report.findings as Finding[]) {
    lines.push(
      `- **${finding.classification}** — ${finding.title}`,
      "",
      "  ```",
      ...finding.evidence.split("\n").map((l) => `  ${l}`),
      "  ```",
    );
  }
  lines.push("", "## Cleanup", "");
  lines.push(`Test/product teardown: ${JSON.stringify(report.teardown)}`);
  const cleanup = report.cleanup as CleanupReport | undefined;
  if (cleanup) {
    lines.push(
      `Supervisor deleted: ${cleanup.supervisorDeleted.length} (${cleanup.supervisorDeleted.map((d) => `${d.kind} ${d.projectId}${d.branchId ? `/${d.branchId}` : ""} by ${d.createdBy}`).join(", ") || "none"})`,
    );
    lines.push(
      `Reconciled: ${cleanup.reconciled.length}; unresolved: ${cleanup.unresolved.length}; remaining campaign projects: ${cleanup.remainingCampaignProjects.length}; inventory complete: ${cleanup.inventoryComplete}`,
    );
  }
  lines.push(
    "",
    "## Request metrics",
    "",
    "| Transport / op | n | p50 | p95 | max | statuses | injected |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  );
  for (const [op, s] of Object.entries(
    report.requests as Record<string, any>,
  )) {
    lines.push(
      `| ${op} | ${s.count} | ${s.p50 ?? "—"} | ${s.p95 ?? "—"} | ${s.max ?? "—"} | ${JSON.stringify(s.statuses)} | ${s.injected} |`,
    );
  }
  lines.push(
    "",
    "p99 is exploratory below 100 samples. Latencies in ms, excluding local rate-limit queueing.",
  );
  lines.push(
    "",
    "## Scenarios",
    "",
    "| Scenario | completed | failed | cancelled | p50 ms | max ms |",
    "| --- | --- | --- | --- | --- | --- |",
  );
  for (const [name, s] of Object.entries(
    report.scenarios as Record<string, any>,
  )) {
    lines.push(
      `| ${name} | ${s.completed} | ${s.failed} | ${s.cancelled} | ${s.p50Ms ?? "—"} | ${s.maxMs ?? "—"} |`,
    );
  }
  lines.push(
    "",
    "## Not covered",
    "",
    "- OAuth login, callback, token refresh and credential storage (live runs inject an API key).",
    "- Packaged Electron journeys (plan section 6).",
    "",
  );
  lines.push(
    "After independently confirming the final inventory, revoke the API key used for this campaign.",
  );
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandRun(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      profile: { type: "string", default: "smoke" },
      phase: { type: "string", multiple: true },
      seed: { type: "string" },
    },
  });
  const profile = values.profile ?? "smoke";
  if (!isProfile(profile)) fail(`unknown profile ${profile}`);
  const env = readEnv();
  const redact = createRedactor([env.apiKey]);
  const now = new Date();
  const campaignId = `${now.toISOString().slice(0, 16).replace(/[-:]/g, "").toLowerCase()}-${randomBytes(2).toString("hex")}`;
  const namePrefix = campaignNamePrefix(campaignId);
  const seed =
    values.seed !== undefined ? Number(values.seed) : now.getTime() % 100_000;
  if (!Number.isInteger(seed)) fail("--seed must be an integer");
  let phases = phasesFor(profile);
  if (values.phase?.length) {
    const unknown = values.phase.filter(
      (id) => !PHASES.some((p) => p.id === id),
    );
    if (unknown.length) fail(`unknown phase(s): ${unknown.join(", ")}`);
    phases = PHASES.filter((p) => values.phase!.includes(p.id));
  }

  const runDir = path.join(RUNS_DIR, campaignId);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const journal = CampaignJournal.create(
    path.join(runDir, "journal.jsonl"),
    "supervisor",
  );
  const client = supervisorClient(
    env,
    journal,
    namePrefix,
    PROFILE_WORKLOAD[profile].maxProjectsPerCampaign,
  );
  log(
    redact,
    `campaign ${campaignId} (${profile}, seed ${seed}) → ${path.relative(REPO_ROOT, runDir)}`,
  );

  const pre = await preflight(env, client);
  for (const note of pre.notes) log(redact, note);
  journal.append({
    type: "campaign-start",
    campaignId,
    profile,
    namePrefix,
    keyMode: pre.keyMode,
    orgId: env.orgId,
    projectScopeId: env.projectId,
    region: env.region,
    baselineProjectIds: pre.baselineProjectIds,
    baselineComplete: pre.baselineComplete,
  });

  const workloadStart = Date.now();
  const ctx: CampaignContext = {
    env,
    profile,
    seed,
    campaignId,
    namePrefix,
    runDir,
    journal,
    client,
    redact,
    workloadDeadline: workloadStart + PROFILE_WORKLOAD[profile].deadlineMs,
  };
  const results: PhaseResult[] = [];
  if (pre.problems.length > 0) {
    for (const problem of pre.problems) log(redact, `preflight: ${problem}`);
    results.push({
      id: "preflight",
      title: "Preflight",
      status: "failed",
      durationMs: Date.now() - workloadStart,
      detail: pre.problems,
      findings: [],
    });
  }

  let stopReason: string | undefined =
    pre.problems.length > 0 ? "preflight failed" : undefined;
  for (const phase of phases) {
    if (stopReason) {
      results.push({
        id: phase.id,
        title: phase.title,
        status: "not-run",
        durationMs: 0,
        detail: [stopReason],
        findings: [],
      });
      continue;
    }
    if (!phase.repeatUntilDeadline && Date.now() >= ctx.workloadDeadline) {
      stopReason = "workload deadline reached";
      results.push({
        id: phase.id,
        title: phase.title,
        status: "not-run",
        durationMs: 0,
        detail: [stopReason],
        findings: [],
      });
      continue;
    }
    log(redact, `phase ${phase.id}: ${phase.title}`);
    journal.append({ type: "phase", phase: phase.id, status: "started" });
    const result =
      phase.kind === "crash"
        ? await runCrashPhase(ctx, phase)
        : await runVitestPhase(ctx, phase);
    results.push(result);
    journal.append({
      type: "phase",
      phase: phase.id,
      status:
        result.status === "passed"
          ? "passed"
          : result.status === "timed-out"
            ? "timed-out"
            : "failed",
      detail: result.detail.join("; ").slice(0, 500),
    });
    log(
      redact,
      `phase ${phase.id}: ${result.status} (${result.detail.join("; ")})`,
    );
    if (result.status !== "passed")
      stopReason = `stopped escalation after ${phase.id} ${result.status}`;
  }

  // Fence new work, then verify cleanup of everything the campaign owns.
  fs.writeFileSync(path.join(runDir, "FENCE"), `${new Date().toISOString()}\n`);
  journal.append({ type: "fence", reason: "workload finished" });
  log(redact, "cleanup: fenced; deleting and verifying campaign resources");
  const cleanup = await cleanupCampaign({
    journal,
    client,
    timeoutMs: CAMPAIGN_LIMITS.cleanupWindowMs,
    log: (m) => log(redact, `cleanup: ${m}`),
  });
  fs.writeFileSync(
    path.join(runDir, "cleanup.json"),
    redact(JSON.stringify(cleanup, null, 2)),
  );

  const records = journal.read();
  const samples = readMetrics(runDir);
  const findings = results.flatMap((r) => r.findings);
  for (const leak of cleanup.supervisorDeleted) {
    findings.push({
      classification:
        leak.createdBy === "product" ? "dyad-defect" : "harness-defect",
      title: `Supervisor had to delete ${leak.kind} ${leak.projectId}${leak.branchId ? `/${leak.branchId}` : ""}`,
      evidence: `Created by ${leak.createdBy}; test/product teardown did not remove it (crash probes excepted, see their phase).`,
    });
  }
  for (const duplicate of cleanup.duplicateCreates) {
    findings.push({
      classification: "needs-triage",
      title: `Duplicate project creation for one intent (${duplicate.name})`,
      evidence: duplicate.projectIds.join(", "),
    });
  }
  const scan = scanForSecrets(runDir, [env.apiKey]);
  for (const hit of scan.findings) {
    findings.push({
      classification: "harness-defect",
      title: "Credential found in a retained artifact",
      evidence: `${hit.file}:${hit.line} (${hit.detector})`,
    });
  }

  const statusByPhase = new Map(results.map((r) => [r.id, r.status]));
  const coverage = COVERAGE.map((row) => ({
    ...row,
    phaseResults: row.phases
      .map((id) => `${id}: ${statusByPhase.get(id) ?? "not scheduled"}`)
      .join(", "),
  }));
  const verdictReasons: string[] = [];
  if (results.some((r) => r.status !== "passed"))
    verdictReasons.push("not every scheduled phase passed");
  if (!cleanupIsClean(cleanup))
    verdictReasons.push("cleanup could not verify every resource gone");
  if (findings.some((f) => f.classification === "dyad-defect"))
    verdictReasons.push("Dyad defects found");
  if (scan.findings.length > 0)
    verdictReasons.push("credentials found in artifacts");
  if (
    profile !== "smoke" &&
    COVERAGE.some((c) => c.priority === "P0" && c.status !== "implemented")
  ) {
    verdictReasons.push("some P0 areas are only partially covered");
  }
  const verdict =
    verdictReasons.length === 0
      ? "pass"
      : results.some(
            (r) => r.status === "failed" || r.status === "timed-out",
          ) || findings.length > 0
        ? "fail"
        : "incomplete";
  const report = {
    campaignId,
    profile,
    seed,
    keyMode: pre.keyMode,
    orgId: env.orgId,
    projectScopeId: env.projectId,
    region: env.region,
    quotas: pre.quotas,
    limits: CAMPAIGN_LIMITS,
    workload: PROFILE_WORKLOAD[profile],
    git: gitInfo(),
    versions: {
      node: process.version,
      "@neondatabase/api-client": packageVersion("@neondatabase/api-client"),
      "@neondatabase/serverless": packageVersion("@neondatabase/serverless"),
      vitest: packageVersion("vitest"),
    },
    rerun: `npm run test:neon:live -- --profile ${profile} --seed ${seed}${values.phase?.length ? values.phase.map((p) => ` --phase ${p}`).join("") : ""}`,
    cleanupCommand: `npm run test:neon:live:cleanup -- --journal ${path.relative(REPO_ROOT, journal.path)}`,
    verdict,
    verdictReasons,
    phases: results,
    coverage,
    findings,
    teardown: teardownSummary(records),
    peaks: peakResources(records),
    requests: summarizeRequests(samples),
    scenarios: scenarioSummary(samples),
    cleanup,
    unscannableArtifacts: scan.unscannable,
    startedAt: now.toISOString(),
    finishedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(runDir, "report.json"),
    redact(JSON.stringify(report, null, 2)),
  );
  fs.writeFileSync(
    path.join(runDir, "report.md"),
    redact(renderMarkdown(report)),
  );
  log(
    redact,
    `verdict: ${verdict}${verdictReasons.length ? ` (${verdictReasons.join("; ")})` : ""}`,
  );
  log(
    redact,
    `report: ${path.relative(REPO_ROOT, path.join(runDir, "report.md"))}`,
  );
  if (!cleanupIsClean(cleanup)) {
    log(
      redact,
      `cleanup incomplete — rerun later with: ${report.cleanupCommand}`,
    );
  }
  process.exit(verdict === "pass" ? 0 : 1);
}

async function commandCleanup(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      journal: { type: "string" },
      json: { type: "string" },
      "timeout-min": { type: "string" },
    },
  });
  if (!values.journal) fail("--journal <path> is required");
  const journalPath = path.resolve(values.journal);
  if (!fs.existsSync(journalPath))
    fail(`journal ${journalPath} does not exist`);
  const env = readEnv();
  const redact = createRedactor([env.apiKey]);
  const journal = new CampaignJournal(journalPath, "cleanup-command");
  const start = journal.state().start;
  if (!start) {
    log(
      redact,
      "journal has no campaign-start record: only journaled IDs will be deleted, no name reconciliation",
    );
  }
  const client = supervisorClient(
    env,
    journal,
    start?.namePrefix ?? "dyad-live-unknown",
  );
  // Fence: no new creates against this journal from here on.
  fs.writeFileSync(
    path.join(path.dirname(journalPath), "FENCE"),
    `${new Date().toISOString()}\n`,
  );
  journal.append({ type: "fence", reason: "cleanup-only command" });
  const report = await cleanupCampaign({
    journal,
    client,
    timeoutMs: Number(values["timeout-min"] ?? 15) * 60_000,
    log: (m) => log(redact, m),
  });
  const json = redact(JSON.stringify(report, null, 2));
  if (values.json) fs.writeFileSync(path.resolve(values.json), json);
  process.stdout.write(`${json}\n`);
  process.exit(cleanupIsClean(report) ? 0 : 1);
}

async function commandPreflight() {
  const env = readEnv();
  const redact = createRedactor([env.apiKey]);
  const scratch = path.join(RUNS_DIR, "preflight");
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const journal = new CampaignJournal(
    path.join(scratch, `journal-${Date.now()}.jsonl`),
    "preflight",
  );
  fs.writeFileSync(journal.path, "", { mode: 0o600 });
  const result = await preflight(
    env,
    supervisorClient(env, journal, "dyad-live-preflight"),
  );
  process.stdout.write(
    `${redact(JSON.stringify({ ...result, baselineProjectIds: result.baselineProjectIds.length }, null, 2))}\n`,
  );
  process.exit(result.problems.length ? 1 : 0);
}

function commandScan(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { dir: { type: "string" } },
  });
  if (!values.dir) fail("--dir <run directory> is required");
  const result = scanForSecrets(path.resolve(values.dir), [
    process.env[LIVE_ENV.apiKey],
  ]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.findings.length ? 1 : 0);
}

async function main() {
  const [command = "run", ...rest] = process.argv.slice(2);
  if (!fs.existsSync(path.join(REPO_ROOT, "src/testing/live_neon/cli.ts"))) {
    fail("run from the repository root (npm run test:neon:live)");
  }
  switch (command) {
    case "run":
      return commandRun(rest);
    case "cleanup":
      return commandCleanup(rest);
    case "preflight":
      return commandPreflight();
    case "scan":
      return commandScan(rest);
    default:
      fail(
        `unknown command ${command}; expected run, cleanup, preflight or scan`,
      );
  }
}

main().catch((error) => {
  const redact = createRedactor([process.env[LIVE_ENV.apiKey]]);
  process.stderr.write(
    `${redact(`[neon-live] fatal: ${(error as Error)?.stack ?? String(error)}`)}\n`,
  );
  process.exit(3);
});
