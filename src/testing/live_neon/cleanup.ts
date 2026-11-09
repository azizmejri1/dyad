// Campaign cleanup: reads the ownership journal, reconciles ambiguous
// creates by exact name, deletes only campaign-owned resources, verifies
// their absence, and reports what is left. Used by the supervisor after every
// phase outcome (pass, failure, timeout, crash) and by the cleanup-only
// command, which can run later with the same journal and credentials.
//
// Product/test teardown runs (and is recorded) before this; anything this
// deletes was left behind by them and is reported as such.
//
// Relative imports only: the supervisor CLI loads this through jiti.
import type { Api, ProjectListItem } from "@neondatabase/api-client";
import type { CampaignJournal, JournalActor } from "./journal";
import {
  deleteBranchVerified,
  deleteProjectVerified,
  httpStatus,
  listAllProjects,
  projectExists,
} from "./neon_ops";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Neon may skew clocks slightly; also covers queueing before the request. */
const CREATE_WINDOW_SLACK_MS = 2 * 60_000;

export interface CleanupReport {
  startedAt: string;
  finishedAt: string;
  /** Projects found by name reconciliation or the campaign-prefix sweep. */
  reconciled: Array<{ projectId: string; name: string; reason: string }>;
  /** Resources this cleanup had to delete: test/product teardown left them. */
  supervisorDeleted: Array<{
    kind: "project" | "branch";
    projectId: string;
    branchId?: string;
    name: string;
    createdBy: JournalActor;
  }>;
  /** Owned resources already gone (deleted by tests or Dyad), now verified absent. */
  verifiedAbsent: number;
  unresolved: Array<{
    kind: "project" | "branch" | "intent";
    projectId?: string;
    branchId?: string;
    name?: string;
    reason: string;
  }>;
  sentinels: Array<{
    projectId: string;
    branchId?: string;
    name: string;
    intact: boolean;
  }>;
  /** Campaign-named projects still present after cleanup (should be none). */
  remainingCampaignProjects: Array<{ projectId: string; name: string }>;
  inventoryComplete: boolean;
  /** Intents that a complete inventory showed were never created. */
  intentsNeverCreated: number;
  duplicateCreates: Array<{ name: string; projectIds: string[] }>;
}

export interface CleanupOptions {
  journal: CampaignJournal;
  /** Journaled client with actor "supervisor". */
  client: Api<unknown>;
  timeoutMs: number;
  log?: (message: string) => void;
}

function isTransient(error: unknown): boolean {
  const status = httpStatus(error);
  return (
    status === undefined || status === 423 || status === 429 || status >= 500
  );
}

async function withTransientRetry<T>(
  operation: () => Promise<T>,
  deadline: number,
): Promise<T> {
  let delay = 2_000;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransient(error) || Date.now() + delay > deadline) throw error;
      await sleep(delay);
      delay = Math.min(30_000, delay * 2);
    }
  }
}

