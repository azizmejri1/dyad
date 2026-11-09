// Fault campaign: live Neon with injected transport faults.
//
// Successful requests reach real Neon; the rules below fail, hold or drop
// specific requests from Dyad's own client (Management API) or the
// process-wide SQL fetch. Every result from this file must be reported as
// "live Neon with injected transport faults", separately from natural
// provider behaviour. Each scenario asserts that the rule actually fired.
//
// Runs only under the campaign supervisor (npm run test:neon:live).
import fs from "node:fs";
import path from "node:path";
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
  type LiveNeonHarness,
} from "@/testing/live_neon/live_harness";
import {
  deleteProjectVerified,
  listAllProjects,
} from "@/testing/live_neon/neon_ops";

const gate = liveNeonGate();
const canCreateProjects =
  gate.enabled && gate.config.keyMode === "organization";

type AppRow = Awaited<ReturnType<LiveNeonHarness["appRow"]>>;

const BRANCHES_PATH = /^\/projects\/[^/]+\/branches$/;
const CONNECTION_URI = /^\/projects\/[^/]+\/connection_uri$/;
const SQL_PATH = /^\/sql$/;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

async function settle<T>(
  operation: Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await operation };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorKind(error: unknown): string {
  return isDyadError(error)
    ? error.kind
    : `unclassified:${(error as Error)?.name ?? typeof error}`;
}

const NEON_ROW_NULL = {
  neonProjectId: null,
  neonDevelopmentBranchId: null,
  neonPreviewBranchId: null,
  neonActiveBranchId: null,
  selectedDatabaseBranchType: null,
};

