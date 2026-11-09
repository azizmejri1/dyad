// Live P0 concurrency ramp: 1 → 2 → 4 overlapping Tests-panel workflows on
// one Dyad project, through Dyad's real branch leases and SQL path.
//
// Level 1 and 2 overlap runs of the same app; level 4 spreads runs over four
// apps linked to the same project. Barriers (not sleeps) make every round's
// leases coexist before any is released. Independent projects are not
// overlapped here: the campaign allows two owned projects and eight computes.
//
// Runs only under the campaign supervisor (npm run test:neon:live).
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CAMPAIGN_LIMITS,
  PROFILE_WORKLOAD,
  liveNeonGate,
} from "@/testing/live_neon/config";

vi.mock("@/neon_admin/neon_management_client", async (importOriginal) =>
  (await import("@/testing/live_neon/product_client")).mockNeonManagementClient(
    await importOriginal<
      typeof import("@/neon_admin/neon_management_client")
    >(),
  ),
);

import { testBranchCleanup } from "@/db/schema";
import { ipc } from "@/ipc/types";
import { acquireNeonTestBranch } from "@/ipc/services/neon_test_branch_lease";
import { trackedRunTestBranchId } from "@/ipc/utils/neon_test_branch";
import { executeNeonSql } from "@/neon_admin/neon_context";
import {
  databaseHost,
  setupLiveNeonHarness,
  type LiveNeonHarness,
} from "@/testing/live_neon/live_harness";
import { percentile } from "@/testing/live_neon/metrics";
import { assertRealNeonIds } from "@/testing/live_neon/verifier";

const gate = liveNeonGate();
const canCreateProjects =
  gate.enabled && gate.config.keyMode === "organization";
const cycles = gate.enabled
  ? PROFILE_WORKLOAD[gate.config.profile].cyclesPerConcurrencyLevel
  : 0;
const APP_COUNT = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Lease = Awaited<ReturnType<typeof acquireNeonTestBranch>>;
type SqlFn = NeonQueryFunction<false, false>;

/**
 * Countdown latch: every participant's `arrive()` resolves once all have
 * arrived. `fail()` releases everyone with the error so a failing worker
 * cannot strand the others.
 */
function latch(parties: number) {
  let arrived = 0;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  done.catch(() => {});
  return {
    arrive: () => {
      arrived += 1;
      if (arrived >= parties) resolve();
      return done;
    },
    fail: (error: unknown) => reject(error),
  };
}

async function labels(sql: SqlFn): Promise<string[]> {
  const [{ present }] = (await sql.query(
    `select to_regclass('public.dyad_live_marker') is not null as present`,
  )) as Array<{ present: boolean }>;
  if (!present) return [];
  return (
    (await sql.query(
      `select label from dyad_live_marker order by label`,
    )) as Array<{
      label: string;
    }>
  ).map((r) => r.label);
}