export async function cleanupCampaign(
  options: CleanupOptions,
): Promise<CleanupReport> {
  const { journal, client, timeoutMs } = options;
  const log = options.log ?? (() => {});
  const deadline = Date.now() + timeoutMs;
  const report: CleanupReport = {
    startedAt: new Date().toISOString(),
    finishedAt: "",
    reconciled: [],
    supervisorDeleted: [],
    verifiedAbsent: 0,
    unresolved: [],
    sentinels: [],
    remainingCampaignProjects: [],
    inventoryComplete: false,
    intentsNeverCreated: 0,
    duplicateCreates: [],
  };

  let state = journal.state();
  const start = state.start;
  const baseline = new Set(start?.baselineProjectIds ?? []);
  const sentinelProjects = new Set(
    [...state.sentinels.values()]
      .filter((s) => s.kind === "project")
      .map((s) => s.projectId),
  );
  const orgMode = start?.keyMode !== "project";

  // Every create goes through a journaled client, which writes its intent
  // before sending. With nothing journaled the campaign owns nothing, so a
  // provider outage is not worth the whole cleanup window: list once, no
  // retries. The prefix sweep still runs on whatever that listing returns.
  const nothingJournaled =
    state.projectIntents === 0 &&
    state.projects.size === 0 &&
    state.branches.size === 0 &&
    state.sentinels.size === 0;
  const listWithBudget = <T>(operation: () => Promise<T>) =>
    nothingJournaled ? operation() : withTransientRetry(operation, deadline);

  // 1. Inventory (organization keys only; a project-scoped key cannot list).
  let inventory: ProjectListItem[] = [];
  if (orgMode && start) {
    try {
      const listed = await listWithBudget(() =>
        listAllProjects(client, { orgId: start.orgId }),
      );
      inventory = listed.projects;
      report.inventoryComplete = listed.complete;
    } catch (error) {
      log(
        `inventory failed (status ${httpStatus(error) ?? "network"}); deleting journaled IDs only`,
      );
    }
  }

  // 2. Reconcile creates whose result never reached the journal. Exact
  //    unique name, expected organization, outside the baseline, inside the
  //    creation window. Never a generic prefix.
  for (const intent of state.ambiguousIntents) {
    const since = Date.parse(intent.at) - CREATE_WINDOW_SLACK_MS;
    const candidates = inventory.filter(
      (p) =>
        p.name === intent.name &&
        !baseline.has(p.id) &&
        !sentinelProjects.has(p.id) &&
        !state.projects.has(p.id) &&
        Date.parse(p.created_at) >= since &&
        (!intent.orgId || !p.org_id || p.org_id === intent.orgId),
    );
    if (candidates.length > 1) {
      report.duplicateCreates.push({
        name: intent.name,
        projectIds: candidates.map((p) => p.id),
      });
    }
    for (const candidate of candidates) {
      journal.append({
        type: "project-adopted",
        projectId: candidate.id,
        name: candidate.name,
        reason: `create intent ${intent.intentId} reconciled by exact name`,
      });
      report.reconciled.push({
        projectId: candidate.id,
        name: candidate.name,
        reason: "ambiguous create reconciled by exact name",
      });
    }
    if (candidates.length === 0) {
      if (report.inventoryComplete) {
        report.intentsNeverCreated += 1;
      } else {
        report.unresolved.push({
          kind: "intent",
          name: intent.name,
          reason:
            "create outcome unknown and the project inventory is incomplete",
        });
      }
    }
  }

  // 3. Sweep this campaign's unique prefix for anything the journal missed
  //    (a journal defect worth reporting). Baseline and sentinels are exempt.
  if (start?.namePrefix) {
    state = journal.state();
    for (const project of inventory) {
      if (
        project.name.startsWith(start.namePrefix) &&
        !baseline.has(project.id) &&
        !sentinelProjects.has(project.id) &&
        !state.projects.has(project.id)
      ) {
        journal.append({
          type: "project-adopted",
          projectId: project.id,
          name: project.name,
          reason: "campaign-prefix sweep (missing from journal)",
        });
        report.reconciled.push({
          projectId: project.id,
          name: project.name,
          reason: "campaign-prefix sweep (missing from journal)",
        });
      }
    }
  }

  // 4. Delete owned projects and verify absence.
  state = journal.state();
  for (const project of state.projects.values()) {
    if (
      baseline.has(project.projectId) ||
      sentinelProjects.has(project.projectId)
    ) {
      report.unresolved.push({
        kind: "project",
        projectId: project.projectId,
        name: project.name,
        reason:
          "journal claims ownership of a baseline/sentinel project; not deleting",
      });
      continue;
    }
    if (project.deleted && project.verified) {
      report.verifiedAbsent += 1;
      continue;
    }
    try {
      const result = await withTransientRetry(
        () =>
          deleteProjectVerified(client, project.projectId, {
            timeoutMs: Math.max(
              10_000,
              Math.min(120_000, deadline - Date.now()),
            ),
          }),
        deadline,
      );
      if (!result.deleted) {
        throw new Error("project still visible after delete");
      }
      journal.append({
        type: "deleted",
        kind: "project",
        projectId: project.projectId,
        actor: "supervisor",
        verified: true,
      });
      if (result.alreadyAbsent) {
        report.verifiedAbsent += 1;
      } else {
        report.supervisorDeleted.push({
          kind: "project",
          projectId: project.projectId,
          name: project.name,
          createdBy: project.actor,
        });
        log(`deleted leftover project ${project.projectId} (${project.name})`);
      }
    } catch (error) {
      const reason = `delete/verify failed (status ${httpStatus(error) ?? "network"}): ${(error as Error).message}`;
      journal.append({
        type: "unresolved",
        kind: "project",
        projectId: project.projectId,
        reason,
      });
      report.unresolved.push({
        kind: "project",
        projectId: project.projectId,
        name: project.name,
        reason,
      });
    }
  }

  // 5. Branches created in projects the campaign does not own (project-scoped
  //    keys). Branches in owned projects went with their project.
  state = journal.state();
  for (const branch of state.branches.values()) {
    if (state.projects.has(branch.projectId)) continue;
    if (state.sentinels.has(branch.branchId)) continue;
    if (branch.deleted && branch.verified) {
      report.verifiedAbsent += 1;
      continue;
    }
    try {
      const result = await withTransientRetry(
        () =>
          deleteBranchVerified(client, branch.projectId, branch.branchId, {
            timeoutMs: Math.max(
              10_000,
              Math.min(120_000, deadline - Date.now()),
            ),
          }),
        deadline,
      );
      if (!result.deleted) throw new Error("branch still visible after delete");
      journal.append({
        type: "deleted",
        kind: "branch",
        projectId: branch.projectId,
        branchId: branch.branchId,
        actor: "supervisor",
        verified: true,
      });
      if (result.alreadyAbsent) {
        report.verifiedAbsent += 1;
      } else {
        report.supervisorDeleted.push({
          kind: "branch",
          projectId: branch.projectId,
          branchId: branch.branchId,
          name: branch.name,
          createdBy: branch.actor,
        });
      }
    } catch (error) {
      const reason = `delete/verify failed (status ${httpStatus(error) ?? "network"}): ${(error as Error).message}`;
      journal.append({
        type: "unresolved",
        kind: "branch",
        projectId: branch.projectId,
        branchId: branch.branchId,
        reason,
      });
      report.unresolved.push({
        kind: "branch",
        projectId: branch.projectId,
        branchId: branch.branchId,
        name: branch.name,
        reason,
      });
    }
  }

  // 6. Sentinels must have survived untouched.
  for (const sentinel of state.sentinels.values()) {
    let intact = false;
    try {
      if (sentinel.kind === "project") {
        intact = await withTransientRetry(async () => {
          if (!(await projectExists(client, sentinel.projectId))) return false;
          const { data } = await client.getProject(sentinel.projectId);
          return data.project.name === sentinel.name;
        }, deadline);
      } else if (sentinel.branchId) {
        const branchId = sentinel.branchId;
        intact = await withTransientRetry(async () => {
          try {
            const { data } = await client.getProjectBranch(
              sentinel.projectId,
              branchId,
            );
            return data.branch.name === sentinel.name;
          } catch (error) {
            if (httpStatus(error) === 404) return false;
            throw error;
          }
        }, deadline);
      }
    } catch {
      intact = false;
    }
    report.sentinels.push({
      projectId: sentinel.projectId,
      branchId: sentinel.branchId,
      name: sentinel.name,
      intact,
    });
  }

  // 7. Final inventory: no campaign-named project may remain (sentinels aside).
  if (orgMode && start?.namePrefix) {
    try {
      const after = await listWithBudget(() =>
        listAllProjects(client, { orgId: start.orgId }),
      );
      report.inventoryComplete = report.inventoryComplete && after.complete;
      report.remainingCampaignProjects = after.projects
        .filter(
          (p) =>
            p.name.startsWith(start.namePrefix) &&
            !baseline.has(p.id) &&
            !sentinelProjects.has(p.id),
        )
        .map((p) => ({ projectId: p.id, name: p.name }));
    } catch (error) {
      report.inventoryComplete = false;
      report.unresolved.push({
        kind: "intent",
        reason: `final inventory failed (status ${httpStatus(error) ?? "network"})`,
      });
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

/** Clean means: nothing unresolved, nothing remaining, sentinels intact. */
export function cleanupIsClean(report: CleanupReport): boolean {
  return (
    report.unresolved.length === 0 &&
    report.remainingCampaignProjects.length === 0 &&
    report.sentinels.every((s) => s.intact)
  );
}
