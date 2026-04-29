import { eq } from "drizzle-orm";
import { createTypedHandler } from "./base";
import { migrationContracts } from "../types/migration";
import { DyadError, DyadErrorKind } from "@/errors/dyad_error";
import { IS_TEST_BUILD } from "../utils/test_utils";
import { db } from "../../db";
import { apps } from "../../db/schema";
import { getDyadAppPath } from "../../paths/paths";
import {
  logger,
  prepareMigrationContext,
  areMigrationDepsInstalled,
  introspectProdWithCache,
  introspectBranch,
  runBaselineGenerate,
  runDiffGenerate,
  readPendingMigrationFiles,
  parseDrizzleMigrationFile,
  detectDestructiveStatements,
  deriveWarningsFromDestructive,
  runDrizzleKitMigrate,
  invalidateProdIntrospectCache,
  cleanupWorkDir,
} from "../utils/migration_utils";

// =============================================================================
// Handler Registration
// =============================================================================

export function registerMigrationHandlers() {
  // -------------------------------------------------------------------------
  // migration:dependencies-status
  // -------------------------------------------------------------------------
  createTypedHandler(
    migrationContracts.dependenciesStatus,
    async (_, params) => {
      const { appId } = params;
      if (IS_TEST_BUILD) {
        return { installed: true };
      }
      const rows = await db
        .select()
        .from(apps)
        .where(eq(apps.id, appId))
        .limit(1);
      if (rows.length === 0) {
        throw new DyadError(
          `App with ID ${appId} not found`,
          DyadErrorKind.NotFound,
        );
      }
      const appPath = getDyadAppPath(rows[0].path);
      return { installed: await areMigrationDepsInstalled(appPath) };
    },
  );

  // -------------------------------------------------------------------------
  // migration:preview
  //
  // 1. Resolve dev/prod branches, ensure deps, wipe+recreate work dir.
  // 2. Introspect prod (cached, 5 min TTL) → write a baseline snapshot.
  // 3. Introspect dev (always fresh) → run diff generate.
  // 4. Read pending migration files; the baseline file is hidden from the UI
  //    but kept on disk for the apply step's drizzle-kit migrate run.
  // -------------------------------------------------------------------------
  createTypedHandler(migrationContracts.preview, async (_, params) => {
    const { appId } = params;
    logger.info(`Computing migration preview for app ${appId}`);

    const ctx = await prepareMigrationContext({ appId, mode: "preview" });

    const prodSchemaPath = await introspectProdWithCache({
      appId,
      prodBranchId: ctx.prodBranchId,
      appPath: ctx.appPath,
      workDir: ctx.workDir,
      prodConnectionUri: ctx.prodUri,
    });

    await runBaselineGenerate({
      workDir: ctx.workDir,
      appPath: ctx.appPath,
      prodSchemaPath,
      prodConnectionUri: ctx.prodUri,
    });

    const devSchemaPath = await introspectBranch({
      appPath: ctx.appPath,
      workDir: ctx.workDir,
      subDir: "dev-schema-out",
      connectionUri: ctx.devUri,
    });

    await runDiffGenerate({
      workDir: ctx.workDir,
      appPath: ctx.appPath,
      devSchemaPath,
      devConnectionUri: ctx.devUri,
    });

    const pending = await readPendingMigrationFiles(ctx.workDir);
    const userVisible = pending.filter((p) => !p.isBaseline);

    const statements: string[] = [];
    for (const entry of userVisible) {
      statements.push(...parseDrizzleMigrationFile(entry.sql));
    }

    const destructiveStatements = detectDestructiveStatements(statements);
    const warnings = deriveWarningsFromDestructive(destructiveStatements);
    const hasDataLoss = destructiveStatements.length > 0;

    logger.info(
      `Migration preview for app ${appId}: ${statements.length} statements, ${destructiveStatements.length} destructive`,
    );

    return {
      statements,
      hasDataLoss,
      warnings,
      destructiveStatements,
    };
  });

  // -------------------------------------------------------------------------
  // migration:migrate
  //
  // Consumes the work dir produced by the preceding preview call and runs
  // `drizzle-kit migrate` against prod. Always invalidates the prod
  // introspect cache afterwards (success or failure) and cleans the work
  // dir. The user app's filesystem is not modified.
  // -------------------------------------------------------------------------
  createTypedHandler(migrationContracts.migrate, async (_, params) => {
    const { appId } = params;
    logger.info(`Applying migration for app ${appId}`);

    const ctx = await prepareMigrationContext({ appId, mode: "migrate" });

    const pendingBefore = await readPendingMigrationFiles(ctx.workDir);
    const hasDiff = pendingBefore.some((p) => !p.isBaseline);

    try {
      const migrateResult = await runDrizzleKitMigrate({
        workDir: ctx.workDir,
        appPath: ctx.appPath,
        prodConnectionUri: ctx.prodUri,
      });

      const noChanges =
        !hasDiff || /no\s+migrations\s+to\s+apply/i.test(migrateResult.stdout);

      logger.info(
        noChanges
          ? `Schemas already in sync for app ${appId}, nothing to migrate.`
          : `Migration applied successfully for app ${appId}`,
      );
      return { success: true, noChanges };
    } finally {
      invalidateProdIntrospectCache({
        appId,
        prodBranchId: ctx.prodBranchId,
      });
      await cleanupWorkDir(ctx.workDir);
    }
  });
}
