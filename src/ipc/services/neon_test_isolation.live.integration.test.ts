// Live P0 Tests-panel isolation: Dyad's real branch leases, per-case data
// cleaner and startup recovery against real Neon branches, SQL and Auth.
//
// One Dyad-created project is shared by every test in this file. The
// capacity test fills the project and must stay last.
//
// Runs only under the campaign supervisor (npm run test:neon:live).
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CAMPAIGN_LIMITS, liveNeonGate } from "@/testing/live_neon/config";

vi.mock("@/neon_admin/neon_management_client", async (importOriginal) =>
  (await import("@/testing/live_neon/product_client")).mockNeonManagementClient(
    await importOriginal<
      typeof import("@/neon_admin/neon_management_client")
    >(),
  ),
);

import { testBranchCleanup } from "@/db/schema";
import { DyadErrorKind } from "@/errors/dyad_error";
import { ipc } from "@/ipc/types";
import {
  acquireNeonTestBranch,
  isNeonBranchCapacityError,
} from "@/ipc/services/neon_test_branch_lease";
import { updateNeonEnvVars } from "@/ipc/utils/app_env_var_utils";
import { detectFrameworkType } from "@/ipc/utils/framework_utils";
import {
  createTempTestBranch,
  reconcileOrphanTestBranches,
  trackedRunTestBranchId,
} from "@/ipc/utils/neon_test_branch";
import { createNeonTestDataCleaner } from "@/ipc/utils/neon_test_data";
import type { NeonBranchLimitStatus } from "@/shared/neon_branch_limit";
import {
  databaseHost,
  setupLiveNeonHarness,
  type LiveNeonHarness,
} from "@/testing/live_neon/live_harness";
import { deleteBranchVerified, httpStatus } from "@/testing/live_neon/neon_ops";
import { assertRealNeonIds } from "@/testing/live_neon/verifier";

const gate = liveNeonGate();
const canCreateProjects =
  gate.enabled && gate.config.keyMode === "organization";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Lease = Awaited<ReturnType<typeof acquireNeonTestBranch>>;
type SqlFn = NeonQueryFunction<false, false>;

