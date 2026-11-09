// Live P0 project/branch lifecycle and P1 external-change/credential checks.
//
// One fixture project (main, a child `development`, a `preview` under it)
// is linked through Dyad; one Dyad-created project serves as "another
// project" and the unlink/relink subject. Distinct markers on main and
// development turn any mis-targeting into an assertion failure.
//
// Runs only under the campaign supervisor (npm run test:neon:live).
import { createHash } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { liveNeonGate } from "@/testing/live_neon/config";

vi.mock("@/neon_admin/neon_management_client", async (importOriginal) =>
  (await import("@/testing/live_neon/product_client")).mockNeonManagementClient(
    await importOriginal<
      typeof import("@/neon_admin/neon_management_client")
    >(),
  ),
);

import { DyadErrorKind, isDyadError } from "@/errors/dyad_error";
import { ipc } from "@/ipc/types";
import { writeSettings } from "@/main/settings";
import { executeSqlTool } from "@/pro/main/ipc/handlers/local_agent/tools/execute_sql";
import type { AgentContext } from "@/pro/main/ipc/handlers/local_agent/tools/types";
import {
  databaseHost,
  setupLiveNeonHarness,
  type FixtureProject,
  type LiveNeonHarness,
} from "@/testing/live_neon/live_harness";
import { createJournaledNeonClient } from "@/testing/live_neon/live_client";
import {
  deleteBranchVerified,
  deleteProjectVerified,
} from "@/testing/live_neon/neon_ops";
import { setProductNeonClient } from "@/testing/live_neon/product_client";
import { assertRealNeonIds } from "@/testing/live_neon/verifier";

const gate = liveNeonGate();
const canCreateProjects =
  gate.enabled && gate.config.keyMode === "organization";

type AppRow = Awaited<ReturnType<LiveNeonHarness["appRow"]>>;

