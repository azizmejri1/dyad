// Seeded exploration of Dyad's Neon integration against live Neon.
//
// One Dyad-created project is shared by two apps (A creates it, B links it).
// Each seed draws a sequence of legal actions from a deterministic PRNG and
// runs them through Dyad's real handlers: switching the active branch, SQL
// through the execute_sql tool, version snapshots and database reverts, Tests-
// panel branch leases (released or cancelled), and unlink/relink. An
// independent model predicts where every marker row lives and what each app
// should point at; after every settled action the suite reads Neon and the
// local state directly and compares. A failing seed writes a sanitized trace
// to <runDir>/explore-traces/seed-<seed>.json and tries a cheap minimization.
//
// Seed n of a run is `DYAD_LIVE_NEON_SEED + n`. Every seed starts from the same
// canonical state (both apps linked, development active, no restorable
// snapshots), so its action list depends only on its seed value. Run a single
// seed with DYAD_LIVE_NEON_EXPLORE_SEED=<value> (passed through by the
// supervisor):
//
//   DYAD_LIVE_NEON_EXPLORE_SEED=<value> npm run test:neon:live -- --phase explore
//
// Runs only under the campaign supervisor (npm run test:neon:live).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { neon } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, it, vi } from "vitest";

import { PROFILE_WORKLOAD, liveNeonGate } from "@/testing/live_neon/config";

vi.mock("@/neon_admin/neon_management_client", async (importOriginal) =>
  (await import("@/testing/live_neon/product_client")).mockNeonManagementClient(
    await importOriginal<
      typeof import("@/neon_admin/neon_management_client")
    >(),
  ),
);

import { testBranchCleanup } from "@/db/schema";
import { ipc } from "@/ipc/types";
import {
  settleNeonBackupCleanups,
  versionPreviewHandlerService,
} from "@/ipc/handlers/version_handlers";
import { acquireNeonTestBranch } from "@/ipc/services/neon_test_branch_lease";
import { trackedRunTestBranchId } from "@/ipc/utils/neon_test_branch";
import { storeDbTimestampAtCurrentVersion } from "@/ipc/utils/neon_timestamp_utils";
import { writeSettings } from "@/main/settings";
import { executeSqlTool } from "@/pro/main/ipc/handlers/local_agent/tools/execute_sql";
import type { AgentContext } from "@/pro/main/ipc/handlers/local_agent/tools/types";
import {
  databaseHost,
  setupLiveNeonHarness,
  type LiveNeonHarness,
} from "@/testing/live_neon/live_harness";
import { listBranches } from "@/testing/live_neon/neon_ops";
import { PHASES } from "@/testing/live_neon/phases";
import { sanitizeError } from "@/testing/live_neon/redact";
import { assertRealNeonIds } from "@/testing/live_neon/verifier";

const gate = liveNeonGate();
const canCreateProjects =
  gate.enabled && gate.config.keyMode === "organization";
const workload = gate.enabled
  ? PROFILE_WORKLOAD[gate.config.profile]
  : undefined;

/** Optional single-seed rerun; not part of LIVE_ENV because only this suite reads it. */
const SINGLE_SEED_ENV = "DYAD_LIVE_NEON_EXPLORE_SEED";
const singleSeed = process.env[SINGLE_SEED_ENV]?.trim();
if (
  gate.enabled &&
  singleSeed !== undefined &&
  !Number.isInteger(Number(singleSeed))
) {
  throw new Error(`${SINGLE_SEED_ENV} must be an integer`);
}
const seedValues: number[] = !gate.enabled
  ? []
  : singleSeed !== undefined
    ? [Number(singleSeed)]
    : Array.from(
        { length: workload!.explorationSeeds },
        (_, n) => gate.config.seed + n,
      );
const actionsPerSeed = workload?.actionsPerSeed ?? 0;

/** The phase timeout bounds one run of this file (soak repeats the file). */
const FILE_BUDGET_MS =
  (PHASES.find((p) => p.id === "explore")?.timeoutMs ?? 40 * 60_000) -
  5 * 60_000;
const SEED_TIMEOUT_MS = 60 * 60_000;
/** A Neon timestamp has second resolution; keep writes clear of it (as the revert suite does). */
const TIMESTAMP_SPACING_MS = 3_000;
const RESET_ESTIMATE_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Deterministic PRNG and the action model
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type AppKey = "A" | "B";
type BranchKey = "development" | "main" | "preview";
type ActionKind =
  | "switch"
  | "sql"
  | "sql-rejected"
  | "snapshot"
  | "revert"
  | "lease-release"
  | "lease-cancel"
  | "unlink"
  | "relink";