describe.runIf(gate.enabled)(
  "Neon fault campaign (live Neon with injected transport faults)",
  () => {
    let live: LiveNeonHarness;
    /** App A and the Dyad-created project it is linked to; reused by later scenarios. */
    let primary:
      | { appId: number; appDir: string; projectId: string }
      | undefined;

    beforeAll(async () => {
      live = await setupLiveNeonHarness({ suite: "faults" });
    }, 120_000);

    afterEach(() => {
      live?.faults.clear();
      writeSettings({ enableNeonBranchProtection: true });
    });

    afterAll(async () => {
      await live?.dispose();
    }, 300_000);

    async function snapshot(appId: number, appDir: string) {
      const row = await live.appRow(appId);
      const env = await live.appEnv(appDir);
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
        envFileExists: fs.existsSync(path.join(appDir, ".env.local")),
        envDigest: createHash("sha256")
          .update(
            JSON.stringify(
              Object.entries(env).sort(([a], [b]) => a.localeCompare(b)),
            ),
          )
          .digest("hex"),
      };
    }

    /** The tree Dyad's createProject must leave, with nothing duplicated. */
    async function expectDyadTree(projectId: string) {
      expect(await live.verifier.tree(projectId)).toEqual([
        { name: "development", parent: null },
        { name: "main", parent: null },
        { name: "preview", parent: "development" },
      ]);
    }

    /** The project a create request with this exact name produced, per the journal. */
    function journaledProjectId(name: string): string | undefined {
      return [...live.journal.state().projects.values()].find(
        (p) => p.name === name,
      )?.projectId;
    }

    async function waitForProjectAbsence(
      projectId: string,
      timeoutMs = 60_000,
    ) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (!(await live.verifier.projectExists(projectId))) return true;
        await sleep(3_000);
      }
      return !(await live.verifier.projectExists(projectId));
    }

    async function primaryProject() {
      if (primary) return primary;
      // Fallback when the 423 scenario did not produce one: plain create.
      const app = await live.createGitApp("faults-primary");
      const created = await ipc.neon.createProject({
        name: live.projectName("faults-primary"),
        appId: app.appId,
      });
      primary = { appId: app.appId, appDir: app.appDir, projectId: created.id };
      return primary;
    }

    it.runIf(canCreateProjects)(
      "createProject recovers from a 423 on the development branch create (injected fault)",
      async () => {
        await live.scenario("faults:423-on-branch-create", async () => {
          live.assertBudget(5 * 60_000);
          const app = await live.createGitApp("faults-423");
          const handle = live.faults.add({
            id: "423-dev-branch",
            transport: "management",
            method: "POST",
            path: BRANCHES_PATH,
            action: { kind: "status", status: 423 },
          });
          const created = await ipc.neon.createProject({
            name: live.projectName("faults-423"),
            appId: app.appId,
          });
          expect(handle.hits()).toBe(1);
          live.metrics.event("first-attempt-failure", {
            op: "POST /projects/{id}/branches",
            status: 423,
            eventualOutcome: "succeeded",
          });
          primary = {
            appId: app.appId,
            appDir: app.appDir,
            projectId: created.id,
          };
          // The rejected attempt never reached Neon, so nothing is duplicated.
          await expectDyadTree(created.id);
          const row = await live.appRow(app.appId);
          expect(row.neonProjectId).toBe(created.id);
          expect(row.neonActiveBranchId).toBe(row.neonDevelopmentBranchId);
        });
      },
      600_000,
    );

    it.runIf(canCreateProjects)(
      "setAppProject fails closed on injected 401 and 403, then links cleanly",
      async () => {
        await live.scenario("faults:401-403-on-link", async () => {
          live.assertBudget(5 * 60_000);
          const { projectId } = await primaryProject();
          const app = await live.createGitApp("faults-link");
          const before = await snapshot(app.appId, app.appDir);
          expect(before.row).toEqual(NEON_ROW_NULL);

          for (const status of [401, 403]) {
            const handle = live.faults.add({
              id: `${status}-list-branches`,
              transport: "management",
              method: "GET",
              path: BRANCHES_PATH,
              action: { kind: "status", status },
            });
            const error = await captureError(
              ipc.neon.setAppProject({ appId: app.appId, projectId }),
            );
            expect(handle.hits()).toBe(1);
            live.metrics.event("link-auth-failure", {
              status,
              kind: errorKind(error),
            });
            expect(isDyadError(error)).toBe(true);
            expect(await snapshot(app.appId, app.appDir)).toEqual(before);
            live.faults.clear();
          }

          // Nothing stale blocks a later attempt.
          await ipc.neon.setAppProject({ appId: app.appId, projectId });
          const linked = await live.appRow(app.appId);
          expect(linked.neonProjectId).toBe(projectId);
          await ipc.neon.unsetAppProject({ appId: app.appId });
        });
      },
      600_000,
    );

    it.runIf(canCreateProjects)(
      "a 429 with Retry-After during a branch switch leaves the app fully switched or fully reverted",
      async () => {
        await live.scenario("faults:429-on-connection-uri", async () => {
          live.assertBudget(5 * 60_000);
          const { appId, appDir, projectId } = await primaryProject();
          writeSettings({ enableNeonBranchProtection: false });
          const row = await live.appRow(appId);
          const devId = row.neonDevelopmentBranchId!;
          const mainId = (await live.verifier.branches(projectId)).find(
            (b) => b.default,
          )!.id;
          expect(row.neonActiveBranchId).toBe(devId);
          const before = await snapshot(appId, appDir);

          const handle = live.faults.add({
            id: "429-connection-uri",
            transport: "management",
            method: "GET",
            path: CONNECTION_URI,
            action: { kind: "status", status: 429, retryAfterSeconds: 2 },
          });
          const outcome = await settle(
            ipc.neon.setActiveBranch({ appId, branchId: mainId }),
          );
          expect(handle.hits()).toBe(1);
          live.metrics.event("switch-under-429", {
            retriedToSuccess: outcome.ok,
            kind: outcome.ok ? undefined : errorKind(outcome.error),
          });

          const after = await snapshot(appId, appDir);
          if (outcome.ok) {
            expect(after.row.neonActiveBranchId).toBe(mainId);
            expect(after.dbHost).toBe(
              await live.verifier.endpointHost(projectId, mainId),
            );
            // Put it back for later scenarios.
            await ipc.neon.setActiveBranch({ appId, branchId: devId });
          } else {
            expect(isDyadError(outcome.error)).toBe(true);
            // Fully reverted: row and .env.local exactly as before.
            expect(after).toEqual(before);
          }
        });
      },
      600_000,
    );

    it.runIf(canCreateProjects)(
      "a held switch admits the next one only afterwards; the newest target wins",
      async () => {
        await live.scenario("faults:gated-overlapping-switches", async () => {
          live.assertBudget(5 * 60_000);
          const { appId, appDir, projectId } = await primaryProject();
          writeSettings({ enableNeonBranchProtection: false });
          const devId = (await live.appRow(appId)).neonDevelopmentBranchId!;
          const mainId = (await live.verifier.branches(projectId)).find(
            (b) => b.default,
          )!.id;

          // Hold the first switch (to production) mid-flight at its connection lookup.
          const gateHandle = live.faults.add({
            id: "gate-first-switch",
            transport: "management",
            method: "GET",
            path: CONNECTION_URI,
            action: { kind: "gate" },
          });
          const first = settle(
            ipc.neon.setActiveBranch({ appId, branchId: mainId }),
          );
          await gateHandle.reached;
          // Issued while the first is held; the app operation lock must queue it.
          const second = settle(
            ipc.neon.setActiveBranch({ appId, branchId: devId }),
          );
          gateHandle.release();
          const [firstResult, secondResult] = await Promise.all([
            first,
            second,
          ]);
          live.metrics.event("overlapping-switches", {
            first: firstResult.ok ? "ok" : errorKind(firstResult.error),
            second: secondResult.ok ? "ok" : errorKind(secondResult.error),
          });
          expect(secondResult.ok).toBe(true);
          // No late callback from the first switch may replace the newer target.
          const after = await snapshot(appId, appDir);
          expect(after.row.neonActiveBranchId).toBe(devId);
          expect(after.dbHost).toBe(
            await live.verifier.endpointHost(projectId, devId),
          );
          expect(after.authBaseUrl).toBe(
            await live.verifier.authBaseUrl(projectId, devId),
          );
        });
      },
      600_000,
    );

    it.runIf(canCreateProjects)(
      "SQL transport faults: a reset never writes, a lost response wrote exactly once",
      async () => {
        await live.scenario("faults:sql-transport", async () => {
          live.assertBudget(5 * 60_000);
          const { appId, projectId } = await primaryProject();
          const devId = (await live.appRow(appId)).neonDevelopmentBranchId!;
          // No primary key: a silently retried insert shows up as a second row.
          const direct = await live.verifier.sql(projectId, devId);
          await direct.query(
            `create table if not exists dyad_live_fault_log (label text not null, at timestamptz not null default now())`,
          );
          const count = async (label: string) => {
            const [{ n }] = (await direct.query(
              `select count(*)::int as n from dyad_live_fault_log where label = $1`,
              [label],
            )) as Array<{ n: number }>;
            return n;
          };
          const ctx = sqlToolContext(await live.appRow(appId));

          // Reset before send: the statement never reached Neon.
          const resetLabel = live.marker("sql-reset");
          const reset = live.faults.add({
            id: "sql-reset",
            transport: "sql",
            method: "POST",
            path: SQL_PATH,
            action: { kind: "reset-before-send" },
          });
          const resetOutcome = await settle(
            executeSqlTool.execute(
              {
                query: `insert into dyad_live_fault_log(label) values ('${resetLabel}')`,
              },
              ctx,
            ),
          );
          expect(reset.hits()).toBe(1);
          live.faults.clear();
          const resetRows = await count(resetLabel);
          live.metrics.event("sql-reset", {
            surfaced: !resetOutcome.ok,
            rows: resetRows,
          });
          if (resetOutcome.ok) {
            // Only acceptable if the driver resent it: then exactly once.
            expect(resetRows).toBe(1);
          } else {
            expect(isDyadError(resetOutcome.error)).toBe(true);
            expect((resetOutcome.error as Error).message).toMatch(
              /Failed to execute SQL on Neon/,
            );
            expect(resetRows).toBe(0);
          }

          // Lost response: Neon committed, the caller cannot know. The error must
          // surface, and nothing may have re-sent the insert.
          const lostLabel = live.marker("sql-lost");
          const lost = live.faults.add({
            id: "sql-lost-response",
            transport: "sql",
            method: "POST",
            path: SQL_PATH,
            action: { kind: "lose-response" },
          });
          const lostOutcome = await settle(
            executeSqlTool.execute(
              {
                query: `insert into dyad_live_fault_log(label) values ('${lostLabel}')`,
              },
              ctx,
            ),
          );
          expect(lost.hits()).toBe(1);
          live.faults.clear();
          const lostRows = await count(lostLabel);
          live.metrics.event("sql-lost-response", {
            surfaced: !lostOutcome.ok,
            rows: lostRows,
          });
          expect(lostOutcome.ok).toBe(false);
          expect(lostRows).toBe(1);
        });
      },
      600_000,
    );

    it.runIf(canCreateProjects)(
      "a 5xx on the preview branch create rolls createProject back completely",
      async () => {
        await live.scenario("faults:5xx-on-preview-create", async () => {
          live.assertBudget(5 * 60_000);
          const app = await live.createGitApp("faults-5xx");
          const before = await snapshot(app.appId, app.appDir);
          expect(before.envFileExists).toBe(false);
          const name = live.projectName("faults-5xx");
          const handle = live.faults.add({
            id: "503-preview-branch",
            transport: "management",
            method: "POST",
            path: BRANCHES_PATH,
            skip: 1,
            action: { kind: "status", status: 503 },
          });
          const error = await captureError(
            ipc.neon.createProject({ name, appId: app.appId }),
          );
          expect(handle.hits()).toBe(1);
          expect(errorKind(error)).toBe(DyadErrorKind.External);

          // Neon created the project before the failure; Dyad must have deleted it.
          const projectId = journaledProjectId(name);
          expect(
            projectId,
            "the project create should have reached Neon",
          ).toBeDefined();
          const gone = await waitForProjectAbsence(projectId!);
          live.metrics.event("create-compensation", { projectDeleted: gone });
          expect(
            gone,
            `Dyad left the half-provisioned project ${projectId} behind`,
          ).toBe(true);
          // Local state is exactly as before: unlinked, no .env.local.
          expect(await snapshot(app.appId, app.appDir)).toEqual(before);
        });
      },
      600_000,
    );

    it.runIf(canCreateProjects)(
      "a lost createProject response does not leave an orphaned project",
      async () => {
        await live.scenario("faults:lost-create-response", async () => {
          live.assertBudget(5 * 60_000);
          const app = await live.createGitApp("faults-lost");
          const before = await snapshot(app.appId, app.appDir);
          const name = live.projectName("faults-lost");
          const handle = live.faults.add({
            id: "lose-project-create",
            transport: "management",
            method: "POST",
            path: /^\/projects$/,
            action: { kind: "lose-response" },
          });
          const error = await captureError(
            ipc.neon.createProject({ name, appId: app.appId }),
          );
          expect(handle.hits()).toBe(1);
          expect(isDyadError(error)).toBe(true);
          expect(await snapshot(app.appId, app.appDir)).toEqual(before);
          // The SDK boundary never saw an ID; only the intent records the name.
          expect(
            live.journal.state().ambiguousIntents.map((i) => i.name),
          ).toContain(name);
          expect(journaledProjectId(name)).toBeUndefined();

          // What did Neon actually do? Search the exact unique name.
          let orphans: Array<{ id: string; name: string }> = [];
          for (let attempt = 0; attempt < 10; attempt++) {
            const { projects } = await listAllProjects(live.verifier.client, {
              orgId: live.config.orgId,
              search: name,
            });
            orphans = projects
              .filter((p) => p.name === name)
              .map((p) => ({ id: p.id, name: p.name }));
            if (orphans.length > 0) break;
            await sleep(3_000);
          }
          if (orphans.length > 0) {
            live.metrics.event("finding", {
              classification: "dyad-defect",
              title:
                "Lost createProject response leaves an orphaned Neon project",
              projectIds: orphans.map((o) => o.id),
            });
          }
          // Remove them before asserting, so the finding leaves nothing behind.
          for (const orphan of orphans) {
            live.journal.append({
              type: "project-adopted",
              projectId: orphan.id,
              name: orphan.name,
              reason: "fault campaign: lost createProject response",
            });
            const result = await deleteProjectVerified(
              live.verifier.client,
              orphan.id,
            );
            if (result.deleted) {
              live.journal.append({
                type: "deleted",
                kind: "project",
                projectId: orphan.id,
                actor: "verifier",
                verified: true,
              });
            }
            expect(result.deleted, `could not delete orphan ${orphan.id}`).toBe(
              true,
            );
          }
          expect(
            orphans.map((o) => o.id),
            "Dyad left an orphaned Neon project after a lost createProject response (it never learned the ID and did not reconcile by name)",
          ).toEqual([]);
        });
      },
      600_000,
    );
  },
);
