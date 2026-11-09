// Shared setup for live Neon suites: the hybrid harness (isolated SQLite,
// app dirs, settings, Git, runtime state) wired to real Neon through
// journaled clients, budgets, transport faults and metrics.
//
// Every suite must:
//   1. gate itself:      describe.runIf(liveNeonGate().enabled)(...)
//   2. route Dyad's client:
//        vi.mock("@/neon_admin/neon_management_client", async (importOriginal) =>
//          (await import("@/testing/live_neon/product_client")).mockNeonManagementClient(
//            await importOriginal(),
//          ),
//        );
//   3. call setupLiveNeonHarness() in beforeAll and dispose() in afterAll.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { Api } from "@neondatabase/api-client";
import { neon } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";

import { apps, chats } from "@/db/schema";
import { IS_TEST_BUILD } from "@/ipc/utils/test_utils";
import { retryOnLocked } from "@/ipc/utils/retryOnLocked";
import {
  parseEnvFile,
  readEnvFileIfExists,
} from "@/ipc/utils/app_env_var_utils";
import {
  setupHybridChatHarness,
  type HybridChatHarness,
  type HybridChatHarnessOptions,
} from "@/testing/hybrid_chat_harness";
import { h } from "@/testing/hybrid.setup";

import { Semaphore, TokenBucket } from "./budget";
import {
  CAMPAIGN_LIMITS,
  PROFILE_WORKLOAD,
  liveNeonGate,
  remainingMs,
  type LiveNeonConfig,
} from "./config";
import { FaultController } from "./faults";
import { installLiveFetch } from "./fetch_transport";
import { CampaignJournal } from "./journal";
import { CampaignGuardError, createJournaledNeonClient } from "./live_client";
import { MetricsRecorder } from "./metrics";
import { deleteProjectVerified, waitForOperations } from "./neon_ops";
import { setProductNeonClient } from "./product_client";
import { createRedactor, sanitizeError, type Redactor } from "./redact";
import { NeonVerifier, assertRealNeonIds } from "./verifier";

type AppRow = typeof apps.$inferSelect;

export interface FixtureProject {
  projectId: string;
  name: string;
  mainBranchId: string;
  developmentBranchId?: string;
  previewBranchId?: string;
}

export interface LiveNeonHarness {
  config: LiveNeonConfig;
  harness: HybridChatHarness;
  journal: CampaignJournal;
  /** What Dyad's getNeonClient() returns. Fault rules apply here only. */
  productClient: Api<unknown>;
  /** Test setup (fixture retries allowed; never fault-injected). */
  fixtureClient: Api<unknown>;
  verifier: NeonVerifier;
  faults: FaultController;
  metrics: MetricsRecorder;
  redact: Redactor;
  managementBudget: TokenBucket;
  appsRoot: string;
  /** Unique campaign-prefixed name; `label` is for humans. */
  projectName: (label: string) => string;
  /** Unique per-run marker string for this suite. */
  marker: (label: string) => string;
  createGitApp: (
    label: string,
    options?: { framework?: "nextjs" | "vite" },
  ) => Promise<{ appId: number; appDir: string; chatId: number }>;
  commit: (appDir: string, label: string) => string;
  appRow: (appId: number) => Promise<AppRow>;
  appEnv: (appDir: string) => Promise<Record<string, string>>;
  createFixtureProject: (
    label: string,
    options?: { development?: boolean; preview?: boolean; auth?: boolean },
  ) => Promise<FixtureProject>;
  /** Creates/updates `dyad_live_marker` on a branch with a distinguishable row. */
  seedMarker: (
    projectId: string,
    branchId: string,
    label: string,
  ) => Promise<void>;
  readMarkers: (projectId: string, branchId: string) => Promise<string[]>;
  /** Fixture-side retry for setup steps that hit 423/429; never wrap Dyad actions in it. */
  setup: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Records a scenario outcome in metrics; rethrows failures unchanged. */
  scenario: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** Throws once the campaign workload deadline has passed. */
  assertBudget: (needMs?: number) => void;
  /** Deletes (and verifies) every project this worker's tests created. */
  deleteOwnedProjects: () => Promise<void>;
  dispose: () => Promise<void>;
}

