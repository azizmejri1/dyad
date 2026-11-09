// Low-level, provider-only Neon operations shared by test verifiers and the
// cleanup supervisor. These never go through Dyad code: they are the
// independent view used to check what Dyad did and to remove leftovers.
//
// Relative imports only: the supervisor CLI loads this through jiti.
import type { Api, Branch, ProjectListItem } from "@neondatabase/api-client";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const IN_PROGRESS = new Set(["scheduling", "running", "cancelling"]);
const FAILED = new Set(["failed", "error"]);

export class ProviderOperationFailedError extends Error {
  constructor(
    readonly projectId: string,
    readonly operations: Array<{ id: string; action: string; status: string }>,
  ) {
    super(
      `Neon operation(s) failed in project ${projectId}: ${operations
        .map((o) => `${o.action} ${o.id} ${o.status}`)
        .join(", ")}`,
    );
    this.name = "ProviderOperationFailedError";
  }
}

export function httpStatus(error: unknown): number | undefined {
  const status = (error as { response?: { status?: unknown } } | null)?.response
    ?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Waits for the project's operations to settle with bounded backoff. An
 * operation that ended `failed`/`error` after `since` is a failure, not
 * readiness.
 */
export async function waitForOperations(
  client: Api<unknown>,
  projectId: string,
  { since, timeoutMs = 180_000 }: { since?: Date; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let delay = 500;
  for (;;) {
    const { data } = await client.listProjectOperations({
      projectId,
      limit: 100,
    });
    const operations = data.operations ?? [];
    if (since) {
      const failed = operations.filter(
        (o) => FAILED.has(o.status) && new Date(o.created_at) >= since,
      );
      if (failed.length > 0) {
        throw new ProviderOperationFailedError(
          projectId,
          failed.map((o) => ({ id: o.id, action: o.action, status: o.status })),
        );
      }
    }
    if (!operations.some((o) => IN_PROGRESS.has(o.status))) return;
    if (Date.now() + delay > deadline) {
      throw new Error(
        `Neon operations did not settle within ${timeoutMs}ms for ${projectId}`,
      );
    }
    await sleep(delay);
    delay = Math.min(5_000, Math.round(delay * 1.5));
  }
}

/** Every project visible to the key, following cursors. */
export async function listAllProjects(
  client: Api<unknown>,
  { orgId, search }: { orgId?: string; search?: string } = {},
): Promise<{ projects: ProjectListItem[]; complete: boolean }> {
  const projects: ProjectListItem[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const { data } = await client.listProjects({
      limit: 400,
      ...(orgId ? { org_id: orgId } : {}),
      ...(search ? { search } : {}),
      ...(cursor ? { cursor } : {}),
    });
    const batch = data.projects ?? [];
    projects.push(...batch);
    // A timed-out listing reports projects it could not fetch: the inventory
    // is incomplete and must not be used to prove absence.
    const unavailable = (data as { unavailable_project_ids?: string[] })
      .unavailable_project_ids;
    if (unavailable && unavailable.length > 0)
      return { projects, complete: false };
    const next = data.pagination?.cursor;
    if (batch.length < 400 || !next || seenCursors.has(next)) {
      return { projects: dedupeById(projects), complete: true };
    }
    seenCursors.add(next);
    cursor = next;
  }
  return { projects: dedupeById(projects), complete: false };
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

export async function listBranches(
  client: Api<unknown>,
  projectId: string,
): Promise<Branch[]> {
  const { data } = await client.listProjectBranches({ projectId });
  return data.branches ?? [];
}

export async function projectExists(
  client: Api<unknown>,
  projectId: string,
): Promise<boolean> {
  try {
    await client.getProject(projectId);
    return true;
  } catch (error) {
    if (httpStatus(error) === 404) return false;
    throw error;
  }
}

export async function branchExists(
  client: Api<unknown>,
  projectId: string,
  branchId: string,
): Promise<boolean> {
  try {
    await client.getProjectBranch(projectId, branchId);
    return true;
  } catch (error) {
    if (httpStatus(error) === 404) return false;
    throw error;
  }
}

/** Polls until a read confirms absence. */
async function waitForAbsence(
  check: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let delay = 1_000;
  for (;;) {
    if (!(await check())) return true;
    if (Date.now() + delay > deadline) return false;
    await sleep(delay);
    delay = Math.min(5_000, delay * 2);
  }
}

/**
 * Deletes a project (awaiting in-flight operations first) and confirms a
 * 404. Already-absent counts as deleted.
 */
export async function deleteProjectVerified(
  client: Api<unknown>,
  projectId: string,
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<{ deleted: boolean; alreadyAbsent: boolean }> {
  if (!(await projectExists(client, projectId))) {
    return { deleted: true, alreadyAbsent: true };
  }
  await waitForOperations(client, projectId, { timeoutMs }).catch(() => {
    // Deleting a project cancels its operations; settle is best-effort.
  });
  try {
    await client.deleteProject(projectId);
  } catch (error) {
    if (httpStatus(error) !== 404) throw error;
  }
  const gone = await waitForAbsence(
    () => projectExists(client, projectId),
    timeoutMs,
  );
  return { deleted: gone, alreadyAbsent: false };
}

export async function deleteBranchVerified(
  client: Api<unknown>,
  projectId: string,
  branchId: string,
  { timeoutMs = 120_000 }: { timeoutMs?: number } = {},
): Promise<{ deleted: boolean; alreadyAbsent: boolean }> {
  if (!(await branchExists(client, projectId, branchId))) {
    return { deleted: true, alreadyAbsent: true };
  }
  await waitForOperations(client, projectId, { timeoutMs });
  try {
    await client.deleteProjectBranch(projectId, branchId);
  } catch (error) {
    if (httpStatus(error) !== 404) throw error;
  }
  const gone = await waitForAbsence(
    () => branchExists(client, projectId, branchId),
    timeoutMs,
  );
  return { deleted: gone, alreadyAbsent: false };
}
