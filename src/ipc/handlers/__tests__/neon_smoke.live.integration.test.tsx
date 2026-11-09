// Live smoke: proves the campaign really talks to Neon through Dyad's own
// handlers. Creates a project with Dyad, writes a unique marker through the
// execute_sql tool, reads it back independently from the expected branch,
// and exercises Neon Auth.
//
// Runs only under the campaign supervisor (npm run test:neon:live).
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

import { ipc } from "@/ipc/types";
import { getNeonTableSchema } from "@/neon_admin/neon_context";
import { executeSqlTool } from "@/pro/main/ipc/handlers/local_agent/tools/execute_sql";
import type { AgentContext } from "@/pro/main/ipc/handlers/local_agent/tools/types";
import {
  databaseHost,
  setupLiveNeonHarness,
  type LiveNeonHarness,
} from "@/testing/live_neon/live_harness";
import { assertRealNeonIds } from "@/testing/live_neon/verifier";

const gate = liveNeonGate();
const canCreateProjects =
  gate.enabled && gate.config.keyMode === "organization";

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

describe.runIf(gate.enabled)("Neon live smoke", () => {
  let live: LiveNeonHarness;

  beforeAll(async () => {
    live = await setupLiveNeonHarness({ suite: "smoke" });
  }, 120_000);

  afterEach(async () => {
    await live?.deleteOwnedProjects();
  }, 300_000);

  afterAll(async () => {
    await live?.dispose();
  }, 300_000);

  it.runIf(canCreateProjects)(
    "creates a project through Dyad and proves live SQL, Auth and branch targeting",
    async () => {
      await live.scenario("smoke:create-sql-auth", async () => {
        // No simulator or fake client may be in play.
        expect(process.env.DYAD_NEON_API_BASE_URL).toBeUndefined();
        expect(process.env.E2E_TEST_BUILD).not.toBe("true");

        const { appId, appDir } = await live.createGitApp("smoke");
        const result = await ipc.neon.createProject({
          name: live.projectName("smoke"),
          appId,
        });
        const projectId = result.id;
        expect(result.warning ?? "").not.toMatch(/Neon Auth/);
        // The SDK boundary journaled the ID before Dyad saw the response.
        expect(live.journal.state().projects.get(projectId)?.actor).toBe(
          "product",
        );

        const app = await live.appRow(appId);
        const devId = app.neonDevelopmentBranchId!;
        const previewId = app.neonPreviewBranchId!;
        assertRealNeonIds({
          projectId,
          branchIds: [devId, previewId, app.neonActiveBranchId],
        });
        expect(app.neonProjectId).toBe(projectId);
        expect(app.neonActiveBranchId).toBe(devId);

        const tree = await live.verifier.branches(projectId);
        expect(live.verifier.describeTree(tree)).toEqual([
          { name: "development", parent: null },
          { name: "main", parent: null },
          { name: "preview", parent: "development" },
        ]);
        const mainId = tree.find((b) => b.default)!.id;
        expect(tree.find((b) => b.name === "development")!.id).toBe(devId);
        expect(tree.find((b) => b.name === "preview")!.id).toBe(previewId);

        const { data: project } =
          await live.verifier.client.getProject(projectId);
        live.metrics.event("project-region", {
          region: project.project.region_id,
        });
        if (live.config.region) {
          expect(project.project.region_id).toBe(live.config.region);
        }

        // .env.local targets the development branch's compute and Auth.
        const env = await live.appEnv(appDir);
        const devHost = await live.verifier.endpointHost(projectId, devId);
        assertRealNeonIds({ hosts: [devHost, databaseHost(env.DATABASE_URL)] });
        expect(databaseHost(env.DATABASE_URL)).toBe(devHost);
        expect(env.NEON_AUTH_BASE_URL).toBe(
          await live.verifier.authBaseUrl(projectId, devId),
        );

        // getProject maps the remote tree to Dyad's branch roles.
        const info = await ipc.neon.getProject({ appId });
        expect(
          Object.fromEntries(info.branches.map((b) => [b.branchId, b.type])),
        ).toEqual({
          [mainId]: "production",
          [devId]: "development",
          [previewId]: "preview",
        });

        // Write a unique marker through the tested path (execute_sql tool)...
        const marker = live.marker("smoke");
        const ctx = sqlToolContext(app);
        await expect(
          executeSqlTool.execute(
            {
              query:
                "create table dyad_live_marker (label text primary key, written_at timestamptz not null default now())",
            },
            ctx,
          ),
        ).resolves.toMatch(/^Successfully executed SQL query/);
        await executeSqlTool.execute(
          { query: `insert into dyad_live_marker(label) values ('${marker}')` },
          ctx,
        );
        // ...and read it back independently from the expected branch only.
        expect(await live.readMarkers(projectId, devId)).toEqual([marker]);
        expect(await live.readMarkers(projectId, mainId)).toEqual([]);
        expect(await live.readMarkers(projectId, previewId)).toEqual([]);

        // The schema tool reads the same branch.
        const schema = await getNeonTableSchema({
          projectId,
          branchId: devId,
          tableName: "dyad_live_marker",
        });
        expect(schema).toContain("dyad_live_marker");
        expect(schema).toContain("label");

        // Neon Auth works per branch: a development sign-up is not a production user.
        const email = `smoke-${Date.now()}@example.com`;
        expect(
          await live.verifier.authRequest(projectId, devId, "sign-up", email),
        ).toBe(200);
        expect(
          await live.verifier.authRequest(projectId, devId, "sign-in", email),
        ).toBe(200);
        const count = async (branchId: string) => {
          const sql = await live.verifier.sql(projectId, branchId);
          const [{ n }] = (await sql.query(
            `select count(*)::int as n from neon_auth."user" where email = $1`,
            [email],
          )) as Array<{ n: number }>;
          return n;
        };
        expect(await count(devId)).toBe(1);
        expect(await count(mainId)).toBe(0);
      });
    },
    600_000,
  );
});
