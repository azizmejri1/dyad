import { randomUUID } from "node:crypto";
import log from "electron-log";

const logger = log.scope("migration_plan_store");

export const PLAN_TTL_MS = 30 * 60 * 1000;

interface StoredPreview {
  appId: number;
  statements: string[];
  createdAt: number;
}

const plansById = new Map<string, StoredPreview>();
const idByAppId = new Map<number, string>();

export function storePreview(appId: number, statements: string[]): string {
  const existingId = idByAppId.get(appId);
  if (existingId) {
    plansById.delete(existingId);
  }

  const migrationId = randomUUID();
  plansById.set(migrationId, {
    appId,
    statements,
    createdAt: Date.now(),
  });
  idByAppId.set(appId, migrationId);
  logger.info(
    `Stored migration plan ${migrationId} for app ${appId} (${statements.length} statements)`,
  );
  return migrationId;
}

export function consumePreview(
  migrationId: string,
): { appId: number; statements: string[] } | null {
  const stored = plansById.get(migrationId);
  if (!stored) {
    return null;
  }

  plansById.delete(migrationId);
  if (idByAppId.get(stored.appId) === migrationId) {
    idByAppId.delete(stored.appId);
  }

  if (Date.now() - stored.createdAt > PLAN_TTL_MS) {
    logger.info(
      `Migration plan ${migrationId} for app ${stored.appId} expired (age ${Date.now() - stored.createdAt}ms)`,
    );
    return null;
  }

  return { appId: stored.appId, statements: stored.statements };
}

/**
 * Reads a stored plan without removing it. Use this when you want to apply
 * the plan transactionally and only remove it on success — a failed apply
 * leaves the plan available for retry without forcing the user back through
 * the preview workflow.
 */
export function peekPreview(
  migrationId: string,
): { appId: number; statements: string[] } | null {
  const stored = plansById.get(migrationId);
  if (!stored) {
    return null;
  }
  if (Date.now() - stored.createdAt > PLAN_TTL_MS) {
    logger.info(
      `Migration plan ${migrationId} for app ${stored.appId} expired (age ${Date.now() - stored.createdAt}ms)`,
    );
    plansById.delete(migrationId);
    if (idByAppId.get(stored.appId) === migrationId) {
      idByAppId.delete(stored.appId);
    }
    return null;
  }
  return { appId: stored.appId, statements: stored.statements };
}

export function deletePreview(migrationId: string): void {
  const stored = plansById.get(migrationId);
  if (!stored) return;
  plansById.delete(migrationId);
  if (idByAppId.get(stored.appId) === migrationId) {
    idByAppId.delete(stored.appId);
  }
}

export function __resetForTests(): void {
  plansById.clear();
  idByAppId.clear();
}
