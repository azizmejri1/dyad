// Live P0 "Migrations": the migration preview/apply IPC (ts-pg-schema-diff
// over unpooled connections, then one Neon HTTP transaction on production)
// against a real Neon project. Development changes are fixture SQL; the
// reviewed plan is applied by Dyad; production is checked independently.
//
// One Dyad-created project is shared by every test. Each test drops its own
// objects from both branches afterwards so later diffs contain only their
// own changes. The SQL-transport fault test is labeled "live Neon with
// injected transport faults".
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
import type { MigrationPreviewResponse } from "@/ipc/types/migration";
import { prepareMigrationContext } from "@/ipc/utils/migration_utils";
import {
  setupLiveNeonHarness,
  type LiveNeonHarness,
} from "@/testing/live_neon/live_harness";
import { deleteBranchVerified } from "@/testing/live_neon/neon_ops";
import { sanitizeError } from "@/testing/live_neon/redact";

const gate = liveNeonGate();
const canCreateProjects =
  gate.enabled && gate.config.keyMode === "organization";

type Row = Record<string, unknown>;
const ANCHOR = "mig_anchor";
const token = () => randomBytes(3).toString("hex");

async function settle<T>(
  promise: Promise<T>,
): Promise<PromiseSettledResult<T>> {
  const [result] = await Promise.allSettled([promise]);
  return result;
}

function messageOf(result: PromiseSettledResult<unknown>): string {
  return result.status === "rejected"
    ? String((result.reason as Error)?.message ?? result.reason)
    : "";
}