interface PlannedAction {
  index: number;
  app: AppKey;
  kind: ActionKind;
  target?: "development" | "main";
  /** Ordinal of the snapshot (within this seed) a revert goes back to. */
  snapshotOrdinal?: number;
  cancelAt?: "before-admission" | "during-create";
}

interface ActionRecord extends PlannedAction {
  ms?: number;
  outcome?: "ok" | "failed";
}

interface AppModel {
  appId: number;
  appDir: string;
  linked: boolean;
  active: "development" | "main";
}

interface SnapshotModel {
  ordinal: number;
  commit: string;
  timestamp: string;
  /** Development rows at the snapshot: what a revert to it must restore. */
  developmentMarkers: string[];
}

interface Model {
  apps: Record<AppKey, AppModel>;
  markers: Record<BranchKey, Set<string>>;
  /** Restorable snapshots of app A taken during the current seed. */
  snapshots: SnapshotModel[];
  nextOrdinal: number;
  headA: string;
}

function serializeModel(model: Model) {
  return {
    apps: model.apps,
    markers: Object.fromEntries(
      Object.entries(model.markers).map(([k, v]) => [k, [...v].sort()]),
    ),
    snapshots: model.snapshots,
    headA: model.headA,
  };
}

/** Legal actions with weights, in a fixed order so a seed always draws the same list. */
function chooseAction(
  rng: () => number,
  model: Model,
  index: number,
): PlannedAction {
  const candidates: Array<{
    weight: number;
    action: Omit<PlannedAction, "index">;
  }> = [];
  for (const key of ["A", "B"] as const) {
    const app = model.apps[key];
    if (!app.linked) {
      candidates.push({ weight: 4, action: { app: key, kind: "relink" } });
      candidates.push({
        weight: 1,
        action: { app: key, kind: "sql-rejected" },
      });
      continue;
    }
    candidates.push({
      weight: 3,
      action: {
        app: key,
        kind: "switch",
        target: app.active === "development" ? "main" : "development",
      },
    });
    candidates.push({ weight: 4, action: { app: key, kind: "sql" } });
    candidates.push({ weight: 1, action: { app: key, kind: "lease-release" } });
    candidates.push({ weight: 1, action: { app: key, kind: "lease-cancel" } });
    candidates.push({ weight: 1, action: { app: key, kind: "unlink" } });
    if (key === "A") {
      candidates.push({ weight: 2, action: { app: key, kind: "snapshot" } });
      if (app.active === "development" && revertTargets(model).length > 0) {
        candidates.push({ weight: 2, action: { app: key, kind: "revert" } });
      }
    }
  }
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let roll = rng() * total;
  let chosen = candidates[candidates.length - 1].action;
  for (const candidate of candidates) {
    roll -= candidate.weight;
    if (roll < 0) {
      chosen = candidate.action;
      break;
    }
  }
  const action: PlannedAction = { index, ...chosen };
  if (action.kind === "revert") {
    const targets = revertTargets(model);
    action.snapshotOrdinal =
      targets[Math.floor(rng() * targets.length)].ordinal;
  } else if (action.kind === "lease-cancel") {
    action.cancelAt = rng() < 0.5 ? "before-admission" : "during-create";
  }
  return action;
}

/**
 * A revert to the current HEAD stores "now" as that version's timestamp before
 * restoring (it is a no-op in the UI), so only other snapshots are targets.
 */
function revertTargets(model: Model): SnapshotModel[] {
  return model.snapshots.filter((s) => s.commit !== model.headA);
}

/** Whether a recorded action can run on its own from the canonical state. */
function replayableAlone(action: PlannedAction): boolean {
  // Canonical: both apps linked, development active, no snapshots.
  return !["revert", "relink", "sql-rejected"].includes(action.kind);
}

class InvariantViolation extends Error {
  constructor(
    readonly stage: string,
    readonly violations: string[],
    readonly observed: unknown,
  ) {
    super(`Invariants violated ${stage}:\n- ${violations.join("\n- ")}`);
    this.name = "InvariantViolation";
  }
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function gitHead(appDir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: appDir,
    encoding: "utf8",
  }).trim();
}