/** Fails instead of hanging when an expected event never arrives. */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} did not happen within ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Records onCapacity notifications and lets a test await a specific one. */
function capacityTracker() {
  const statuses: Array<NeonBranchLimitStatus | undefined> = [];
  const waiters: Array<{
    status: NeonBranchLimitStatus | undefined;
    resolve: () => void;
  }> = [];
  return {
    statuses,
    onCapacity: (status: NeonBranchLimitStatus | undefined) => {
      statuses.push(status);
      for (const waiter of waiters.filter((w) => w.status === status))
        waiter.resolve();
    },
    when: (status: NeonBranchLimitStatus | undefined) =>
      statuses.includes(status)
        ? Promise.resolve()
        : new Promise<void>((resolve) => waiters.push({ status, resolve })),
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

/** Row count, or null when the relation does not exist on this branch. */
async function rowCount(sql: SqlFn, relation: string): Promise<number | null> {
  const [{ present }] = (await sql.query(
    `select to_regclass($1) is not null as present`,
    [relation],
  )) as Array<{ present: boolean }>;
  if (!present) return null;
  const [{ n }] = (await sql.query(
    `select count(*)::int as n from ${relation}`,
  )) as Array<{
    n: number;
  }>;
  return n;
}

/** Tables the cleaner must empty: user data, including Neon Auth users. */
const USER_DATA = [
  "public.dyad_live_marker",
  "public.profiles",
  `public."Mixed Case"`,
  "public.events",
  `neon_auth."user"`,
] as const;

/** Tables the cleaner must leave alone. Null-tolerant: not every branch has all. */
const PRESERVED = [
  "neon_auth.project_config",
  "neon_auth.jwks",
  "drizzle.__drizzle_migrations",
  "public.schema_migrations",
  "public.spatial_ref_sys",
] as const;

describe.runIf(gate.enabled)("Neon Tests-panel isolation (live Neon)", () => {
  let live: LiveNeonHarness;
  let appId: number;
  let appDir: string;
  let projectId: string;
  let devId: string;
  let mainId: string;
  let previewId: string;
  let devMarker: string;
  let devEmail: string;
  let devSql: SqlFn;
  let mainSql: SqlFn;
  let extensionOwnedSeeded = false;
  let ownerCounter = 0;
  const held = new Set<Lease>();

  const owner = (label: string) =>
    live.marker(`isolation-${label}-${++ownerCounter}`);

  async function acquire(
    label: string,
    options: Parameters<typeof acquireNeonTestBranch>[3] = {},
  ): Promise<{ lease: Lease; ownerId: string }> {
    const ownerId = owner(label);
    const lease = await acquireNeonTestBranch(
      await live.appRow(appId),
      appDir,
      ownerId,
      options,
    );
    held.add(lease);
    return { lease, ownerId };
  }

  async function release(lease: Lease): Promise<boolean> {
    held.delete(lease);
    return lease.release();
  }

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

  async function cleanupRows() {
    return live.harness.db.select().from(testBranchCleanup);
  }

  async function protectedBranchIds() {
    const app = await live.appRow(appId);
    // Exactly what isolated_test_db.ts passes.
    return [
      app.neonActiveBranchId,
      app.neonDevelopmentBranchId,
      app.neonPreviewBranchId,
    ];
  }

  beforeAll(async () => {
    live = await setupLiveNeonHarness({ suite: "test-isolation" });
    if (!canCreateProjects) return;
    ({ appId, appDir } = await live.createGitApp("isolation"));
    const created = await ipc.neon.createProject({
      name: live.projectName("isolation"),
      appId,
    });
    projectId = created.id;
    const app = await live.appRow(appId);
    devId = app.neonDevelopmentBranchId!;
    previewId = app.neonPreviewBranchId!;
    mainId = (await live.verifier.branches(projectId)).find(
      (b) => b.default,
    )!.id;
    assertRealNeonIds({ projectId, branchIds: [devId, previewId, mainId] });

    // Development holds realistic user data, an Auth user, migration
    // bookkeeping and (where available) an extension-owned table.
    devMarker = live.marker("isolation-dev");
    devEmail = `iso-dev-${Date.now()}@example.com`;
    await live.seedMarker(projectId, devId, devMarker);
    const signUp = await live.verifier.authRequest(
      projectId,
      devId,
      "sign-up",
      devEmail,
    );
    if (signUp !== 200)
      throw new Error(`fixture sign-up on development returned ${signUp}`);
    devSql = await live.verifier.sql(projectId, devId);
    mainSql = await live.verifier.sql(projectId, mainId);
    const [{ id: userId }] = (await devSql.query(
      `select id from neon_auth."user" where email = $1`,
      [devEmail],
    )) as Array<{ id: string }>;
    for (const statement of [
      `create table profiles (id serial primary key, user_id uuid references neon_auth."user"(id) on delete cascade, note text)`,
      `create view profile_notes as select note from profiles`,
      `create table "Mixed Case" (id bigint generated always as identity primary key, "Value" jsonb)`,
      `create table events (id int, at date, primary key (id, at)) partition by range (at)`,
      `create table events_2025 partition of events for values from ('2025-01-01') to ('2026-01-01')`,
      `create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01')`,
      `create schema if not exists drizzle`,
      `create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)`,
      `create table public.schema_migrations (version text primary key)`,
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ('h1', 1), ('h2', 2)`,
      `insert into public.schema_migrations values ('20250101000000')`,
      `insert into "Mixed Case" ("Value") values ('{"a": [1, 2]}'), ('{"b": null}')`,
      `insert into events select g, case when g % 2 = 0 then date '2025-06-01' else date '2026-06-01' end from generate_series(1, 50) g`,
    ]) {
      await devSql.query(statement);
    }
    await devSql.query(
      `insert into profiles (user_id, note) values ($1, 'dev'), (null, 'anon')`,
      [userId],
    );
    try {
      await devSql.query(`create extension if not exists postgis`);
      extensionOwnedSeeded =
        (await rowCount(devSql, "public.spatial_ref_sys")) !== null;
    } catch (error) {
      live.metrics.event("isolation-extension-unavailable", {
        extension: "postgis",
        status: httpStatus(error),
        message: live.redact(String((error as Error).message)).slice(0, 200),
      });
    }
  }, 600_000);

  afterAll(async () => {
    for (const lease of held) {
      await lease.release().catch(() => {});
    }
    await live?.dispose();
  }, 600_000);

  it.runIf(canCreateProjects)(
    "gives concurrent runs separate copy-on-write branches of development and deletes only the released one",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("isolation:concurrent-leases", async () => {
        const [a, b] = await Promise.all([acquire("a"), acquire("b")]);
        const [branchA, branchB] = [a.lease.branch, b.lease.branch];
        expect(branchA.branchId).not.toBe(branchB.branchId);
        assertRealNeonIds({
          branchIds: [branchA.branchId, branchB.branchId],
          hosts: [
            databaseHost(branchA.databaseUrl),
            databaseHost(branchB.databaseUrl),
          ],
        });
        // Created through Dyad's client, cut from the active (development) branch.
        const state = live.journal.state();
        expect(state.branches.get(branchA.branchId)?.actor).toBe("product");
        expect(state.branches.get(branchB.branchId)?.actor).toBe("product");
        const tree = await live.verifier.branches(projectId);
        for (const branchId of [branchA.branchId, branchB.branchId]) {
          expect(tree.find((t) => t.id === branchId)?.parent_id).toBe(devId);
        }
        // The URLs Dyad hands the run point at the right computes.
        expect(databaseHost(branchA.databaseUrl)).toBe(
          await live.verifier.endpointHost(projectId, branchA.branchId),
        );
        expect(databaseHost(branchB.databaseUrl)).toBe(
          await live.verifier.endpointHost(projectId, branchB.branchId),
        );
        // Auth is provisioned per test branch, never the development one.
        const devAuth = await live.verifier.authBaseUrl(projectId, devId);
        expect(branchA.neonAuthBaseUrl).toBeTruthy();
        expect(branchA.neonAuthBaseUrl).not.toBe(devAuth);
        expect(branchB.neonAuthBaseUrl).not.toBe(branchA.neonAuthBaseUrl);

        // Durable, independent recovery records; the app row is untouched.
        expect(await trackedRunTestBranchId(a.ownerId)).toBe(branchA.branchId);
        expect(await trackedRunTestBranchId(b.ownerId)).toBe(branchB.branchId);
        expect((await live.appRow(appId)).neonTestBranchId).toBeNull();

        // Each sees development's data; writes stay on their own branch.
        const sqlA = neon(branchA.databaseUrl);
        const sqlB = neon(branchB.databaseUrl);
        expect(await labels(sqlA)).toEqual([devMarker]);
        expect(await labels(sqlB)).toEqual([devMarker]);
        const markerA = live.marker("lease-a");
        const markerB = live.marker("lease-b");
        await sqlA.query(`insert into dyad_live_marker(label) values ($1)`, [
          markerA,
        ]);
        await sqlB.query(`insert into dyad_live_marker(label) values ($1)`, [
          markerB,
        ]);
        expect(await labels(sqlA)).toEqual([devMarker, markerA].sort());
        expect(await labels(sqlB)).toEqual([devMarker, markerB].sort());
        expect(await labels(devSql)).toEqual([devMarker]);
        expect(await labels(mainSql)).toEqual([]);

        // Releasing A removes A's branch and record only.
        expect(await release(a.lease)).toBe(true);
        const absentAfterMs = await eventuallyAbsent(branchA.branchId);
        live.metrics.event("isolation-release-absence", { ms: absentAfterMs });
        expect(await trackedRunTestBranchId(a.ownerId)).toBeNull();
        expect(await trackedRunTestBranchId(b.ownerId)).toBe(branchB.branchId);
        expect(
          await live.verifier.branchExists(projectId, branchB.branchId),
        ).toBe(true);
        expect(await labels(sqlB)).toEqual([devMarker, markerB].sort());

        expect(await release(b.lease)).toBe(true);
        await eventuallyAbsent(branchB.branchId);
        expect(await cleanupRows()).toEqual([]);
      });
    },
    900_000,
  );

  it.runIf(canCreateProjects)(
    "clears user data per case, keeps Auth/migration/extension tables, and refuses non-test branches",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("isolation:per-case-cleaner", async () => {
        const { lease } = await acquire("cleaner");
        const branch = lease.branch;
        const sql = neon(branch.databaseUrl);
        try {
          // The copy starts with development's data.
          for (const relation of USER_DATA) {
            expect(await rowCount(sql, relation), relation).toBeGreaterThan(0);
          }
          const preservedBefore = Object.fromEntries(
            await Promise.all(
              PRESERVED.map(async (r) => [r, await rowCount(sql, r)] as const),
            ),
          );
          live.metrics.event("isolation-preserved-tables", {
            present: Object.entries(preservedBefore)
              .filter(([, n]) => n !== null)
              .map(([r]) => r),
          });
          expect(preservedBefore["neon_auth.project_config"]).not.toBeNull();
          expect(preservedBefore["drizzle.__drizzle_migrations"]).toBe(2);
          expect(preservedBefore["public.schema_migrations"]).toBe(1);
          if (extensionOwnedSeeded) {
            expect(preservedBefore["public.spatial_ref_sys"]).toBeGreaterThan(
              0,
            );
          }

          // Refusals first: development (protected), a URL outside the test
          // branch, and the default branch addressed with the test URL.
          const devUrl = await live.verifier.connectionUri(projectId, devId);
          const protectedIds = await protectedBranchIds();
          await expect(
            createNeonTestDataCleaner({
              databaseUrl: devUrl,
              projectId,
              branchId: devId,
              protectedBranchIds: protectedIds,
            }),
          ).rejects.toMatchObject({ kind: DyadErrorKind.Precondition });
          await expect(
            createNeonTestDataCleaner({
              databaseUrl: devUrl,
              projectId,
              branchId: branch.branchId,
              protectedBranchIds: protectedIds,
            }),
          ).rejects.toMatchObject({ kind: DyadErrorKind.Precondition });
          await expect(
            createNeonTestDataCleaner({
              databaseUrl: branch.databaseUrl,
              projectId,
              branchId: mainId,
              protectedBranchIds: protectedIds,
            }),
          ).rejects.toMatchObject({ kind: DyadErrorKind.Precondition });
          // Production's protected list names active/development/preview but
          // not the default branch; the endpoint-host check is what keeps main
          // safe. Recorded for review rather than exercised destructively.
          live.metrics.event("isolation-cleaner-protected-list", {
            includesDefaultBranch: protectedIds.includes(mainId),
          });

          const clear = await createNeonTestDataCleaner({
            databaseUrl: branch.databaseUrl,
            projectId,
            branchId: branch.branchId,
            protectedBranchIds: protectedIds,
          });
          await clear();

          for (const relation of USER_DATA) {
            expect(await rowCount(sql, relation), relation).toBe(0);
          }
          for (const relation of PRESERVED) {
            expect(await rowCount(sql, relation), relation).toBe(
              preservedBefore[relation],
            );
          }
          // Views survive, identities restart.
          expect(await rowCount(sql, "public.profile_notes")).toBe(0);
          const [{ id: firstId }] = (await sql.query(
            `insert into profiles (note) values ('case-1') returning id`,
          )) as Array<{ id: number }>;
          expect(Number(firstId)).toBe(1);

          // Auth works on the cleaned branch; the copied development user is gone.
          expect(
            await live.verifier.authRequest(
              projectId,
              branch.branchId,
              "sign-in",
              devEmail,
            ),
          ).not.toBe(200);
          const caseEmail = `iso-case-${Date.now()}@example.com`;
          expect(
            await live.verifier.authRequest(
              projectId,
              branch.branchId,
              "sign-up",
              caseEmail,
            ),
          ).toBe(200);
          expect(
            await live.verifier.authRequest(
              projectId,
              branch.branchId,
              "sign-in",
              caseEmail,
            ),
          ).toBe(200);

          // A retry of the case starts clean again.
          await clear();
          for (const relation of USER_DATA) {
            expect(await rowCount(sql, relation), relation).toBe(0);
          }
          for (const relation of PRESERVED) {
            expect(await rowCount(sql, relation), relation).toBe(
              preservedBefore[relation],
            );
          }
          expect(
            await live.verifier.authRequest(
              projectId,
              branch.branchId,
              "sign-in",
              caseEmail,
            ),
          ).not.toBe(200);
          expect(
            await live.verifier.authRequest(
              projectId,
              branch.branchId,
              "sign-up",
              caseEmail,
            ),
          ).toBe(200);

          // The parent and production branches were never touched.
          expect(await labels(devSql)).toEqual([devMarker]);
          expect(await rowCount(devSql, "public.profiles")).toBe(2);
          expect(await rowCount(devSql, "public.events")).toBe(50);
          const [{ n: devUsers }] = (await devSql.query(
            `select count(*)::int as n from neon_auth."user" where email = $1`,
            [devEmail],
          )) as Array<{ n: number }>;
          expect(devUsers).toBe(1);
          expect(
            await live.verifier.authRequest(
              projectId,
              devId,
              "sign-in",
              devEmail,
            ),
          ).toBe(200);
          expect(await labels(mainSql)).toEqual([]);
        } finally {
          expect(await release(lease)).toBe(true);
        }
        await eventuallyAbsent(branch.branchId);
      });
    },
    900_000,
  );

  it.runIf(canCreateProjects)(
    "recovers branches left by a dead run on the next startup sweep (simulated restart)",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("isolation:simulated-restart-recovery", async () => {
        // 1. A sandboxed run dies holding its lease. A real restart loses the
        //    in-memory owner registry; retire() models exactly that loss while
        //    the durable SQLite record stays.
        const { lease, ownerId } = await acquire("dead-run");
        held.delete(lease);
        lease.retire();
        expect(await trackedRunTestBranchId(ownerId)).toBe(
          lease.branch.branchId,
        );
        expect(
          await live.verifier.branchExists(projectId, lease.branch.branchId),
        ).toBe(true);

        // 2. A recording dies after pointing the app's real env at its branch.
        const appBefore = await live.appRow(appId);
        const devHost = await live.verifier.endpointHost(projectId, devId);
        expect(databaseHost((await live.appEnv(appDir)).DATABASE_URL)).toBe(
          devHost,
        );
        const recording = await createTempTestBranch(appBefore, {
          cleanupOnly: false,
        });
        await updateNeonEnvVars({
          appPath: appDir,
          connectionUri: recording.databaseUrl,
          neonAuthBaseUrl: recording.neonAuthBaseUrl,
          frameworkType: detectFrameworkType(appDir),
          cookieSecret: recording.cookieSecret,
          preserveExistingAuth: !recording.neonAuthBaseUrl,
        });
        expect((await live.appRow(appId)).neonTestBranchId).toBe(
          recording.branchId,
        );
        expect(databaseHost((await live.appEnv(appDir)).DATABASE_URL)).toBe(
          databaseHost(recording.databaseUrl),
        );

        // 3. Startup recovery.
        await reconcileOrphanTestBranches();

        await eventuallyAbsent(lease.branch.branchId);
        await eventuallyAbsent(recording.branchId);
        expect(await trackedRunTestBranchId(ownerId)).toBeNull();
        expect(await cleanupRows()).toEqual([]);
        expect((await live.appRow(appId)).neonTestBranchId).toBeNull();
        // The real env is back on development, Auth included.
        const env = await live.appEnv(appDir);
        expect(databaseHost(env.DATABASE_URL)).toBe(devHost);
        if (env.NEON_AUTH_BASE_URL) {
          expect(env.NEON_AUTH_BASE_URL).toBe(
            await live.verifier.authBaseUrl(projectId, devId),
          );
        }
        expect(
          live.verifier.describeTree(await live.verifier.branches(projectId)),
        ).toEqual([
          { name: "development", parent: null },
          { name: "main", parent: null },
          { name: "preview", parent: "development" },
        ]);
      });
    },
    900_000,
  );

  // Keep last: fills the project to its branch limit.
  it.runIf(canCreateProjects)(
    "queues runs at the real branch limit, cancels waiters cleanly, and reports a blocked limit",
    async ({ skip }) => {
      live.assertBudget(10 * 60_000);
      let limit: number | undefined;
      try {
        const { data } = await live.verifier.client.getCurrentUserInfo();
        limit = data.branches_limit;
      } catch (error) {
        live.metrics.event("isolation-capacity-quota-unknown", {
          status: httpStatus(error),
        });
      }
      if (!limit || limit > CAMPAIGN_LIMITS.maxBranchesPerProject) {
        live.metrics.event("isolation-capacity-skipped", {
          limit: limit ?? null,
        });
        skip(
          `NOT COVERED: the account's branch limit (${limit ?? "unknown"}) cannot be reached within the campaign cap of ${CAMPAIGN_LIMITS.maxBranchesPerProject} branches per project`,
        );
      }
      const branchLimit = limit!;
      await live.scenario("isolation:capacity", async () => {
        const fillers: string[] = [];
        const addFiller = async () => {
          // Fixture only: wait out a slot still being freed by an earlier delete.
          const deadline = Date.now() + 120_000;
          for (;;) {
            try {
              const { data } = await live.setup(() =>
                live.fixtureClient.createProjectBranch(projectId, {
                  // No endpoint: fillers must not count against the compute budget.
                  branch: {
                    name: `dyad-live-filler-${fillers.length + 1}`,
                    parent_id: devId,
                  },
                }),
              );
              fillers.push(data.branch.id);
              await live.verifier.waitForOperations(projectId);
              return;
            } catch (error) {
              if (!isNeonBranchCapacityError(error) || Date.now() > deadline) {
                throw error;
              }
              await sleep(5_000);
            }
          }
        };
        const leases: Lease[] = [];
        try {
          // Leave exactly one free slot.
          const existing = (await live.verifier.branches(projectId)).length;
          for (let i = existing; i < branchLimit - 1; i++) await addFiller();
          expect((await live.verifier.branches(projectId)).length).toBe(
            branchLimit - 1,
          );

          // L1 takes the last slot.
          const first = await acquire("cap-1");
          leases.push(first.lease);

          // L2 hits the limit and waits on L1.
          const second = capacityTracker();
          const secondOwner = owner("cap-2");
          const secondAcquire = acquireNeonTestBranch(
            await live.appRow(appId),
            appDir,
            secondOwner,
            { onCapacity: second.onCapacity },
          );
          const secondSettled = secondAcquire.then((lease) => {
            leases.push(lease);
            held.add(lease);
            return lease;
          });
          let secondWaited = false;
          await within(
            Promise.race([
              second.when("waiting").then(() => {
                secondWaited = true;
              }),
              secondSettled.then(() => {
                if (!secondWaited) {
                  throw new Error(
                    "second run got a branch while the project was full",
                  );
                }
              }),
            ]),
            120_000,
            "a capacity wait for the second run",
          );

          // L3 queues behind it; cancelling it rejects and creates nothing.
          const third = capacityTracker();
          const thirdOwner = owner("cap-3");
          const abort = new AbortController();
          const thirdAcquire = acquireNeonTestBranch(
            await live.appRow(appId),
            appDir,
            thirdOwner,
            { signal: abort.signal, onCapacity: third.onCapacity },
          );
          // Asserted below; this only keeps an early test failure from also
          // surfacing as an unhandled rejection.
          thirdAcquire.catch(() => {});
          await within(
            third.when("waiting"),
            30_000,
            "a per-run wait notice for the queued run",
          );
          abort.abort(new DOMException("cancelled by test", "AbortError"));
          await expect(
            within(thirdAcquire, 30_000, "cancellation"),
          ).rejects.toBeTruthy();
          expect(await trackedRunTestBranchId(thirdOwner)).toBeNull();
          expect((await live.verifier.branches(projectId)).length).toBe(
            branchLimit,
          );

          // Releasing L1 lets L2 through.
          leases.splice(leases.indexOf(first.lease), 1);
          expect(await release(first.lease)).toBe(true);
          const start = Date.now();
          const secondLease = await within(
            secondSettled,
            180_000,
            "the waiting run to proceed",
          );
          live.metrics.event("isolation-capacity-handoff", {
            ms: Date.now() - start,
          });
          expect(second.statuses).toContain("waiting");
          expect(second.statuses.at(-1)).toBeUndefined();
          expect(await trackedRunTestBranchId(secondOwner)).toBe(
            secondLease.branch.branchId,
          );
          expect(
            await live.verifier.branchExists(
              projectId,
              secondLease.branch.branchId,
            ),
          ).toBe(true);

          // With no live owner left and the project full, the run is blocked.
          leases.splice(leases.indexOf(secondLease), 1);
          expect(await release(secondLease)).toBe(true);
          await eventuallyAbsent(secondLease.branch.branchId);
          await addFiller();
          const blocked = capacityTracker();
          const blockedOwner = owner("cap-4");
          await expect(
            within(
              acquireNeonTestBranch(
                await live.appRow(appId),
                appDir,
                blockedOwner,
                {
                  onCapacity: blocked.onCapacity,
                },
              ),
              120_000,
              "a blocked verdict",
            ),
          ).rejects.toMatchObject({ kind: DyadErrorKind.Precondition });
          expect(blocked.statuses).toContain("blocked");
          expect(await trackedRunTestBranchId(blockedOwner)).toBeNull();
        } finally {
          for (const lease of leases) await release(lease).catch(() => false);
          for (const fillerId of fillers) {
            await deleteBranchVerified(
              live.fixtureClient,
              projectId,
              fillerId,
            ).catch((error) =>
              live.metrics.event("isolation-filler-delete-failed", {
                status: httpStatus(error),
              }),
            );
          }
        }
        expect(await cleanupRows()).toEqual([]);
        const tree = await live.verifier.branches(projectId);
        expect(tree.filter((b) => b.name.startsWith("dyad-test-"))).toEqual([]);
        expect(tree).toHaveLength(3);
      });
    },
    1_200_000,
  );
});