describe.runIf(gate.enabled)("Neon migrations (live Neon API)", () => {
  let live: LiveNeonHarness;
  let appId: number;
  let projectId: string;
  let devId: string;
  let mainId: string;

  async function onBranch(
    branchId: string,
    query: string,
    params: unknown[] = [],
  ) {
    const sql = await live.verifier.sql(projectId, branchId);
    return (await sql.query(query, params)) as Row[];
  }
  const onDev = (query: string, params: unknown[] = []) =>
    onBranch(devId, query, params);
  const onMain = (query: string, params: unknown[] = []) =>
    onBranch(mainId, query, params);
  async function onBoth(query: string) {
    await onDev(query);
    await onMain(query);
  }

  async function tableExists(
    branchId: string,
    table: string,
  ): Promise<boolean> {
    const [{ present }] = await onBranch(
      branchId,
      `select to_regclass($1) is not null as present`,
      [`public.${table}`],
    );
    return present === true;
  }

  /** Columns, indexes and constraints of one table, comparable across branches. */
  async function shape(branchId: string, table: string) {
    const columns = await onBranch(
      branchId,
      `select column_name, data_type, is_nullable, column_default, is_identity from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position`,
      [table],
    );
    const indexes = await onBranch(
      branchId,
      `select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = $1 order by indexname`,
      [table],
    );
    const constraints = await onBranch(
      branchId,
      `select conname, pg_get_constraintdef(c.oid) as def from pg_constraint c join pg_class t on t.oid = c.conrelid join pg_namespace n on n.oid = t.relnamespace where n.nspname = 'public' and t.relname = $1 order by conname`,
      [table],
    );
    return { columns, indexes, constraints };
  }

  async function dropEverywhere(...tables: string[]) {
    for (const table of tables) {
      await onDev(`drop table if exists public.${table} cascade`).catch(
        () => {},
      );
      await onMain(`drop table if exists public.${table} cascade`).catch(
        () => {},
      );
    }
  }

  async function preview(): Promise<MigrationPreviewResponse> {
    return ipc.migration.preview({ appId });
  }

  function migrate(migrationId: string) {
    return ipc.migration.migrate({ appId, migrationId });
  }

  beforeAll(async () => {
    live = await setupLiveNeonHarness({ suite: "migration" });
    if (!canCreateProjects) return;
    await live.scenario("migration:setup-project", async () => {
      const app = await live.createGitApp("migration");
      appId = app.appId;
      const result = await ipc.neon.createProject({
        name: live.projectName("migration"),
        appId,
      });
      projectId = result.id;
      devId = (await live.appRow(appId)).neonDevelopmentBranchId!;
      mainId = (await live.verifier.branches(projectId)).find(
        (b) => b.default,
      )!.id;
      // Identical on both branches: satisfies "development has tables" without
      // appearing in any diff.
      await onBoth(`create table if not exists ${ANCHOR} (id int primary key)`);
      await onBoth(`insert into ${ANCHOR} values (1) on conflict do nothing`);
    });
  }, 600_000);

  afterAll(async () => {
    await live?.deleteOwnedProjects();
    await live?.dispose();
  }, 300_000);

  it.runIf(canCreateProjects)(
    "diffs over unpooled connections to the expected branches",
    async () => {
      live.assertBudget(2 * 60_000);
      await live.scenario("migration:unpooled-context", async () => {
        const ctx = await prepareMigrationContext({ appId });
        expect(ctx.projectId).toBe(projectId);
        expect(ctx.devBranchId).toBe(devId);
        expect(ctx.prodBranchId).toBe(mainId);
        const devHost = new URL(ctx.devUri).hostname;
        const prodHost = new URL(ctx.prodUri).hostname;
        expect(devHost).not.toContain("-pooler");
        expect(prodHost).not.toContain("-pooler");
        expect(devHost).toBe(
          await live.verifier.endpointHost(projectId, devId),
        );
        expect(prodHost).toBe(
          await live.verifier.endpointHost(projectId, mainId),
        );
      });
    },
    300_000,
  );

  it.runIf(canCreateProjects)(
    "a no-op preview applies nothing and the plan is consumed",
    async () => {
      live.assertBudget(3 * 60_000);
      await live.scenario("migration:no-op", async () => {
        const plan = await preview();
        expect(plan.statements).toEqual([]);
        expect(plan.hasDataLoss).toBe(false);
        await expect(migrate(plan.migrationId)).resolves.toEqual({
          success: true,
          noChanges: true,
        });
        await expect(migrate(plan.migrationId)).rejects.toThrow(
          /expired or already applied/,
        );
      });
    },
    300_000,
  );

  it.runIf(canCreateProjects)(
    "applies a reviewed additive change so production matches development, and refuses a replay",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("migration:additive-and-replay", async () => {
        const table = `mig_add_${token()}`;
        try {
          await onDev(
            `create table ${table} (id bigint generated always as identity primary key, anchor_id int references ${ANCHOR}(id), title text not null default 'untitled', meta jsonb)`,
          );
          await onDev(`create index ${table}_title_idx on ${table}(title)`);
          const plan = await preview();
          expect(plan.statements.join("\n")).toContain(table);
          expect(plan.hasDataLoss).toBe(false);
          expect(plan.destructiveStatements).toEqual([]);
          expect(await tableExists(mainId, table)).toBe(false);

          await expect(migrate(plan.migrationId)).resolves.toEqual({
            success: true,
          });
          expect(await shape(mainId, table)).toEqual(await shape(devId, table));
          // Constraints behave on production, not just exist.
          await expect(
            onMain(`insert into ${table}(anchor_id) values (999)`),
          ).rejects.toThrow(/foreign key/i);

          await expect(migrate(plan.migrationId)).rejects.toThrow(
            /expired or already applied/,
          );
          expect(await shape(mainId, table)).toEqual(await shape(devId, table));
        } finally {
          await dropEverywhere(table);
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "flags destructive changes with their reasons before applying them",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("migration:destructive", async () => {
        const s = token();
        const kept = `mig_destr_${s}`;
        const gone = `mig_gone_${s}`;
        try {
          await onBoth(
            `create table ${kept} (id int primary key, keep text, dropme text)`,
          );
          await onBoth(`create table ${gone} (id int primary key)`);
          await onMain(`insert into ${kept} values (1, 'k', 'd')`);
          await onDev(`alter table ${kept} drop column dropme`);
          await onDev(`drop table ${gone}`);

          const plan = await preview();
          expect(plan.hasDataLoss).toBe(true);
          expect(plan.warningReasons).toEqual(
            expect.arrayContaining(["drop_column", "drop_table"]),
          );
          const patterns: Record<string, RegExp> = {
            drop_column: /DROP\s+COLUMN/i,
            drop_table: /DROP\s+TABLE/i,
          };
          for (const destructive of plan.destructiveStatements) {
            const pattern = patterns[destructive.reason];
            if (pattern)
              expect(plan.statements[destructive.index]).toMatch(pattern);
          }

          await expect(migrate(plan.migrationId)).resolves.toEqual({
            success: true,
          });
          expect(await tableExists(mainId, gone)).toBe(false);
          expect(
            (await shape(mainId, kept)).columns.map((c) => c.column_name),
          ).toEqual(["id", "keep"]);
          expect(await onMain(`select id, keep from ${kept}`)).toEqual([
            { id: 1, keep: "k" },
          ]);
        } finally {
          await dropEverywhere(kept, gone);
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "refuses a plan applied for a different app linked to the same project",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("migration:wrong-app", async () => {
        const table = `mig_wrongapp_${token()}`;
        const other = await live.createGitApp("migration-other");
        try {
          await onDev(`create table ${table} (id int primary key)`);
          await ipc.neon.setAppProject({ appId: other.appId, projectId });
          const plan = await preview();
          expect(plan.statements.join("\n")).toContain(table);
          await expect(
            ipc.migration.migrate({
              appId: other.appId,
              migrationId: plan.migrationId,
            }),
          ).rejects.toThrow(/does not belong to this app/);
          expect(await tableExists(mainId, table)).toBe(false);
          // The owner's plan is still intact after the refusal.
          await expect(migrate(plan.migrationId)).resolves.toEqual({
            success: true,
          });
          expect(await shape(mainId, table)).toEqual(await shape(devId, table));
        } finally {
          await ipc.neon
            .unsetAppProject({ appId: other.appId })
            .catch(() => {});
          await dropEverywhere(table);
        }
        // Unlinking the second app leaves the shared project in place.
        expect(await live.verifier.projectExists(projectId)).toBe(true);
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "two concurrent applies of one plan apply it exactly once",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("migration:concurrent-apply", async () => {
        const table = `mig_conc_${token()}`;
        try {
          await onDev(`create table ${table} (id int primary key, note text)`);
          const plan = await preview();
          const outcomes = await Promise.allSettled([
            migrate(plan.migrationId),
            migrate(plan.migrationId),
          ]);
          const fulfilled = outcomes.filter((o) => o.status === "fulfilled");
          live.metrics.event("migration-concurrent-apply", {
            outcomes: outcomes.map((o) =>
              o.status === "fulfilled"
                ? "fulfilled"
                : sanitizeError(o.reason, live.redact).message.slice(0, 200),
            ),
          });
          // Never applied twice; and not lost either.
          expect(fulfilled).toHaveLength(1);
          const loser = outcomes.find((o) => o.status === "rejected")!;
          expect(messageOf(loser)).toMatch(
            /already applied|expired|already exists|changed since this migration was previewed/i,
          );
          expect(await shape(mainId, table)).toEqual(await shape(devId, table));
        } finally {
          await dropEverywhere(table);
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "refuses to apply after the production (default) branch changed",
    async () => {
      live.assertBudget(8 * 60_000);
      await live.scenario("migration:default-branch-changed", async () => {
        const table = `mig_default_${token()}`;
        let altId: string | undefined;
        try {
          await onDev(`create table ${table} (id int primary key)`);
          const plan = await preview();
          const { data } = await live.setup(() =>
            live.fixtureClient.createProjectBranch(projectId, {
              endpoints: [{ type: "read_write" as never }],
              branch: { name: `alt-default-${token()}`, parent_id: mainId },
            }),
          );
          altId = data.branch.id;
          await live.verifier.waitForOperations(projectId);
          const newDefault = altId;
          await live.setup(() =>
            live.fixtureClient.setDefaultProjectBranch(projectId, newDefault),
          );
          await live.verifier.waitForOperations(projectId);

          await expect(migrate(plan.migrationId)).rejects.toThrow(
            /changed since this migration was previewed/,
          );
          expect(await tableExists(mainId, table)).toBe(false);
          expect(await tableExists(newDefault, table)).toBe(false);
        } finally {
          await live.setup(() =>
            live.fixtureClient.setDefaultProjectBranch(projectId, mainId),
          );
          await live.verifier.waitForOperations(projectId);
          if (altId) {
            const result = await deleteBranchVerified(
              live.fixtureClient,
              projectId,
              altId,
            );
            if (result.deleted) {
              live.journal.append({
                type: "deleted",
                kind: "branch",
                projectId,
                branchId: altId,
                actor: "fixture",
                verified: true,
              });
            }
          }
          await dropEverywhere(table);
        }
        const tree = await live.verifier.branches(projectId);
        expect(tree.find((b) => b.default)?.id).toBe(mainId);
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "production changed out of band after preview: a conflicting change leaves no partial effects; drift detection is recorded",
    async () => {
      live.assertBudget(8 * 60_000);
      await live.scenario("migration:out-of-band-drift", async () => {
        const s = token();
        const a = `drift_a_${s}`;
        const b = `drift_b_${s}`;
        const c = `drift_c_${s}`;
        const oob = `drift_oob_${s}`;
        try {
          // Conflicting: production gains one of the plan's tables, differently shaped.
          await onDev(`create table ${a} (id int primary key)`);
          await onDev(`create table ${b} (id int primary key, dev_only text)`);
          const conflicting = await preview();
          await onMain(
            `create table ${b} (id int primary key, prod_only text)`,
          );
          const conflictResult = await settle(migrate(conflicting.migrationId));
          const conflictDetected =
            /changed since this migration was previewed/.test(
              messageOf(conflictResult),
            );
          live.metrics.event("migration-drift-detection", {
            case: "conflicting",
            outcome: conflictResult.status,
            detected: conflictDetected,
          });
          expect(conflictResult.status).toBe("rejected");
          // No partial migration: the plan's other table is not on production,
          // and the out-of-band table is untouched.
          expect(await tableExists(mainId, a)).toBe(false);
          expect(
            (await shape(mainId, b)).columns.map((col) => col.column_name),
          ).toEqual(["id", "prod_only"]);
          await dropEverywhere(a, b);

          // Non-conflicting: production gains an unrelated table. Whether a
          // stale plan still applies is a drift-detection property; record it.
          await onDev(`create table ${c} (id int primary key)`);
          const stale = await preview();
          await onMain(`create table ${oob} (id int primary key)`);
          const staleResult = await settle(migrate(stale.migrationId));
          const staleDetected =
            /changed since this migration was previewed/.test(
              messageOf(staleResult),
            );
          live.metrics.event("migration-drift-detection", {
            case: "non-conflicting",
            outcome: staleResult.status,
            detected: staleDetected,
            gap: staleResult.status === "fulfilled",
          });
          if (staleResult.status === "fulfilled") {
            // Applied as reviewed, and nothing else was touched.
            expect(await shape(mainId, c)).toEqual(await shape(devId, c));
            expect(await tableExists(mainId, oob)).toBe(true);
          } else {
            expect(staleDetected).toBe(true);
            expect(await tableExists(mainId, c)).toBe(false);
          }
        } finally {
          await dropEverywhere(a, b, c, oob);
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "a statement failing mid-transaction leaves no partial migration and keeps the plan",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("migration:mid-transaction-failure", async () => {
        const s = token();
        const users = `mig_mid_users_${s}`;
        const added = `mig_mid_new_${s}`;
        try {
          await onBoth(
            `create table ${users} (id int primary key, email text)`,
          );
          // Production data that the reviewed unique index cannot accept.
          await onMain(
            `insert into ${users} values (1, 'dup@example.com'), (2, 'dup@example.com')`,
          );
          await onDev(
            `create unique index ${users}_email_key on ${users}(email)`,
          );
          await onDev(`create table ${added} (id int primary key)`);
          const plan = await preview();
          expect(plan.statements.join("\n")).toContain(added);
          expect(plan.statements.join("\n")).toContain(`${users}_email_key`);

          await expect(migrate(plan.migrationId)).rejects.toThrow(
            /rolled back/,
          );
          expect(await tableExists(mainId, added)).toBe(false);
          expect(
            (await shape(mainId, users)).indexes.map((i) => i.indexname),
          ).not.toContain(`${users}_email_key`);
          // The failed apply did not consume the plan: a retry fails the same way.
          await expect(migrate(plan.migrationId)).rejects.toThrow(
            /rolled back/,
          );
          expect(await tableExists(mainId, added)).toBe(false);
        } finally {
          await dropEverywhere(users, added);
        }
      });
    },
    600_000,
  );

  it.runIf(canCreateProjects)(
    "SQL response lost after apply commits (live Neon with injected transport faults): retry never double-applies",
    async () => {
      live.assertBudget(5 * 60_000);
      await live.scenario("faults:migration-apply-lost-response", async () => {
        const table = `mig_fault_${token()}`;
        try {
          await onDev(`create table ${table} (id int primary key, note text)`);
          const plan = await preview();
          expect(plan.statements.join("\n")).toContain(table);

          // Armed immediately before apply: the only SQL-over-HTTP request
          // migrate makes is the apply transaction itself.
          const fault = live.faults.add({
            id: "sql-lose-response-on-apply",
            transport: "sql",
            method: "POST",
            path: /^\/sql$/,
            times: 1,
            action: { kind: "lose-response" },
          });
          let first: PromiseSettledResult<unknown>;
          try {
            first = await settle(migrate(plan.migrationId));
          } finally {
            live.faults.clear();
          }
          expect(fault.hits(), "the fault must hit the apply transaction").toBe(
            1,
          );
          expect(first.status).toBe("rejected");
          const committed = await tableExists(mainId, table);
          live.metrics.event("migration-apply-lost-response", {
            committedDespiteError: committed,
            errorClaimsRollback: /rolled back/i.test(messageOf(first)),
          });

          // The plan was kept for retry (not reported as expired/applied).
          const retry = await settle(migrate(plan.migrationId));
          live.metrics.event("migration-retry-after-lost-response", {
            outcome: retry.status,
            reason:
              retry.status === "rejected"
                ? sanitizeError(retry.reason, live.redact).message.slice(0, 200)
                : undefined,
          });
          expect(messageOf(retry)).not.toMatch(/expired or already applied/);

          // Whatever the outcomes, production holds the reviewed change exactly
          // once, or not at all if nothing reported success and nothing committed.
          if (committed || retry.status === "fulfilled") {
            expect(await shape(mainId, table)).toEqual(
              await shape(devId, table),
            );
          } else {
            expect(await tableExists(mainId, table)).toBe(false);
          }
          // A retry cannot "succeed" on top of a commit it did not know about.
          if (committed) expect(retry.status).toBe("rejected");
        } finally {
          await dropEverywhere(table);
        }
      });
    },
    600_000,
  );
});