/** The subset of the agent context execute_sql reads, built as local_agent_handler does. */
function sqlToolContext(app: {
  neonProjectId: string | null;
  neonActiveBranchId: string | null;
  neonDevelopmentBranchId: string | null;
  path: string;
}): AgentContext {
  return {
    appPath: app.path,
    supabaseProjectId: null,
    supabaseOrganizationSlug: null,
    supabaseProviderToolsAvailable: false,
    neonProjectId: app.neonProjectId,
    neonActiveBranchId: app.neonActiveBranchId ?? app.neonDevelopmentBranchId,
    neonProviderToolsAvailable: true,
  } as unknown as AgentContext;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.runIf(gate.enabled)("Neon seeded exploration (live Neon API)", () => {
  let live: LiveNeonHarness;
  let fileDeadline = 0;
  let projectId = "";
  const ids: Record<BranchKey, string> = {
    development: "",
    main: "",
    preview: "",
  };
  let model: Model;
  /** Set once a seed fails or the budget runs out; later seeds are skipped. */
  let halted: string | undefined;
  let completedSeeds = 0;
  let completedActions = 0;
  let averageActionMs = 20_000;
  let totalActionMs = 0;
  let lastCheckAt = new Date();

  // Verifier-side caches: endpoint hosts, Auth URLs and connection URIs do not
  // change when a branch is restored in place. A mismatch or SQL error
  // refreshes once before anything is reported.
  const uriCache = new Map<string, string>();
  const hostCache = new Map<string, string>();
  const authUrlCache = new Map<string, string>();

  beforeAll(async () => {
    live = await setupLiveNeonHarness({ suite: "explore" });
    fileDeadline = Math.min(live.config.deadline, Date.now() + FILE_BUDGET_MS);
    if (!canCreateProjects || seedValues.length === 0) return;
    // Switching an app to production is part of the action space.
    writeSettings({ enableNeonBranchProtection: false });

    const a = await live.createGitApp("explore-a");
    const b = await live.createGitApp("explore-b");
    const created = await ipc.neon.createProject({
      name: live.projectName("explore"),
      appId: a.appId,
    });
    projectId = created.id;
    const rowA = await live.appRow(a.appId);
    ids.development = rowA.neonDevelopmentBranchId!;
    ids.preview = rowA.neonPreviewBranchId!;
    const tree = await live.verifier.branches(projectId);
    ids.main = tree.find((branch) => branch.default)!.id;
    assertRealNeonIds({ projectId, branchIds: Object.values(ids) });

    // Fixture: the marker table on the two writable branches. Preview never
    // gets one, so any marker read there is a leak.
    for (const branchId of [ids.development, ids.main]) {
      const sql = await branchSql(branchId);
      await sql.query(
        `create table if not exists dyad_live_marker (label text primary key, written_at timestamptz not null default now())`,
      );
    }

    const linked = await ipc.neon.setAppProject({ appId: b.appId, projectId });
    ensure(linked.success, "linking app B to the shared project failed");

    model = {
      apps: {
        A: {
          appId: a.appId,
          appDir: a.appDir,
          linked: true,
          active: "development",
        },
        B: {
          appId: b.appId,
          appDir: b.appDir,
          linked: true,
          active: "development",
        },
      },
      markers: { development: new Set(), main: new Set(), preview: new Set() },
      snapshots: [],
      nextOrdinal: 0,
      headA: gitHead(a.appDir),
    };
    await checkInvariants("after setup");
  }, 600_000);

  afterAll(async () => {
    await settleNeonBackupCleanups().catch(() => {});
    await live?.dispose();
  }, 600_000);

  // -------------------------------------------------------------------------
  // Independent reads
  // -------------------------------------------------------------------------

  async function branchSql(branchId: string) {
    let uri = uriCache.get(branchId);
    if (!uri) {
      uri = await live.verifier.connectionUri(projectId, branchId);
      uriCache.set(branchId, uri);
    }
    return neon(uri);
  }

  async function markersOn(branchId: string): Promise<string[]> {
    for (let attempt = 0; ; attempt++) {
      try {
        const sql = await branchSql(branchId);
        const [{ exists }] = (await sql.query(
          `select to_regclass('public.dyad_live_marker') is not null as exists`,
        )) as Array<{ exists: boolean }>;
        if (!exists) return [];
        const rows = (await sql.query(
          `select label from dyad_live_marker order by label`,
        )) as Array<{ label: string }>;
        return rows.map((r) => r.label);
      } catch (error) {
        if (attempt > 0) throw error;
        uriCache.delete(branchId);
      }
    }
  }

  async function cached(
    cache: Map<string, string>,
    branchId: string,
    load: () => Promise<string>,
    observed: string | undefined,
  ): Promise<string> {
    let value = cache.get(branchId);
    if (value === undefined || (observed !== undefined && observed !== value)) {
      value = await load();
      cache.set(branchId, value);
    }
    return value;
  }

  async function observe() {
    const apps: Record<string, unknown> = {};
    const violations: string[] = [];
    for (const key of ["A", "B"] as const) {
      const expected = model.apps[key];
      const row = await live.appRow(expected.appId);
      const env = await live.appEnv(expected.appDir);
      const dbHost = databaseHost(env.DATABASE_URL);
      const pgHost = databaseHost(env.POSTGRES_URL);
      apps[key] = {
        neonProjectId: row.neonProjectId,
        neonDevelopmentBranchId: row.neonDevelopmentBranchId,
        neonPreviewBranchId: row.neonPreviewBranchId,
        neonActiveBranchId: row.neonActiveBranchId,
        neonTestBranchId: row.neonTestBranchId,
        env: {
          databaseHost: dbHost,
          postgresHost: pgHost,
          neonAuthBaseUrl: env.NEON_AUTH_BASE_URL,
          hasCookieSecret: env.NEON_AUTH_COOKIE_SECRET !== undefined,
        },
      };
      if (expected.linked) {
        const activeId = ids[expected.active];
        if (row.neonProjectId !== projectId)
          violations.push(
            `${key}: project ${row.neonProjectId}, expected ${projectId}`,
          );
        if (row.neonDevelopmentBranchId !== ids.development)
          violations.push(
            `${key}: development branch ${row.neonDevelopmentBranchId}, expected ${ids.development}`,
          );
        if (row.neonPreviewBranchId !== ids.preview)
          violations.push(
            `${key}: preview branch ${row.neonPreviewBranchId}, expected ${ids.preview}`,
          );
        if (row.neonActiveBranchId !== activeId)
          violations.push(
            `${key}: active branch ${row.neonActiveBranchId}, expected ${expected.active} (${activeId})`,
          );
        const host = await cached(
          hostCache,
          activeId,
          () => live.verifier.endpointHost(projectId, activeId),
          dbHost,
        );
        if (dbHost !== host)
          violations.push(
            `${key}: DATABASE_URL host ${dbHost}, expected ${expected.active} endpoint ${host}`,
          );
        if (pgHost !== host)
          violations.push(
            `${key}: POSTGRES_URL host ${pgHost}, expected ${expected.active} endpoint ${host}`,
          );
        const authUrl = await cached(
          authUrlCache,
          activeId,
          () => live.verifier.authBaseUrl(projectId, activeId),
          env.NEON_AUTH_BASE_URL,
        );
        if (env.NEON_AUTH_BASE_URL !== authUrl)
          violations.push(
            `${key}: NEON_AUTH_BASE_URL ${env.NEON_AUTH_BASE_URL}, expected ${expected.active} Auth ${authUrl}`,
          );
      } else {
        for (const field of [
          "neonProjectId",
          "neonDevelopmentBranchId",
          "neonPreviewBranchId",
          "neonActiveBranchId",
        ] as const) {
          if (row[field] !== null)
            violations.push(`${key}: unlinked but ${field} is ${row[field]}`);
        }
        if (env.DATABASE_URL?.includes(".neon.tech"))
          violations.push(
            `${key}: unlinked but DATABASE_URL still targets Neon`,
          );
        if (env.NEON_AUTH_BASE_URL !== undefined)
          violations.push(`${key}: unlinked but NEON_AUTH_BASE_URL remains`);
      }
      if (row.neonTestBranchId !== null)
        violations.push(
          `${key}: neonTestBranchId ${row.neonTestBranchId} after leases settled`,
        );
    }

    const since = lastCheckAt;
    lastCheckAt = new Date();
    await live.verifier.waitForOperations(projectId, { since });
    const branches = await listBranches(live.verifier.client, projectId);
    const tree = live.verifier.describeTree(branches);
    const expectedTree = [
      { name: "development", parent: null },
      { name: "main", parent: null },
      { name: "preview", parent: "development" },
    ];
    if (JSON.stringify(tree) !== JSON.stringify(expectedTree)) {
      violations.push(
        `branch tree ${JSON.stringify(tree)}, expected ${JSON.stringify(expectedTree)}`,
      );
    }
    for (const key of ["development", "main", "preview"] as const) {
      const branch = branches.find((b) => b.id === ids[key]);
      if (!branch)
        violations.push(`${key} branch ${ids[key]} is gone or was replaced`);
    }

    const markers: Record<string, string[]> = {};
    for (const key of ["development", "main", "preview"] as const) {
      markers[key] = await markersOn(ids[key]);
      const expected = [...model.markers[key]].sort();
      if (JSON.stringify(markers[key]) !== JSON.stringify(expected)) {
        const missing = expected.filter((m) => !markers[key].includes(m));
        const unexpected = markers[key].filter(
          (m) => !model.markers[key].has(m),
        );
        violations.push(
          `${key} markers: missing [${missing.join(", ")}], unexpected [${unexpected.join(", ")}]`,
        );
      }
    }

    const cleanupRows = await live.harness.db.select().from(testBranchCleanup);
    if (cleanupRows.length > 0) {
      violations.push(
        `${cleanupRows.length} test-branch cleanup record(s) remain after leases settled`,
      );
    }
    return {
      observed: { apps, tree, markers, cleanupRows: cleanupRows.length },
      violations,
    };
  }

  async function checkInvariants(stage: string) {
    const { observed, violations } = await observe();
    if (violations.length > 0)
      throw new InvariantViolation(stage, violations, observed);
    return observed;
  }

  // -------------------------------------------------------------------------
  // Actions (Dyad code paths; the model predicts the outcome first)
  // -------------------------------------------------------------------------

  async function leaseMidChecks(
    app: AppModel,
    ownerId: string,
    lease: { branch: { branchId: string; databaseUrl: string } },
    label: string,
  ) {
    const parentKey = app.active;
    const branches = await live.verifier.branches(projectId);
    const branch = branches.find((b) => b.id === lease.branch.branchId);
    ensure(
      branch,
      `lease branch ${lease.branch.branchId} is not in the project`,
    );
    ensure(
      branch.name.startsWith(`dyad-test-${app.appId}-`),
      `lease branch has unexpected name ${branch.name}`,
    );
    ensure(
      branch.parent_id === ids[parentKey],
      `lease branch parent ${branch.parent_id}, expected the active ${parentKey} branch ${ids[parentKey]}`,
    );
    ensure(
      (await trackedRunTestBranchId(ownerId)) === lease.branch.branchId,
      "lease has no durable cleanup record",
    );
    const host = await live.verifier.endpointHost(
      projectId,
      lease.branch.branchId,
    );
    ensure(
      databaseHost(lease.branch.databaseUrl) === host,
      "lease connection string does not target the lease branch",
    );
    // The test branch starts as a copy of the active branch...
    const sql = neon(lease.branch.databaseUrl);
    const rows = (await sql.query(
      `select label from dyad_live_marker order by label`,
    )) as Array<{ label: string }>;
    const expected = [...model.markers[parentKey]].sort();
    ensure(
      JSON.stringify(rows.map((r) => r.label)) === JSON.stringify(expected),
      `lease markers ${JSON.stringify(rows.map((r) => r.label))}, expected the ${parentKey} rows ${JSON.stringify(expected)}`,
    );
    // ...and a test's writes stay on it (checked against the model afterwards).
    await sql.query(`insert into dyad_live_marker(label) values ($1)`, [label]);
  }

  async function execute(
    action: PlannedAction,
    seedValue: number,
    suffix: string,
  ) {
    const app = model.apps[action.app];
    const label = live.marker(`s${seedValue}-a${action.index}${suffix}`);
    switch (action.kind) {
      case "switch": {
        const result = await ipc.neon.setActiveBranch({
          appId: app.appId,
          branchId: ids[action.target!],
        });
        ensure(result.success, "setActiveBranch reported failure");
        app.active = action.target!;
        return;
      }
      case "sql": {
        const row = await live.appRow(app.appId);
        const output = await executeSqlTool.execute(
          { query: `insert into dyad_live_marker(label) values ('${label}')` },
          sqlToolContext(row),
        );
        ensure(
          output.startsWith("Successfully executed SQL query"),
          `execute_sql returned: ${output.slice(0, 200)}`,
        );
        model.markers[app.active].add(label);
        return;
      }
      case "sql-rejected": {
        const row = await live.appRow(app.appId);
        let rejected = false;
        try {
          await executeSqlTool.execute(
            {
              query: `insert into dyad_live_marker(label) values ('${label}')`,
            },
            sqlToolContext(row),
          );
        } catch {
          rejected = true;
        }
        ensure(rejected, "execute_sql ran for an app with no linked database");
        return;
      }
      case "snapshot": {
        const commit = live.commit(
          app.appDir,
          `explore-${seedValue}-${action.index}${suffix}`,
        );
        await sleep(TIMESTAMP_SPACING_MS);
        const { timestamp } = await storeDbTimestampAtCurrentVersion({
          appId: app.appId,
        });
        await sleep(TIMESTAMP_SPACING_MS);
        model.snapshots.push({
          ordinal: model.nextOrdinal++,
          commit,
          timestamp,
          developmentMarkers: [...model.markers.development].sort(),
        });
        model.headA = commit;
        return;
      }
      case "revert": {
        const target = model.snapshots.find(
          (s) => s.ordinal === action.snapshotOrdinal,
        );
        ensure(
          target,
          `revert target snapshot ${action.snapshotOrdinal} is not restorable in the model`,
        );
        ensure(
          target.commit !== model.headA,
          "revert target is the current version",
        );
        const result = await versionPreviewHandlerService.revertVersion({
          appId: app.appId,
          previousVersionId: target.commit,
        });
        // The backup cleanup runs in the background once the revert is done.
        await settleNeonBackupCleanups();
        ensure(
          result.notification?.kind === "success" &&
            /including database/.test(result.notification.message ?? ""),
          `revert did not restore the database: ${JSON.stringify(result.notification)}`,
        );
        model.markers.development = new Set(target.developmentMarkers);
        // Dyad forgets restore points newer than the one restored to.
        model.snapshots = model.snapshots.filter(
          (s) => s.timestamp <= target.timestamp,
        );
        model.headA = gitHead(app.appDir);
        return;
      }
      case "lease-release": {
        const row = await live.appRow(app.appId);
        const ownerId = `explore-${seedValue}-${action.index}${suffix}`;
        const lease = await acquireNeonTestBranch(row, app.appDir, ownerId, {});
        try {
          await leaseMidChecks(app, ownerId, lease, `${label}-lease`);
        } finally {
          const released = await lease.release();
          ensure(
            released,
            `lease ${lease.branch.branchId} release reported failure`,
          );
        }
        ensure(
          !(await live.verifier.branchExists(projectId, lease.branch.branchId)),
          "released lease branch still exists",
        );
        ensure(
          (await trackedRunTestBranchId(ownerId)) === null,
          "released lease kept its cleanup record",
        );
        return;
      }
      case "lease-cancel": {
        const row = await live.appRow(app.appId);
        const ownerId = `explore-${seedValue}-${action.index}${suffix}`;
        const controller = new AbortController();
        let rejection: unknown;
        if (action.cancelAt === "before-admission") {
          controller.abort();
          await acquireNeonTestBranch(row, app.appDir, ownerId, {
            signal: controller.signal,
          }).then(
            (lease) => lease.release(),
            (error) => {
              rejection = error;
            },
          );
        } else {
          // Named barrier: hold Dyad's branch-create request, cancel while it
          // is in flight, then let it reach Neon. Dyad must compensate.
          const gateRule = live.faults.add({
            id: `explore-cancel-${seedValue}-${action.index}${suffix}`,
            transport: "management",
            method: "POST",
            path: /^\/projects\/[^/]+\/branches$/,
            action: { kind: "gate" },
          });
          const pending = acquireNeonTestBranch(row, app.appDir, ownerId, {
            signal: controller.signal,
          }).then(
            (lease) => lease.release(),
            (error) => {
              rejection = error;
            },
          );
          try {
            // If Dyad fails before reaching Neon, the gate is never hit.
            const reached = await Promise.race([
              gateRule.reached.then(() => true),
              pending.then(() => false),
            ]);
            if (reached) controller.abort();
          } finally {
            gateRule.release();
            await pending;
            live.faults.clear();
          }
        }
        ensure(
          rejection !== undefined,
          "a cancelled lease acquisition resolved instead of rejecting",
        );
        ensure(
          (rejection as { name?: string }).name === "AbortError",
          `cancelled lease rejected with ${sanitizeError(rejection, live.redact).name}: ${sanitizeError(rejection, live.redact).message}`,
        );
        ensure(
          (await trackedRunTestBranchId(ownerId)) === null,
          "cancelled lease left a cleanup record",
        );
        return;
      }
      case "unlink": {
        const result = await ipc.neon.unsetAppProject({ appId: app.appId });
        ensure(result.success, "unsetAppProject reported failure");
        app.linked = false;
        ensure(
          await live.verifier.projectExists(projectId),
          "unlinking deleted the remote Neon project",
        );
        return;
      }
      case "relink": {
        const result = await ipc.neon.setAppProject({
          appId: app.appId,
          projectId,
        });
        ensure(result.success, "setAppProject reported failure");
        app.linked = true;
        app.active = "development";
        return;
      }
    }
  }

  /** Brings both apps to the canonical seed-start state through Dyad itself. */
  async function resetToCanonical() {
    for (const key of ["A", "B"] as const) {
      const app = model.apps[key];
      if (!app.linked) {
        const result = await ipc.neon.setAppProject({
          appId: app.appId,
          projectId,
        });
        ensure(result.success, `reset: relinking app ${key} failed`);
        app.linked = true;
        app.active = "development";
      }
      if (app.active !== "development") {
        const result = await ipc.neon.setActiveBranch({
          appId: app.appId,
          branchId: ids.development,
        });
        ensure(
          result.success,
          `reset: switching app ${key} to development failed`,
        );
        app.active = "development";
      }
    }
    model.snapshots = [];
    model.nextOrdinal = 0;
    model.headA = gitHead(model.apps.A.appDir);
    await checkInvariants("at the canonical seed-start state");
  }

  async function runActions(
    actions: PlannedAction[],
    seedValue: number,
    suffix: string,
    record: (entry: ActionRecord) => void,
  ) {
    for (const action of actions) {
      const start = Date.now();
      const entry: ActionRecord = { ...action };
      record(entry);
      try {
        await execute(action, seedValue, suffix);
        await checkInvariants(
          `after action ${action.index} (${action.kind} on app ${action.app})`,
        );
        entry.outcome = "ok";
      } catch (error) {
        entry.outcome = "failed";
        throw error;
      } finally {
        entry.ms = Date.now() - start;
        live.metrics.event("explore-action", {
          seed: seedValue,
          index: action.index,
          app: action.app,
          kind: action.kind,
          replay: suffix || undefined,
          ms: entry.ms,
          outcome: entry.outcome,
        });
      }
    }
  }

  /** Cheap minimization: the failing action alone, else the whole prefix once. */
  async function minimize(
    seedValue: number,
    actions: ActionRecord[],
    failingIndex: number,
  ): Promise<Record<string, unknown>> {
    const failing = actions[failingIndex];
    const prefixMs = actions.reduce(
      (sum, a) => sum + (a.ms ?? averageActionMs),
      0,
    );
    const budgetLeft = () => fileDeadline - Date.now();
    try {
      await resetToCanonical();
    } catch (error) {
      return {
        attempted: false,
        reason: `the failure left persistent state: ${sanitizeError(error, live.redact).message}`,
      };
    }
    // Reverts need earlier snapshots; relink/sql-rejected need an unlinked app.
    if (
      replayableAlone(failing) &&
      budgetLeft() > (failing.ms ?? averageActionMs) * 2
    ) {
      const replayed: ActionRecord[] = [];
      try {
        await runActions([{ ...failing, index: 0 }], seedValue, "-m1", (e) =>
          replayed.push(e),
        );
      } catch (error) {
        return {
          attempted: true,
          reproduced: true,
          minimalActions: [{ ...failing, index: 0 }],
          error: sanitizeError(error, live.redact),
        };
      }
      try {
        await resetToCanonical();
      } catch (error) {
        return {
          attempted: true,
          reproduced: false,
          note: "the failing action passed alone; the replay left the state invalid",
          error: sanitizeError(error, live.redact),
        };
      }
    }
    if (budgetLeft() < prefixMs * 1.5) {
      return {
        attempted: true,
        reproduced: "unknown",
        note: "the failing action did not reproduce alone and replaying the prefix exceeds the remaining budget",
      };
    }
    const replayed: ActionRecord[] = [];
    try {
      await runActions(
        actions
          .slice(0, failingIndex + 1)
          .map(({ ms: _ms, outcome: _o, ...a }) => a),
        seedValue,
        "-m2",
        (e) => replayed.push(e),
      );
    } catch (error) {
      const failedAt = replayed.findIndex((e) => e.outcome === "failed");
      return {
        attempted: true,
        reproduced: true,
        minimalActions: actions
          .slice(0, failedAt + 1)
          .map(({ ms: _ms, outcome: _o, ...a }) => a),
        error: sanitizeError(error, live.redact),
      };
    }
    return {
      attempted: true,
      reproduced: false,
      note: "the prefix replayed without failing: likely timing- or provider-dependent",
    };
  }

  function writeTrace(
    seedValue: number,
    trace: Record<string, unknown>,
  ): string {
    const dir = path.join(live.config.runDir, "explore-traces");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `seed-${seedValue}.json`);
    fs.writeFileSync(file, live.redact(JSON.stringify(trace, null, 2)));
    return file;
  }

  async function runSeed(seedIndex: number, seedValue: number) {
    const rng = mulberry32(seedValue);
    const actions: ActionRecord[] = [];
    let stage = "reset";
    try {
      await resetToCanonical();
      stage = "actions";
      for (let index = 0; index < actionsPerSeed; index++) {
        const action = chooseAction(rng, model, index);
        await runActions([action], seedValue, "", (entry) =>
          actions.push(entry),
        );
        completedActions += 1;
        totalActionMs += actions[actions.length - 1].ms ?? 0;
        averageActionMs = totalActionMs / completedActions;
      }
    } catch (error) {
      const failingIndex = actions.findIndex((a) => a.outcome === "failed");
      const modelAtFailure = serializeModel(model);
      const trace: Record<string, unknown> = {
        campaignId: live.config.campaignId,
        phase: live.config.phase,
        seedBase: live.config.seed,
        seedIndex,
        seedValue,
        rerun: `${SINGLE_SEED_ENV}=${seedValue} npm run test:neon:live -- --phase explore`,
        stage,
        failingIndex,
        projectId,
        branchIds: ids,
        actions,
        model: modelAtFailure,
        error: sanitizeError(error, live.redact),
        violations:
          error instanceof InvariantViolation ? error.violations : undefined,
        observed:
          error instanceof InvariantViolation ? error.observed : undefined,
      };
      let file = writeTrace(seedValue, trace);
      if (failingIndex >= 0) {
        trace.minimization = await minimize(
          seedValue,
          actions,
          failingIndex,
        ).catch((e) => ({
          attempted: true,
          error: sanitizeError(e, live.redact),
        }));
      } else {
        trace.minimization = {
          attempted: false,
          reason: `failed during ${stage}, before any action`,
        };
      }
      file = writeTrace(seedValue, trace);
      halted = `seed ${seedValue} failed; later seeds start from possibly damaged state`;
      const where =
        failingIndex >= 0
          ? `action ${failingIndex} (${actions[failingIndex].kind} on app ${actions[failingIndex].app})`
          : stage;
      throw new Error(
        `Exploration seed ${seedValue} failed at ${where}: ${sanitizeError(error, live.redact).message}\nTrace: ${file}`,
        { cause: error },
      );
    }
  }

  if (seedValues.length === 0) {
    it.skip(`no exploration seeds in the ${gate.enabled ? gate.config.profile : "inert"} profile`, () => {});
  }

  seedValues.forEach((seedValue, seedIndex) => {
    it.runIf(canCreateProjects)(
      `seed ${seedValue} (${seedIndex + 1}/${seedValues.length}, ${actionsPerSeed} actions)`,
      async (ctx) => {
        if (halted) ctx.skip(halted);
        const estimate =
          actionsPerSeed * averageActionMs * 1.25 + RESET_ESTIMATE_MS;
        const left = fileDeadline - Date.now();
        if (left < estimate) {
          halted = `budget-limited after ${completedSeeds} seed(s)`;
          throw new Error(
            `Exploration budget-limited: completed ${completedSeeds} of ${seedValues.length} seeds (${completedActions} actions); seed ${seedValue} needs ~${Math.round(estimate / 1000)}s but ${Math.max(0, Math.round(left / 1000))}s remain in this run`,
          );
        }
        live.assertBudget(estimate);
        await live.scenario(`explore:seed-${seedValue}`, () =>
          runSeed(seedIndex, seedValue),
        );
        completedSeeds += 1;
        const memory = process.memoryUsage();
        live.metrics.event("explore-idle-checkpoint", {
          seed: seedValue,
          completedSeeds,
          completedActions,
          rssMb: Math.round(memory.rss / 1e6),
          heapUsedMb: Math.round(memory.heapUsed / 1e6),
          activeResources: process.getActiveResourcesInfo().length,
        });
      },
      SEED_TIMEOUT_MS,
    );
  });
});