describe.runIf(gate.enabled)("Neon concurrency ramp (live Neon)", () => {
  let live: LiveNeonHarness;
  let projectId: string;
  let devId: string;
  let mainId: string;
  let devMarker: string;
  let devSql: SqlFn;
  let mainSql: SqlFn;
  const apps: Array<{ appId: number; appDir: string }> = [];
  const held = new Set<Lease>();

  beforeAll(async () => {
    live = await setupLiveNeonHarness({ suite: "concurrency" });
    if (!canCreateProjects || cycles === 0) return;
    const first = await live.createGitApp("concurrency-0");
    const created = await ipc.neon.createProject({
      name: live.projectName("concurrency"),
      appId: first.appId,
    });
    projectId = created.id;
    apps.push({ appId: first.appId, appDir: first.appDir });
    // Every other app links the same project, as a user would with "Use
    // existing project" in several apps.
    for (let i = 1; i < APP_COUNT; i++) {
      const app = await live.createGitApp(`concurrency-${i}`);
      const linked = await ipc.neon.setAppProject({
        appId: app.appId,
        projectId,
      });
      expect(linked.success).toBe(true);
      apps.push({ appId: app.appId, appDir: app.appDir });
    }
    const firstRow = await live.appRow(first.appId);
    devId = firstRow.neonDevelopmentBranchId!;
    mainId = (await live.verifier.branches(projectId)).find(
      (b) => b.default,
    )!.id;
    for (const { appId } of apps) {
      const row = await live.appRow(appId);
      expect(row.neonProjectId).toBe(projectId);
      expect(row.neonActiveBranchId).toBe(devId);
    }
    devMarker = live.marker("concurrency-dev");
    await live.seedMarker(projectId, devId, devMarker);
    devSql = await live.verifier.sql(projectId, devId);
    mainSql = await live.verifier.sql(projectId, mainId);
  }, 900_000);

  afterAll(async () => {
    for (const lease of held) await lease.release().catch(() => {});
    await live?.dispose();
  }, 600_000);

  async function eventuallyAbsent(
    branchId: string,
    timeoutMs = 90_000,
  ): Promise<number> {
    const start = Date.now();
    let delay = 1_000;
    while (await live.verifier.branchExists(projectId, branchId)) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `branch ${branchId} still exists ${timeoutMs}ms after Dyad deleted it`,
        );
      }
      await sleep(delay);
      delay = Math.min(5_000, delay * 2);
    }
    return Date.now() - start;
  }

  /** Steady state between levels, recorded as an idle checkpoint. */
  async function idleCheckpoint(label: string) {
    const tree = await live.verifier.branches(projectId);
    const rows = await live.harness.db.select().from(testBranchCleanup);
    const checkpoint = {
      label,
      heapUsed: process.memoryUsage().heapUsed,
      activeResources: process.getActiveResourcesInfo().length,
      remoteBranches: tree.length,
      cleanupRows: rows.length,
    };
    live.metrics.event("concurrency-idle-checkpoint", checkpoint);
    expect(live.verifier.describeTree(tree)).toEqual([
      { name: "development", parent: null },
      { name: "main", parent: null },
      { name: "preview", parent: "development" },
    ]);
    expect(tree.filter((b) => b.name.startsWith("dyad-test-"))).toEqual([]);
    expect(rows).toEqual([]);
    for (const { appId } of apps) {
      expect((await live.appRow(appId)).neonTestBranchId).toBeNull();
    }
    expect(await labels(devSql)).toEqual([devMarker]);
    expect(await labels(mainSql)).toEqual([]);
    return checkpoint;
  }

  /** Apps for a level: same-app overlap below 4, four apps at 4. */
  function appFor(level: number, worker: number) {
    return level < APP_COUNT ? apps[0] : apps[worker % APP_COUNT];
  }

  async function runRound(level: number, round: number): Promise<number[]> {
    const acquired = latch(level);
    const written = latch(level);
    const checked = latch(level);
    const latches = [acquired, written, checked];
    const leases: Array<Lease | undefined> = Array.from(
      { length: level },
      () => undefined,
    );

    const worker = async (w: number): Promise<number> => {
      const scenarioName = `concurrency:L${level}:cycle`;
      const start = Date.now();
      let lease: Lease | undefined;
      let released = false;
      try {
        return await live.scenario(scenarioName, async () => {
          const { appId, appDir } = appFor(level, w);
          const ownerId = live.marker(`L${level}-r${round}-w${w}`);
          lease = await acquireNeonTestBranch(
            await live.appRow(appId),
            appDir,
            ownerId,
            {},
          );
          held.add(lease);
          leases[w] = lease;
          const branch = lease.branch;
          assertRealNeonIds({
            branchIds: [branch.branchId],
            hosts: [databaseHost(branch.databaseUrl)],
          });
          expect(await trackedRunTestBranchId(ownerId)).toBe(branch.branchId);
          await acquired.arrive();

          // Every lease in the round is live now. Branches are distinct.
          const ids = leases.map((l) => l?.branch.branchId);
          expect(new Set(ids).size).toBe(level);

          const sql = neon(branch.databaseUrl);
          const marker = live.marker(`L${level}-r${round}-w${w}-row`);
          await sql.query(`insert into dyad_live_marker(label) values ($1)`, [
            marker,
          ]);
          await written.arrive();

          // Isolation while all are live: mine only, plus development's copy.
          expect(await labels(sql)).toEqual([devMarker, marker].sort());
          for (const [index, other] of leases.entries()) {
            if (index === w || !other) continue;
            expect(await labels(neon(other.branch.databaseUrl))).not.toContain(
              marker,
            );
          }
          // Dyad's own SQL path against the app's active branch reads development.
          const row = await live.appRow(appId);
          const result = JSON.parse(
            await executeNeonSql({
              projectId,
              branchId: row.neonActiveBranchId!,
              query: `select label from dyad_live_marker order by label`,
            }),
          ) as Array<{ label: string }>;
          expect(result.map((r) => r.label)).toEqual([devMarker]);
          await checked.arrive();

          released = true;
          held.delete(lease);
          expect(await lease.release()).toBe(true);
          await eventuallyAbsent(branch.branchId);
          expect(await trackedRunTestBranchId(ownerId)).toBeNull();
          return Date.now() - start;
        });
      } catch (error) {
        for (const l of latches) l.fail(error);
        throw error;
      } finally {
        if (lease && !released) {
          held.delete(lease);
          await lease.release().catch(() => false);
        }
      }
    };

    const results = await Promise.allSettled(
      Array.from({ length: level }, (_, w) => worker(w)),
    );
    const failure = results.find((r) => r.status === "rejected");
    if (failure) throw (failure as PromiseRejectedResult).reason;
    return results.map((r) => (r as PromiseFulfilledResult<number>).value);
  }

  it.runIf(canCreateProjects)(
    "keeps every overlapping run on its own branch at 1, 2 and 4 concurrent runs",
    async ({ skip }) => {
      if (cycles === 0) {
        skip(
          `NOT COVERED: profile ${live.config.profile} schedules 0 concurrency cycles`,
        );
      }
      await idleCheckpoint("baseline");
      for (const level of CAMPAIGN_LIMITS.concurrencyLevels) {
        // Each round runs `level` overlapping cycles; aim for `cycles` per level.
        const rounds = Math.ceil(cycles / level);
        live.assertBudget(rounds * 2 * 60_000);
        const levelStart = Date.now();
        const durations: number[] = [];
        for (let round = 0; round < rounds; round++) {
          durations.push(...(await runRound(level, round)));
        }
        const wallMs = Date.now() - levelStart;
        live.metrics.event("concurrency-level", {
          level,
          cycles: durations.length,
          wallMs,
          throughputPerMinute: Number(
            ((durations.length / wallMs) * 60_000).toFixed(2),
          ),
          p50Ms: percentile(durations, 50),
          p95Ms: percentile(durations, 95),
          maxMs: Math.max(...durations),
          managementThrottleEvents: live.managementBudget.throttleEvents,
        });
        expect(durations.length).toBeGreaterThanOrEqual(cycles);
        await idleCheckpoint(`after-level-${level}`);
      }
    },
    40 * 60_000,
  );
});