export function requireLiveConfig(): LiveNeonConfig {
  const gate = liveNeonGate();
  if (!gate.enabled) {
    throw new Error(
      `setupLiveNeonHarness called while live runs are disabled: ${gate.reason}`,
    );
  }
  return gate.config;
}

export async function setupLiveNeonHarness({
  suite,
  hybrid,
}: {
  suite: string;
  hybrid?: Partial<Omit<HybridChatHarnessOptions, "electronMock">>;
}): Promise<LiveNeonHarness> {
  const config = requireLiveConfig();
  if (IS_TEST_BUILD) {
    throw new Error(
      "E2E_TEST_BUILD=true selects fake Neon clients and disables real cleanup; live suites must run without it",
    );
  }
  const journal = new CampaignJournal(
    config.journalPath,
    `${config.phase}:${suite}:${process.pid}`,
  );
  const redact = createRedactor([config.apiKey]);
  const metrics = new MetricsRecorder(
    config.runDir,
    `${config.phase}-${suite}`,
    redact,
  );
  const managementBudget = new TokenBucket(
    "management",
    CAMPAIGN_LIMITS.managementRequestsPerSecond,
    CAMPAIGN_LIMITS.managementBurst,
  );
  const authBucket = new TokenBucket(
    "auth",
    CAMPAIGN_LIMITS.authRequestsPerSecond,
    1,
  );
  const sqlLimiter = new Semaphore("sql", CAMPAIGN_LIMITS.maxConcurrentSql);
  const faults = new FaultController();
  const fencePath = path.join(config.runDir, "FENCE");
  const makeClient = (actor: "product" | "fixture" | "verifier") =>
    createJournaledNeonClient({
      config,
      journal,
      actor,
      budget: managementBudget,
      metrics,
      faults: actor === "product" ? faults : undefined,
      fencePath,
      maxProjectsPerCampaign:
        PROFILE_WORKLOAD[config.profile].maxProjectsPerCampaign,
    });
  const productClient = makeClient("product");
  const fixtureClient = makeClient("fixture");
  const verifier = new NeonVerifier(makeClient("verifier"));
  setProductNeonClient({
    client: () => productClient,
    orgId: () => {
      if (!config.orgId) {
        throw new CampaignGuardError(
          "organization lookup is unavailable with a project-scoped key",
        );
      }
      return config.orgId;
    },
  });

  const harness = await setupHybridChatHarness({
    electronMock: h,
    ...hybrid,
    settings: { isTestMode: true, ...hybrid?.settings },
  });
  const uninstallFetch = installLiveFetch({
    sqlLimiter,
    authBucket,
    metrics,
    faults,
  });
  journal.append({
    type: "worker",
    event: "start",
    phase: config.phase,
    userDataDir: harness.userDataDir,
  });

  const appsRoot = path.dirname(harness.appDir);
  const suiteToken = randomBytes(3).toString("hex");
  let appCounter = 0;
  let disposed = false;

  const projectName = (label: string) => {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 32);
    return `${config.namePrefix}-${slug}-${randomBytes(3).toString("hex")}`;
  };

  const commit = (appDir: string, label: string): string => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: appDir, encoding: "utf8" }).trim();
    if (!fs.existsSync(path.join(appDir, ".git"))) {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "live-neon@example.com");
      git("config", "user.name", "Live Neon");
    }
    fs.writeFileSync(path.join(appDir, "version.txt"), `${label}\n`);
    git("add", "-A");
    git("commit", "-q", "-m", label);
    return git("rev-parse", "HEAD");
  };

  const createGitApp: LiveNeonHarness["createGitApp"] = async (
    label,
    { framework = "nextjs" } = {},
  ) => {
    appCounter += 1;
    const name = `live-${label}-${suiteToken}-${appCounter}`;
    const appDir = path.join(appsRoot, name);
    fs.mkdirSync(appDir, { recursive: true });
    if (framework === "nextjs") {
      fs.writeFileSync(
        path.join(appDir, "package.json"),
        JSON.stringify({
          name,
          private: true,
          scripts: { dev: "next dev" },
          dependencies: { next: "^15.0.0", react: "^19.0.0" },
        }),
      );
      fs.writeFileSync(
        path.join(appDir, "next.config.ts"),
        "export default {};\n",
      );
    } else {
      fs.writeFileSync(
        path.join(appDir, "package.json"),
        JSON.stringify({
          name,
          private: true,
          type: "module",
          scripts: { dev: "vite" },
          dependencies: { react: "^19.0.0" },
          devDependencies: { vite: "^6.0.0" },
        }),
      );
      fs.writeFileSync(
        path.join(appDir, "vite.config.ts"),
        "export default {};\n",
      );
    }
    fs.writeFileSync(path.join(appDir, ".gitignore"), ".env*\n");
    commit(appDir, "initial");
    const [row] = await harness.db
      .insert(apps)
      .values({ name, path: appDir })
      .returning();
    const [chat] = await harness.db
      .insert(chats)
      .values({ appId: row.id })
      .returning();
    return { appId: row.id, appDir, chatId: chat.id };
  };

  const appRow = async (appId: number) => {
    const row = await harness.db.query.apps.findFirst({
      where: eq(apps.id, appId),
    });
    if (!row) throw new Error(`app ${appId} missing`);
    return row;
  };

  const appEnv = async (appDir: string) => {
    const content = (await readEnvFileIfExists({ appPath: appDir })) ?? "";
    return Object.fromEntries(
      parseEnvFile(content).map((v) => [v.key, v.value]),
    );
  };

  const setup = <T>(operation: () => Promise<T>) =>
    retryOnLocked(operation, "live fixture setup");

  const createFixtureProject: LiveNeonHarness["createFixtureProject"] = async (
    label,
    { development = true, preview = false, auth = false } = {},
  ) => {
    const name = projectName(label);
    const { data } = await fixtureClient.createProject({
      project: { name, ...(config.orgId ? { org_id: config.orgId } : {}) },
    });
    const projectId = data.project.id;
    const mainBranchId = data.branch.id;
    await waitForOperations(fixtureClient, projectId);
    if (auth) {
      await setup(() =>
        fixtureClient.createNeonAuth(projectId, mainBranchId, {
          auth_provider: "better_auth" as never,
        }),
      );
      await waitForOperations(fixtureClient, projectId);
    }
    let developmentBranchId: string | undefined;
    if (development) {
      // How a user typically makes one in the console: a child of main.
      const { data: dev } = await setup(() =>
        fixtureClient.createProjectBranch(projectId, {
          endpoints: [{ type: "read_write" as never }],
          branch: { name: "development", parent_id: mainBranchId },
        }),
      );
      developmentBranchId = dev.branch.id;
      await waitForOperations(fixtureClient, projectId);
    }
    let previewBranchId: string | undefined;
    if (preview) {
      const { data: prev } = await setup(() =>
        fixtureClient.createProjectBranch(projectId, {
          endpoints: [{ type: "read_write" as never }],
          branch: {
            name: "preview",
            parent_id: developmentBranchId ?? mainBranchId,
          },
        }),
      );
      previewBranchId = prev.branch.id;
      await waitForOperations(fixtureClient, projectId);
    }
    assertRealNeonIds({
      projectId,
      branchIds: [mainBranchId, developmentBranchId, previewBranchId].filter(
        Boolean,
      ),
    });
    return {
      projectId,
      name,
      mainBranchId,
      developmentBranchId,
      previewBranchId,
    };
  };

  const seedMarker: LiveNeonHarness["seedMarker"] = async (
    projectId,
    branchId,
    label,
  ) => {
    const sql = neon(await verifier.connectionUri(projectId, branchId));
    await sql.query(
      `create table if not exists dyad_live_marker (label text primary key, written_at timestamptz not null default now())`,
    );
    await sql.query(
      `insert into dyad_live_marker(label) values ($1) on conflict do nothing`,
      [label],
    );
  };

  const readMarkers: LiveNeonHarness["readMarkers"] = async (
    projectId,
    branchId,
  ) => {
    const sql = neon(await verifier.connectionUri(projectId, branchId));
    const [{ exists }] = (await sql.query(
      `select to_regclass('public.dyad_live_marker') is not null as exists`,
    )) as Array<{ exists: boolean }>;
    if (!exists) return [];
    return (
      (await sql.query(
        `select label from dyad_live_marker order by label`,
      )) as Array<{ label: string }>
    ).map((r) => r.label);
  };

  const scenario = async <T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T> => {
    const start = Date.now();
    const previous = metrics.scenario;
    metrics.scenario = name;
    try {
      const result = await fn();
      metrics.scenarioOutcome({
        scenario: name,
        outcome: "completed",
        ms: Date.now() - start,
      });
      return result;
    } catch (error) {
      metrics.scenarioOutcome({
        scenario: name,
        outcome:
          (error as { name?: string })?.name === "AbortError"
            ? "cancelled"
            : "failed",
        ms: Date.now() - start,
        error: sanitizeError(error, redact),
      });
      throw error;
    } finally {
      metrics.scenario = previous;
    }
  };

  const assertBudget = (needMs = 0) => {
    const left = remainingMs(config);
    if (left < needMs) {
      throw new Error(
        `Campaign workload budget exhausted (${Math.round(left / 1000)}s left, needed ${Math.round(needMs / 1000)}s); scenario not admitted`,
      );
    }
  };

  /** Projects created by this process that are still live. */
  const ownedHere = () => {
    const records = journal.read();
    const createdHere = new Set(
      records
        .filter((r) => r.type === "project-created" && r.pid === process.pid)
        .map((r) => (r as { projectId: string }).projectId),
    );
    const state = journal.state();
    return [...state.projects.values()].filter(
      (p) => createdHere.has(p.projectId) && !p.verified,
    );
  };

  const deleteOwnedProjects = async () => {
    const failed: string[] = [];
    for (const project of ownedHere()) {
      let deleted = false;
      for (let attempt = 0; attempt < 5 && !deleted; attempt++) {
        try {
          const result = await deleteProjectVerified(
            verifier.client,
            project.projectId,
          );
          if (result.deleted) {
            journal.append({
              type: "deleted",
              kind: "project",
              projectId: project.projectId,
              actor: "verifier",
              verified: true,
            });
            deleted = true;
          }
        } catch (error) {
          metrics.event("teardown-delete-failed", {
            projectId: project.projectId,
            error: sanitizeError(error, redact),
          });
          await new Promise((resolve) => setTimeout(resolve, 5_000));
        }
      }
      if (!deleted) failed.push(project.projectId);
    }
    if (failed.length > 0) {
      throw new Error(
        `Test teardown left Neon projects behind (the supervisor will retry): ${failed.join(", ")}`,
      );
    }
  };

  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    faults.clear();
    let teardownError: unknown;
    try {
      await deleteOwnedProjects();
    } catch (error) {
      teardownError = error;
    }
    uninstallFetch();
    try {
      await harness.dispose();
    } finally {
      setProductNeonClient(undefined);
      journal.append({ type: "worker", event: "exit", phase: config.phase });
    }
    if (teardownError) throw teardownError;
  };

  return {
    config,
    harness,
    journal,
    productClient,
    fixtureClient,
    verifier,
    faults,
    metrics,
    redact,
    managementBudget,
    appsRoot,
    projectName,
    marker: (label) => `${config.campaignId}:${suiteToken}:${label}`,
    createGitApp,
    commit,
    appRow,
    appEnv,
    createFixtureProject,
    seedMarker,
    readMarkers,
    setup,
    scenario,
    assertBudget,
    deleteOwnedProjects,
    dispose,
  };
}

/** Hostname a connection string points at, without the pooler suffix. */
export function databaseHost(
  connectionString: string | undefined,
): string | undefined {
  if (!connectionString) return undefined;
  try {
    return new URL(connectionString).hostname.replace(/-pooler(?=\.)/, "");
  } catch {
    return undefined;
  }
}
