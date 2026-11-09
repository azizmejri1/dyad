// Live P0 "SQL and schema": Dyad's SQL paths (the execute_sql agent tool, the
// transactional statement executor, the schema and project-info tools)
// against a real Neon project, checked independently with direct SQL on the
// expected branch. One Dyad-created project is shared by every test; each
// test uses its own object names.
//
// Runs only under the campaign supervisor (npm run test:neon:live).
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { liveNeonGate } from "@/testing/live_neon/config";

vi.mock("@/neon_admin/neon_management_client", async (importOriginal) =>
  (await import("@/testing/live_neon/product_client")).mockNeonManagementClient(
    await importOriginal<
      typeof import("@/neon_admin/neon_management_client")
    >(),
  ),
);

import { ipc } from "@/ipc/types";
import { readSettings, writeSettings } from "@/main/settings";
import {
  executeNeonStatementsInTransaction,
  getNeonProjectInfo,
  getNeonTableSchema,
} from "@/neon_admin/neon_context";
import { executeSqlTool } from "@/pro/main/ipc/handlers/local_agent/tools/execute_sql";
import type { AgentContext } from "@/pro/main/ipc/handlers/local_agent/tools/types";
import {
  databaseHost,
  setupLiveNeonHarness,
  type LiveNeonHarness,
} from "@/testing/live_neon/live_harness";

const gate = liveNeonGate();
const canCreateProjects =
  gate.enabled && gate.config.keyMode === "organization";

type Row = Record<string, unknown>;

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

/** Rows from an execute_sql result ("Successfully executed SQL query.\n\nSQL result:\n<json>"). */
function toolRows(result: string): Row[] {
  const marker = "SQL result:\n";
  const index = result.indexOf(marker);
  if (!result.startsWith("Successfully executed SQL query") || index < 0) {
    throw new Error(`unexpected execute_sql result: ${result.slice(0, 200)}`);
  }
  return JSON.parse(result.slice(index + marker.length)) as Row[];
}

const token = () => randomBytes(3).toString("hex");