/** The subset of the agent context execute_sql reads, built as local_agent_handler does. */
function sqlToolContext(app: AppRow): AgentContext {
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

async function captureError(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail, but it succeeded");
}

function errorKind(error: unknown): string {
  return isDyadError(error)
    ? error.kind
    : `unclassified:${(error as Error)?.name ?? typeof error}`;
}

describe.runIf(gate.enabled)(
  "Neon project and branch lifecycle (live Neon API)",
  () => {
    let live: LiveNeonHarness;

    /** App 1, linked to the fixture project by the first test. */
    let fixture: FixtureProject | undefined;
    let app1: { appId: number; appDir: string } | undefined;
    /** Markers each branch must hold, and nothing else. */
    const expectedMarkers = new Map<string, Set<string>>();

    beforeAll(async () => {
      live = await setupLiveNeonHarness({ suite: "lifecycle" });
    }, 120_000);

    afterEach(() => {
      live?.faults.clear();
      writeSettings({ enableNeonBranchProtection: true });
    });

    afterAll(async () => {
      await live?.dispose();
    }, 300_000);

    /** Credential-free view of the app's Neon state: row IDs, env shape and a digest. */
    async function snapshot(appId: number, appDir: string) {
      const row = await live.appRow(appId);
      const env = await live.appEnv(appDir);
      const digest = createHash("sha256")
        .update(
          JSON.stringify(
            Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
          ),
        )
        .digest("hex");
      return {
        row: {
          neonProjectId: row.neonProjectId,
          neonDevelopmentBranchId: row.neonDevelopmentBranchId,
          neonPreviewBranchId: row.neonPreviewBranchId,
          neonActiveBranchId: row.neonActiveBranchId,
          selectedDatabaseBranchType: row.selectedDatabaseBranchType,
        },
        dbHost: databaseHost(env.DATABASE_URL),
        authBaseUrl: env.NEON_AUTH_BASE_URL,
        cookieSecretDigest: env.NEON_AUTH_COOKIE_SECRET
          ? createHash("sha256")
              .update(env.NEON_AUTH_COOKIE_SECRET)
              .digest("hex")
          : undefined,
        envDigest: digest,
      };
    }

    async function seed(projectId: string, branchId: string, label: string) {
      await live.seedMarker(projectId, branchId, label);
      const set = expectedMarkers.get(branchId) ?? new Set<string>();
      set.add(label);
      expectedMarkers.set(branchId, set);
    }

    async function expectMarkersExact(projectId: string, branchId: string) {
      expect(await live.readMarkers(projectId, branchId)).toEqual(
        [...(expectedMarkers.get(branchId) ?? [])].sort(),
      );
    }

    /** Writes a marker through Dyad's execute_sql tool on whatever branch the app targets. */
    async function writeMarkerViaDyad(appId: number, label: string) {
      const app = await live.appRow(appId);
      const result = await executeSqlTool.execute(
        { query: `insert into dyad_live_marker(label) values ('${label}')` },
        sqlToolContext(app),
      );
      expect(result).toMatch(/^Successfully executed SQL query/);
      const target = app.neonActiveBranchId ?? app.neonDevelopmentBranchId!;
      const set = expectedMarkers.get(target) ?? new Set<string>();
      set.add(label);
      expectedMarkers.set(target, set);
    }

    /** Env and row agree with the remote branch the app claims to target. */
    async function expectTargets(
      appId: number,
      appDir: string,
      branchId: string,
    ) {
      const state = await snapshot(appId, appDir);
      expect(state.row.neonActiveBranchId).toBe(branchId);
      const projectId = state.row.neonProjectId!;
      const host = await live.verifier.endpointHost(projectId, branchId);
      assertRealNeonIds({ hosts: [host, state.dbHost] });
      expect(state.dbHost).toBe(host);
      expect(state.authBaseUrl).toBe(
        await live.verifier.authBaseUrl(projectId, branchId),
      );
      return state;
    }

    /** Links app 1 to the fixture project once; later tests reuse it. */
    async function linkedFixture() {
      if (fixture && app1) return { fixture, app1 };
      fixture = await live.createFixtureProject("lifecycle", {
        development: true,
        preview: true,
      });
      // Seeded after every branch exists, so each branch's markers are its own.
      await seed(
        fixture.projectId,
        fixture.mainBranchId,
        live.marker("main-seed"),
      );
      await seed(
        fixture.projectId,
        fixture.developmentBranchId!,
        live.marker("dev-seed"),
      );
      const created = await live.createGitApp("lifecycle");
      app1 = { appId: created.appId, appDir: created.appDir };
      const result = await ipc.neon.setAppProject({
        appId: app1.appId,
        projectId: fixture.projectId,
      });
      expect(result.success).toBe(true);
      if (result.warning) {
        live.metrics.event("link-warning", {
          warning: live.redact(result.warning),
        });
      }
      return { fixture, app1 };
    }

    /** Puts app 1 back on development (always allowed) if a test left it elsewhere. */
    async function resetToDevelopment() {
      const { fixture, app1 } = await linkedFixture();
      const row = await live.appRow(app1.appId);
      if (row.neonActiveBranchId !== fixture.developmentBranchId) {
        await ipc.neon.setActiveBranch({
          appId: app1.appId,
          branchId: fixture.developmentBranchId!,
        });
      }
    }

    it.runIf(canCreateProjects)(
      "links an existing project to its development branch, never production",
      async () => {
        await live.scenario("lifecycle:link-existing", async () => {
          live.assertBudget(5 * 60_000);
          const { fixture, app1 } = await linkedFixture();
          const devId = fixture.developmentBranchId!;

          const row = await live.appRow(app1.appId);
          expect(row.neonProjectId).toBe(fixture.projectId);
          expect(row.neonDevelopmentBranchId).toBe(devId);
          expect(row.neonPreviewBranchId).toBe(fixture.previewBranchId);
          expect(row.neonActiveBranchId).toBe(devId);
          assertRealNeonIds({
            projectId: row.neonProjectId,
            branchIds: [row.neonDevelopmentBranchId, row.neonPreviewBranchId],
          });

          // Linking does not reshape the user's project.
          expect(await live.verifier.tree(fixture.projectId)).toEqual([
            { name: "development", parent: "main" },
            { name: "main", parent: null },
            { name: "preview", parent: "development" },
          ]);
          await expectTargets(app1.appId, app1.appDir, devId);

          // Dyad's SQL lands on development only.
          await writeMarkerViaDyad(
            app1.appId,
            live.marker("dyad-sql-after-link"),
          );
          await expectMarkersExact(fixture.projectId, devId);
          await expectMarkersExact(fixture.projectId, fixture.mainBranchId);
          expect(
            await live.readMarkers(fixture.projectId, fixture.previewBranchId!),
          ).toEqual([]);
        });
      },
      600_000,
    );

    it.runIf(canCreateProjects)(
      "switches between development and production repeatedly, guarded by branch protection",
      async () => {
        await live.scenario("lifecycle:switch-repeatedly", async () => {
          live.assertBudget(10 * 60_000);
          await resetToDevelopment();
          const { fixture, app1 } = await linkedFixture();
          const devId = fixture.developmentBranchId!;
          const mainId = fixture.mainBranchId;

          // Protection on: production is refused and nothing changes.
          writeSettings({ enableNeonBranchProtection: true });
          const before = await snapshot(app1.appId, app1.appDir);
          const refused = await captureError(
            ipc.neon.setActiveBranch({ appId: app1.appId, branchId: mainId }),
          );
          expect(errorKind(refused)).toBe(DyadErrorKind.Precondition);
          expect((refused as Error).message).toMatch(/production/i);
          expect(await snapshot(app1.appId, app1.appDir)).toEqual(before);

          // Protection off: switch back and forth; every write follows the switch.
          writeSettings({ enableNeonBranchProtection: false });
          const secrets = { dev: new Set<string>(), main: new Set<string>() };
          for (let round = 1; round <= 3; round++) {
            await ipc.neon.setActiveBranch({
              appId: app1.appId,
              branchId: mainId,
            });
            const onMain = await expectTargets(app1.appId, app1.appDir, mainId);
            // Production active clears any stale deploy-branch pick.
            expect(onMain.row.selectedDatabaseBranchType).toBeNull();
            if (onMain.cookieSecretDigest)
              secrets.main.add(onMain.cookieSecretDigest);
            await writeMarkerViaDyad(
              app1.appId,
              live.marker(`dyad-sql-main-${round}`),
            );

            await ipc.neon.setActiveBranch({
              appId: app1.appId,
              branchId: devId,
            });
            const onDev = await expectTargets(app1.appId, app1.appDir, devId);
            if (onDev.cookieSecretDigest)
              secrets.dev.add(onDev.cookieSecretDigest);
            await writeMarkerViaDyad(
              app1.appId,
              live.marker(`dyad-sql-dev-${round}`),
            );
          }
          await expectMarkersExact(fixture.projectId, mainId);
          await expectMarkersExact(fixture.projectId, devId);
          // Cookie secrets are stable per branch and never shared across branches.
          expect(secrets.dev.size).toBeLessThanOrEqual(1);
          expect(secrets.main.size).toBeLessThanOrEqual(1);
          if (secrets.dev.size && secrets.main.size) {
            expect([...secrets.dev][0] === [...secrets.main][0]).toBe(false);
          }

          // Back on development with protection restored, production is refused again.
          writeSettings({ enableNeonBranchProtection: true });
          const afterRounds = await snapshot(app1.appId, app1.appDir);
          expect(
            errorKind(
              await captureError(
                ipc.neon.setActiveBranch({
                  appId: app1.appId,
                  branchId: mainId,
                }),
              ),
            ),
          ).toBe(DyadErrorKind.Precondition);
          expect(await snapshot(app1.appId, app1.appDir)).toEqual(afterRounds);
        });
      },
      900_000,
    );

    it.runIf(canCreateProjects)(
      "refuses preview and deleted branches without falling back to production",
      async () => {
        await live.scenario("lifecycle:refuse-bad-targets", async () => {
          live.assertBudget(10 * 60_000);
          await resetToDevelopment();
          const { fixture, app1 } = await linkedFixture();
          const devId = fixture.developmentBranchId!;
          const mainId = fixture.mainBranchId;

          // Preview is a rollback snapshot, never a working branch.
          let before = await snapshot(app1.appId, app1.appDir);
          const preview = await captureError(
            ipc.neon.setActiveBranch({
              appId: app1.appId,
              branchId: fixture.previewBranchId!,
            }),
          );
          expect(errorKind(preview)).toBe(DyadErrorKind.Precondition);
          expect(await snapshot(app1.appId, app1.appDir)).toEqual(before);

          // (a) A target deleted out of band before Dyad switches to it.
          const { data: scratch } = await live.setup(() =>
            live.fixtureClient.createProjectBranch(fixture.projectId, {
              branch: { name: "scratch-deleted", parent_id: mainId },
            }),
          );
          await live.verifier.waitForOperations(fixture.projectId);
          expect(
            (
              await deleteBranchVerified(
                live.fixtureClient,
                fixture.projectId,
                scratch.branch.id,
              )
            ).deleted,
          ).toBe(true);
          live.journal.append({
            type: "deleted",
            kind: "branch",
            projectId: fixture.projectId,
            branchId: scratch.branch.id,
            actor: "fixture",
            verified: true,
          });
          before = await snapshot(app1.appId, app1.appDir);
          const deletedTarget = await captureError(
            ipc.neon.setActiveBranch({
              appId: app1.appId,
              branchId: scratch.branch.id,
            }),
          );
          live.metrics.event("deleted-target-switch", {
            kind: errorKind(deletedTarget),
          });
          expect(isDyadError(deletedTarget)).toBe(true);
          expect(await snapshot(app1.appId, app1.appDir)).toEqual(before);

          // (b) The ACTIVE branch is deleted out of band: SQL must fail, not
          // fall back to development or production.
          const { data: active } = await live.setup(() =>
            live.fixtureClient.createProjectBranch(fixture.projectId, {
              endpoints: [{ type: "read_write" as never }],
              branch: { name: "scratch-active", parent_id: devId },
            }),
          );
          await live.verifier.waitForOperations(fixture.projectId);
          await ipc.neon.setActiveBranch({
            appId: app1.appId,
            branchId: active.branch.id,
          });
          // A non-default, non-development branch is targeted as "production" type.
          expect((await live.appRow(app1.appId)).neonActiveBranchId).toBe(
            active.branch.id,
          );
          expect(
            (
              await deleteBranchVerified(
                live.fixtureClient,
                fixture.projectId,
                active.branch.id,
              )
            ).deleted,
          ).toBe(true);
          live.journal.append({
            type: "deleted",
            kind: "branch",
            projectId: fixture.projectId,
            branchId: active.branch.id,
            actor: "fixture",
            verified: true,
          });
          before = await snapshot(app1.appId, app1.appDir);
          const orphanedSql = await captureError(
            executeSqlTool.execute(
              {
                query: `insert into dyad_live_marker(label) values ('${live.marker("must-not-land")}')`,
              },
              sqlToolContext(await live.appRow(app1.appId)),
            ),
          );
          live.metrics.event("deleted-active-branch-sql", {
            kind: errorKind(orphanedSql),
          });
          expect(isDyadError(orphanedSql)).toBe(true);
          expect(await snapshot(app1.appId, app1.appDir)).toEqual(before);
          await expectMarkersExact(fixture.projectId, devId);
          await expectMarkersExact(fixture.projectId, mainId);

          // Recoverable: switching back to development works.
          await ipc.neon.setActiveBranch({
            appId: app1.appId,
            branchId: devId,
          });
          await expectTargets(app1.appId, app1.appDir, devId);
        });
      },
      900_000,
    );

    it.runIf(canCreateProjects)(
      "refuses another project's branch, and unlinking keeps the remote project for a clean relink",
      async () => {
        await live.scenario(
          "lifecycle:foreign-branch-unlink-relink",
          async () => {
            live.assertBudget(10 * 60_000);
            await resetToDevelopment();
            const { fixture, app1 } = await linkedFixture();

            const app2 = await live.createGitApp("lifecycle-other");
            const created = await ipc.neon.createProject({
              name: live.projectName("lifecycle-other"),
              appId: app2.appId,
            });
            const otherProjectId = created.id;
            try {
              const linked = await snapshot(app2.appId, app2.appDir);
              const otherDevId = linked.row.neonDevelopmentBranchId!;
              const otherPreviewId = linked.row.neonPreviewBranchId!;

              // Another project's branch is refused for app 1.
              const before = await snapshot(app1.appId, app1.appDir);
              const foreign = await captureError(
                ipc.neon.setActiveBranch({
                  appId: app1.appId,
                  branchId: otherDevId,
                }),
              );
              live.metrics.event("foreign-branch-switch", {
                kind: errorKind(foreign),
              });
              expect(isDyadError(foreign)).toBe(true);
              expect(await snapshot(app1.appId, app1.appDir)).toEqual(before);

              // Unlink: local state cleared, Neon env vars gone, remote project kept.
              await ipc.neon.unsetAppProject({ appId: app2.appId });
              const unlinked = await snapshot(app2.appId, app2.appDir);
              expect(unlinked.row).toEqual({
                neonProjectId: null,
                neonDevelopmentBranchId: null,
                neonPreviewBranchId: null,
                neonActiveBranchId: null,
                selectedDatabaseBranchType: null,
              });
              const env = await live.appEnv(app2.appDir);
              expect(
                Object.keys(env).filter((k) => k.startsWith("NEON_AUTH_")),
              ).toEqual([]);
              expect(env.DATABASE_URL ?? "").not.toMatch(/\.neon\.tech/);
              expect(env.POSTGRES_URL ?? "").not.toMatch(/\.neon\.tech/);
              expect(await live.verifier.projectExists(otherProjectId)).toBe(
                true,
              );
              expect(await live.verifier.tree(otherProjectId)).toEqual([
                { name: "development", parent: null },
                { name: "main", parent: null },
                { name: "preview", parent: "development" },
              ]);

              // Relink: the same branches, targets restored.
              await ipc.neon.setAppProject({
                appId: app2.appId,
                projectId: otherProjectId,
              });
              const relinked = await snapshot(app2.appId, app2.appDir);
              expect(relinked.row.neonProjectId).toBe(otherProjectId);
              expect(relinked.row.neonDevelopmentBranchId).toBe(otherDevId);
              expect(relinked.row.neonPreviewBranchId).toBe(otherPreviewId);
              await expectTargets(app2.appId, app2.appDir, otherDevId);

              // App 1 never moved.
              await expectTargets(
                app1.appId,
                app1.appDir,
                fixture.developmentBranchId!,
              );
            } finally {
              // Free its computes for later suites; teardown would retry otherwise.
              const result = await deleteProjectVerified(
                live.verifier.client,
                otherProjectId,
              );
              if (result.deleted) {
                live.journal.append({
                  type: "deleted",
                  kind: "project",
                  projectId: otherProjectId,
                  actor: "verifier",
                  verified: true,
                });
              }
            }
          },
        );
      },
      900_000,
    );

    it.runIf(canCreateProjects)(
      "fails closed with an invalid API key: classified errors, no state change",
      async () => {
        await live.scenario("lifecycle:invalid-api-key", async () => {
          live.assertBudget(5 * 60_000);
          await resetToDevelopment();
          const { fixture, app1 } = await linkedFixture();
          writeSettings({ enableNeonBranchProtection: false });
          const before = await snapshot(app1.appId, app1.appDir);

          const invalidClient = createJournaledNeonClient({
            config: live.config,
            journal: live.journal,
            actor: "product",
            budget: live.managementBudget,
            metrics: live.metrics,
            apiKey: `napi_${"x0".repeat(20)}`,
          });
          setProductNeonClient({
            client: () => invalidClient,
            orgId: () => live.config.orgId!,
          });
          const outcomes: Record<string, string> = {};
          try {
            outcomes.getProject = errorKind(
              await captureError(ipc.neon.getProject({ appId: app1.appId })),
            );
            outcomes.listProjects = errorKind(
              await captureError(ipc.neon.listProjects()),
            );
            outcomes.setActiveBranch = errorKind(
              await captureError(
                ipc.neon.setActiveBranch({
                  appId: app1.appId,
                  branchId: fixture.mainBranchId,
                }),
              ),
            );
            outcomes.executeSql = errorKind(
              await captureError(
                executeSqlTool.execute(
                  {
                    query: `insert into dyad_live_marker(label) values ('${live.marker("bad-key")}')`,
                  },
                  sqlToolContext(await live.appRow(app1.appId)),
                ),
              ),
            );
          } finally {
            setProductNeonClient({
              client: () => live.productClient,
              orgId: () => live.config.orgId!,
            });
          }
          live.metrics.event("invalid-api-key", outcomes);

          // Hard invariants: nothing moved, nothing written.
          expect(await snapshot(app1.appId, app1.appDir)).toEqual(before);
          await expectMarkersExact(
            fixture.projectId,
            fixture.developmentBranchId!,
          );
          await expectMarkersExact(fixture.projectId, fixture.mainBranchId);
          // Every surface reports a classified error (a raw SDK error is a finding).
          for (const [surface, kind] of Object.entries(outcomes)) {
            expect
              .soft(kind, `${surface} should throw a classified DyadError`)
              .not.toMatch(/^unclassified:/);
          }
          // The real key still works afterwards.
          await expectTargets(
            app1.appId,
            app1.appDir,
            fixture.developmentBranchId!,
          );
        });
      },
      600_000,
    );
  },
);