describe.runIf(gate.enabled)("Neon SQL and schema (live Neon API)", () => {
  let live: LiveNeonHarness;
  let appId: number;
  let appDir: string;
  let projectId: string;
  let devId: string;
  let mainId: string;

  /** One statement through the execute_sql tool, on the app's current target. */
  async function runTool(query: string): Promise<Row[]> {
    const app = await live.appRow(appId);
    return toolRows(
      await executeSqlTool.execute({ query }, sqlToolContext(app)),
    );
  }

  /** Direct SQL on a branch, bypassing Dyad. */
  async function direct(
    branchId: string,
    query: string,
    params: unknown[] = [],
  ) {
    const sql = await live.verifier.sql(projectId, branchId);
    return (await sql.query(query, params)) as Row[];
  }

  async function relationExists(
    branchId: string,
    name: string,
  ): Promise<boolean> {
    const [{ present }] = await direct(
      branchId,
      `select to_regclass($1) is not null as present`,
      [`public.${name}`],
    );
    return present === true;
  }

  /** Builds tables, FKs, a view, a partitioned table and a sequence via execute_sql. */
  async function createRelationalFixture(s: string) {
    const names = {
      customers: `Customers_${s}`,
      orders: `orders_${s}`,
      view: `customer_orders_${s}`,
      events: `events_${s}`,
      seq: `invoice_seq_${s}`,
    };
    await runTool(
      `create table "${names.customers}" (id integer generated always as identity primary key, "Full Name" text not null, "select" text, profile jsonb, tags json, created_at timestamptz not null default now())`,
    );
    await runTool(
      `create table ${names.orders} (id bigserial primary key, customer_id integer not null references "${names.customers}"(id) on delete cascade, total numeric(10,2) not null check (total >= 0))`,
    );
    await runTool(
      `create view ${names.view} as select c."Full Name" as full_name, o.total from "${names.customers}" c join ${names.orders} o on o.customer_id = c.id`,
    );
    await runTool(
      `create table ${names.events} (id int not null, at date not null, payload jsonb, primary key (id, at)) partition by range (at)`,
    );
    await runTool(
      `create table ${names.events}_2025 partition of ${names.events} for values from ('2025-01-01') to ('2026-01-01')`,
    );
    await runTool(
      `create table ${names.events}_2026 partition of ${names.events} for values from ('2026-01-01') to ('2027-01-01')`,
    );
    await runTool(`create sequence ${names.seq} start 1000 increment 5`);
    return names;
  }

  async function dropRelationalFixture(
    names: Awaited<ReturnType<typeof createRelationalFixture>>,
  ) {
    for (const statement of [
      `drop view if exists ${names.view}`,
      `drop table if exists ${names.events} cascade`,
      `drop table if exists ${names.orders} cascade`,
      `drop table if exists "${names.customers}" cascade`,
      `drop sequence if exists ${names.seq}`,
    ]) {
      await direct(devId, statement).catch(() => {});
    }
  }

  beforeAll(async () => {
    live = await setupLiveNeonHarness({ suite: "sql-schema" });
    if (!canCreateProjects) return;
    await live.scenario("sql:setup-project", async () => {
      const app = await live.createGitApp("sql-schema");
      appId = app.appId;
      appDir = app.appDir;
      const result = await ipc.neon.createProject({
        name: live.projectName("sql-schema"),
        appId,
      });
      projectId = result.id;
      const row = await live.appRow(appId);
      devId = row.neonDevelopmentBranchId!;
      expect(row.neonActiveBranchId).toBe(devId);
      mainId = (await live.verifier.branches(projectId)).find(
        (b) => b.default,
      )!.id;
    });
  }, 600_000);

  afterAll(async () => {
    await live?.deleteOwnedProjects();
    await live?.dispose();
  }, 300_000);

  it.runIf(canCreateProjects)(
    "execute_sql builds and queries FKs, views, partitions, quoted identifiers, JSON and sequences on the active branch",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("sql:relational-objects", async () => {
        const s = token();
        const names = await createRelationalFixture(s);
        try {
          const [inserted] = await runTool(
            `insert into "${names.customers}"("Full Name", "select", profile, tags) values ('Ada Lovelace', 'reserved-ok', '{"a":{"b":[1,2]}}', '[1,"two"]') returning id`,
          );
          const customerId = Number(inserted.id);
          expect(customerId).toBeGreaterThan(0);

          // JSON/JSONB operators round-trip through the tool.
          expect(
            await runTool(
              `select profile->'a'->'b'->>1 as second, tags->>1 as tag, "select" as reserved from "${names.customers}" where id = ${customerId}`,
            ),
          ).toEqual([{ second: "2", tag: "two", reserved: "reserved-ok" }]);

          // Sequences advance by their increment.
          const first = Number(
            (await runTool(`select nextval('${names.seq}') as v`))[0].v,
          );
          const second = Number(
            (await runTool(`select nextval('${names.seq}') as v`))[0].v,
          );
          expect(first).toBe(1000);
          expect(second).toBe(1005);

          // Foreign keys are enforced on this branch.
          await runTool(
            `insert into ${names.orders}(customer_id, total) values (${customerId}, 12.50)`,
          );
          await expect(
            runTool(
              `insert into ${names.orders}(customer_id, total) values (999999, 1)`,
            ),
          ).rejects.toThrow(/foreign key/i);
          await expect(
            runTool(
              `insert into ${names.orders}(customer_id, total) values (${customerId}, -1)`,
            ),
          ).rejects.toThrow(/check constraint/i);

          // The view joins across the quoted table.
          expect(
            await runTool(`select full_name, total from ${names.view}`),
          ).toEqual([{ full_name: "Ada Lovelace", total: "12.50" }]);

          // Partition routing, checked independently on the same branch.
          await runTool(
            `insert into ${names.events} values (1, '2025-03-01', '{"k":1}'), (2, '2026-03-01', '{"k":2}'), (3, '2026-07-01', null)`,
          );
          expect(
            await direct(
              devId,
              `select (select count(*)::int from ${names.events}_2025) as y2025, (select count(*)::int from ${names.events}_2026) as y2026`,
            ),
          ).toEqual([{ y2025: 1, y2026: 2 }]);
          await expect(
            runTool(
              `insert into ${names.events} values (9, '2030-01-01', null)`,
            ),
          ).rejects.toThrow(/partition/i);

          // Nothing leaked to production.
          expect(await relationExists(mainId, `"${names.customers}"`)).toBe(
            false,
          );
          expect(await relationExists(mainId, names.orders)).toBe(false);
        } finally {
          await dropRelationalFixture(names);
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "the schema and project-info tools match direct catalog reads of the same branch",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("sql:schema-vs-catalog", async () => {
        const s = token();
        const names = await createRelationalFixture(s);
        try {
          const schema = await getNeonTableSchema({
            projectId,
            branchId: devId,
          });
          const columns = await direct(
            devId,
            `select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1) order by table_name, ordinal_position`,
            [[names.customers, names.orders]],
          );
          expect(columns.length).toBeGreaterThanOrEqual(9);
          for (const { column_name } of columns) {
            const name = String(column_name);
            // Identifiers that need quoting must come out quoted (valid SQL).
            const needsQuotes =
              name !== name.toLowerCase() ||
              /\s/.test(name) ||
              name === "select";
            expect(schema).toContain(needsQuotes ? `"${name}"` : name);
          }
          expect(schema).toContain(`"${names.customers}"`);
          expect(schema).toContain(names.orders);
          const foreignKeys = await direct(
            devId,
            `select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = $1::regclass and contype = 'f'`,
            [`public.${names.orders}`],
          );
          expect(foreignKeys).toHaveLength(1);
          expect(schema).toMatch(
            new RegExp(`REFERENCES\\s+(?:public\\.)?"${names.customers}"`, "i"),
          );
          live.metrics.event("schema-tool-rendering", {
            renderedPartitionClause: /PARTITION BY/i.test(schema),
            renderedView: schema.includes(names.view),
            renderedSequence: schema.includes(names.seq),
          });

          // Per-table filter and a missing table.
          const one = await getNeonTableSchema({
            projectId,
            branchId: devId,
            tableName: names.customers,
          });
          expect(one).toContain(`"Full Name"`);
          const missing = `no_such_table_${s}`;
          expect(
            await getNeonTableSchema({
              projectId,
              branchId: devId,
              tableName: missing,
            }),
          ).toContain(`-- No public table named "${missing}" found.`);

          // Project info lists exactly the branch's public relations.
          const info = await getNeonProjectInfo({ projectId, branchId: devId });
          expect(info).toContain(projectId);
          expect(info).toContain(devId);
          expect(info).toContain(mainId);
          const listed = JSON.parse(
            /## Table Names\n(.*)\n/.exec(info)![1],
          ) as string[];
          const catalog = (
            await direct(
              devId,
              `select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
            )
          ).map((r) => String(r.table_name));
          expect(listed).toEqual(catalog);
          expect(listed).toEqual(
            expect.arrayContaining([names.customers, names.view]),
          );
        } finally {
          await dropRelationalFixture(names);
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "a transaction whose later statement fails commits nothing, and a clean one commits everything",
    async () => {
      live.assertBudget(3 * 60_000);
      await live.scenario("sql:transaction-rollback", async () => {
        const s = token();
        const failed = `txn_fail_${s}`;
        const ok = `txn_ok_${s}`;
        try {
          await expect(
            executeNeonStatementsInTransaction({
              projectId,
              branchId: devId,
              statements: [
                `create table ${failed} (id int primary key)`,
                `insert into ${failed} values (1), (2)`,
                `select 1 / 0`,
              ],
            }),
          ).rejects.toThrow(/rolled back/);
          expect(await relationExists(devId, failed)).toBe(false);

          await expect(
            executeNeonStatementsInTransaction({
              projectId,
              branchId: devId,
              statements: [
                `create table ${ok} (id int primary key)`,
                `insert into ${ok} values (1), (2)`,
              ],
            }),
          ).resolves.toEqual({ executed: 2 });
          expect(
            await direct(devId, `select count(*)::int as n from ${ok}`),
          ).toEqual([{ n: 2 }]);
          expect(await relationExists(mainId, ok)).toBe(false);
        } finally {
          await direct(devId, `drop table if exists ${failed}, ${ok}`).catch(
            () => {},
          );
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "a statement timeout inside the transaction errors and rolls everything back",
    async () => {
      live.assertBudget(3 * 60_000);
      await live.scenario("sql:statement-timeout", async () => {
        const table = `txn_timeout_${token()}`;
        try {
          const started = Date.now();
          const error = await executeNeonStatementsInTransaction({
            projectId,
            branchId: devId,
            statements: [
              `create table ${table} (id int)`,
              `set local statement_timeout = '1s'`,
              `select pg_sleep(5)`,
            ],
          }).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(error).toBeDefined();
          expect((error as Error).message).toMatch(
            /statement timeout|canceling statement/i,
          );
          expect((error as Error).message).toMatch(/rolled back/);
          // Bounded: the server-side timeout fired, not a client-side hang.
          expect(Date.now() - started).toBeLessThan(30_000);
          expect(await relationExists(devId, table)).toBe(false);
        } finally {
          await direct(devId, `drop table if exists ${table}`).catch(() => {});
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "row-level security created through execute_sql holds for a restricted role session",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("sql:rls-restricted-role", async () => {
        const s = token();
        const table = `rls_notes_${s}`;
        const privateTable = `rls_private_${s}`;
        const role = `live_rls_${s}`;
        try {
          await runTool(
            `create table ${table} (id serial primary key, owner text not null, body text not null)`,
          );
          await runTool(`create table ${privateTable} (id int)`);
          await runTool(`alter table ${table} enable row level security`);
          await runTool(`create role ${role} nologin`);
          // Lets the owner connection SET ROLE to it (PG16+ needs the SET option).
          await runTool(`grant ${role} to current_user`);
          await runTool(`grant select, insert on ${table} to ${role}`);
          await runTool(`grant usage on sequence ${table}_id_seq to ${role}`);
          await runTool(
            `create policy notes_owner on ${table} for all to ${role} using (owner = current_setting('app.user', true)) with check (owner = current_setting('app.user', true))`,
          );
          // The table owner bypasses RLS, so the owner can seed both users' rows.
          await runTool(
            `insert into ${table}(owner, body) values ('alice', 'a1'), ('bob', 'b1')`,
          );

          // Judge RLS only from a restricted session, never the owner connection.
          const sql = await live.verifier.sql(projectId, devId);
          const asUser = async (user: string, query: string) => {
            const results = await sql.transaction((txn) => [
              txn.query(`set local role ${role}`),
              txn.query(`select set_config('app.user', $1, true)`, [user]),
              txn.query(query),
            ]);
            return results[2] as Row[];
          };
          expect(
            await asUser(
              "alice",
              `select owner, body from ${table} order by id`,
            ),
          ).toEqual([{ owner: "alice", body: "a1" }]);
          expect(
            await asUser("bob", `select owner, body from ${table} order by id`),
          ).toEqual([{ owner: "bob", body: "b1" }]);
          expect(await asUser("", `select owner from ${table}`)).toEqual([]);
          await expect(
            asUser(
              "alice",
              `insert into ${table}(owner, body) values ('bob', 'forged')`,
            ),
          ).rejects.toThrow(/row-level security/i);
          await asUser(
            "alice",
            `insert into ${table}(owner, body) values ('alice', 'a2')`,
          );
          expect(
            (
              await asUser("alice", `select body from ${table} order by id`)
            ).map((r) => r.body),
          ).toEqual(["a1", "a2"]);
          await expect(
            asUser("alice", `select * from ${privateTable}`),
          ).rejects.toThrow(/permission denied/i);
          // The owner connection sees everything, which is why it cannot judge RLS.
          expect(
            await direct(devId, `select count(*)::int as n from ${table}`),
          ).toEqual([{ n: 3 }]);
        } finally {
          for (const statement of [
            `drop table if exists ${table}, ${privateTable} cascade`,
            `drop owned by ${role}`,
            `drop role if exists ${role}`,
          ]) {
            await direct(devId, statement).catch(() => {});
          }
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "execute_sql follows the active branch: production only after an explicit unprotected switch",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("sql:active-branch-targeting", async () => {
        const createMarkerTable =
          "create table if not exists dyad_live_marker (label text primary key, written_at timestamptz not null default now())";
        const previousProtection = readSettings().enableNeonBranchProtection;

        // Protected by default: no silent switch to production.
        await expect(
          ipc.neon.setActiveBranch({ appId, branchId: mainId }),
        ).rejects.toThrow(/production/i);
        expect((await live.appRow(appId)).neonActiveBranchId).toBe(devId);

        const onMain = live.marker(`targeting-main-${token()}`);
        const onDev = live.marker(`targeting-dev-${token()}`);
        writeSettings({ enableNeonBranchProtection: false });
        try {
          await ipc.neon.setActiveBranch({ appId, branchId: mainId });
          expect((await live.appRow(appId)).neonActiveBranchId).toBe(mainId);
          const env = await live.appEnv(appDir);
          expect(databaseHost(env.DATABASE_URL)).toBe(
            await live.verifier.endpointHost(projectId, mainId),
          );

          await runTool(createMarkerTable);
          await runTool(
            `insert into dyad_live_marker(label) values ('${onMain}')`,
          );
          expect(await live.readMarkers(projectId, mainId)).toContain(onMain);
          expect(await live.readMarkers(projectId, devId)).not.toContain(
            onMain,
          );
        } finally {
          await ipc.neon.setActiveBranch({ appId, branchId: devId });
          writeSettings({
            enableNeonBranchProtection: previousProtection ?? true,
          });
        }

        const row = await live.appRow(appId);
        expect(row.neonActiveBranchId).toBe(devId);
        expect(databaseHost((await live.appEnv(appDir)).DATABASE_URL)).toBe(
          await live.verifier.endpointHost(projectId, devId),
        );
        await runTool(createMarkerTable);
        await runTool(
          `insert into dyad_live_marker(label) values ('${onDev}')`,
        );
        expect(await live.readMarkers(projectId, devId)).toContain(onDev);
        const mainMarkers = await live.readMarkers(projectId, mainId);
        expect(mainMarkers).toContain(onMain);
        expect(mainMarkers).not.toContain(onDev);
      });
    },
    600_000,
  );
});
