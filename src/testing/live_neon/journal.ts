// Durable ownership journal for a live Neon campaign.
//
// Append-only JSONL, fsynced per record, kept outside worker temp
// directories. Creation intent is written BEFORE the request is sent and the
// provider-returned ID immediately at the SDK boundary, so a crash between
// "Neon created it" and "the test learned its ID" still leaves enough to find
// and delete the resource. Records never contain credentials.
//
// Relative imports only: the supervisor CLI loads this through jiti.
import fs from "node:fs";
import { randomUUID } from "node:crypto";

/** Who caused a mutation: Dyad code under test, test setup, or cleanup. */
export type JournalActor = "product" | "fixture" | "verifier" | "supervisor";

export type ResourceKind = "project" | "branch";

export type JournalRecordBody =
  | {
      type: "campaign-start";
      campaignId: string;
      profile: string;
      namePrefix: string;
      keyMode: "organization" | "project";
      orgId?: string;
      projectScopeId?: string;
      region?: string;
      /** Every project visible before the campaign mutated anything. */
      baselineProjectIds: string[];
      baselineComplete: boolean;
    }
  | {
      type: "project-create-intent";
      intentId: string;
      name: string;
      orgId?: string;
      actor: JournalActor;
    }
  | {
      type: "project-created";
      intentId?: string;
      projectId: string;
      name: string;
      actor: JournalActor;
    }
  | {
      type: "project-create-failed";
      intentId: string;
      status?: number;
      /** True when Neon may have created the project anyway (5xx, lost response). */
      ambiguous: boolean;
      actor: JournalActor;
    }
  | { type: "project-adopted"; projectId: string; name: string; reason: string }
  | {
      type: "branch-created";
      projectId: string;
      branchId: string;
      name: string;
      hasEndpoint: boolean;
      actor: JournalActor;
    }
  | {
      type: "deleted";
      kind: ResourceKind;
      projectId: string;
      branchId?: string;
      actor: JournalActor;
      /** Absence was confirmed by a follow-up read (404), not just a 2xx. */
      verified: boolean;
    }
  | {
      type: "sentinel";
      kind: ResourceKind;
      projectId: string;
      branchId?: string;
      name: string;
    }
  | { type: "sentinel-retired"; projectId: string; branchId?: string }
  | { type: "fence"; reason: string }
  | {
      type: "unresolved";
      kind: ResourceKind;
      projectId: string;
      branchId?: string;
      reason: string;
    }
  | {
      type: "phase";
      phase: string;
      status:
        | "started"
        | "passed"
        | "failed"
        | "timed-out"
        | "crashed"
        | "skipped";
      detail?: string;
    }
  | {
      type: "worker";
      event: "start" | "exit";
      phase: string;
      userDataDir?: string;
    }
  | { type: "note"; message: string };

export type JournalRecord = JournalRecordBody & {
  at: string;
  pid: number;
  writer: string;
};

export interface OwnedProject {
  projectId: string;
  name: string;
  actor: JournalActor;
  createdAt: string;
  adopted: boolean;
  deleted: boolean;
  verified: boolean;
  deletedBy?: JournalActor;
}

export interface OwnedBranch {
  projectId: string;
  branchId: string;
  name: string;
  actor: JournalActor;
  hasEndpoint: boolean;
  deleted: boolean;
  verified: boolean;
  deletedBy?: JournalActor;
}

export interface CampaignState {
  start?: Extract<JournalRecord, { type: "campaign-start" }>;
  fenced: boolean;
  projects: Map<string, OwnedProject>;
  branches: Map<string, OwnedBranch>;
  /** Create requests whose outcome is unknown: reconcile by exact name. */
  ambiguousIntents: Array<
    Extract<JournalRecord, { type: "project-create-intent" }>
  >;
  projectIntents: number;
  sentinels: Map<string, Extract<JournalRecord, { type: "sentinel" }>>;
  unresolved: Array<Extract<JournalRecord, { type: "unresolved" }>>;
}

export class CampaignJournal {
  constructor(
    readonly path: string,
    readonly writer: string,
  ) {}

  /** Creates the file (and fails if it exists, to avoid mixing campaigns). */
  static create(path: string, writer: string): CampaignJournal {
    fs.writeFileSync(path, "", { flag: "wx", mode: 0o600 });
    return new CampaignJournal(path, writer);
  }

  append<T extends JournalRecordBody>(body: T): T & JournalRecord {
    const record = {
      ...body,
      at: new Date().toISOString(),
      pid: process.pid,
      writer: this.writer,
    } as T & JournalRecord;
    const line = `${JSON.stringify(record)}\n`;
    // O_APPEND keeps concurrent single-line writes from different processes
    // whole; fsync makes the record survive an abrupt exit right after.
    const fd = fs.openSync(this.path, "a");
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return record;
  }

  newIntentId(): string {
    return randomUUID();
  }

  read(): JournalRecord[] {
    return readJournal(this.path);
  }

  state(): CampaignState {
    return deriveCampaignState(this.read());
  }
}

/** Tolerates a torn final line from a crash mid-write. */
export function readJournal(path: string): JournalRecord[] {
  if (!fs.existsSync(path)) return [];
  const records: JournalRecord[] = [];
  const lines = fs.readFileSync(path, "utf8").split("\n");
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      records.push(JSON.parse(line) as JournalRecord);
    } catch (error) {
      if (
        index < lines.length - 1 &&
        lines.slice(index + 1).some((l) => l.trim())
      ) {
        throw new Error(
          `Corrupt journal record at line ${index + 1} of ${path}`,
          {
            cause: error,
          },
        );
      }
      // Torn final record: the request it described was either never sent
      // (intent) or will be found by name reconciliation.
    }
  });
  return records;
}

export function deriveCampaignState(records: JournalRecord[]): CampaignState {
  const state: CampaignState = {
    fenced: false,
    projects: new Map(),
    branches: new Map(),
    ambiguousIntents: [],
    projectIntents: 0,
    sentinels: new Map(),
    unresolved: [],
  };
  const intents = new Map<
    string,
    Extract<JournalRecord, { type: "project-create-intent" }>
  >();
  const resolvedIntents = new Set<string>();
  for (const record of records) {
    switch (record.type) {
      case "campaign-start":
        state.start ??= record;
        break;
      case "fence":
        state.fenced = true;
        break;
      case "project-create-intent":
        intents.set(record.intentId, record);
        state.projectIntents += 1;
        break;
      case "project-created":
      case "project-adopted": {
        if (record.type === "project-created" && record.intentId) {
          resolvedIntents.add(record.intentId);
        }
        const existing = state.projects.get(record.projectId);
        state.projects.set(record.projectId, {
          projectId: record.projectId,
          name: record.name,
          actor:
            record.type === "project-created"
              ? record.actor
              : (existing?.actor ?? "product"),
          createdAt: existing?.createdAt ?? record.at,
          adopted:
            record.type === "project-adopted" || (existing?.adopted ?? false),
          deleted: existing?.deleted ?? false,
          verified: existing?.verified ?? false,
          deletedBy: existing?.deletedBy,
        });
        break;
      }
      case "project-create-failed":
        if (!record.ambiguous) resolvedIntents.add(record.intentId);
        break;
      case "branch-created":
        state.branches.set(record.branchId, {
          projectId: record.projectId,
          branchId: record.branchId,
          name: record.name,
          actor: record.actor,
          hasEndpoint: record.hasEndpoint,
          deleted: false,
          verified: false,
        });
        break;
      case "deleted":
        if (record.kind === "project") {
          const project = state.projects.get(record.projectId);
          if (project) {
            project.deleted = true;
            project.verified ||= record.verified;
            project.deletedBy ??= record.actor;
          }
          // Deleting a project deletes all of its branches.
          for (const branch of state.branches.values()) {
            if (branch.projectId === record.projectId) {
              branch.deleted = true;
              branch.verified ||= record.verified;
              branch.deletedBy ??= record.actor;
            }
          }
        } else if (record.branchId) {
          const branch = state.branches.get(record.branchId);
          if (branch) {
            branch.deleted = true;
            branch.verified ||= record.verified;
            branch.deletedBy ??= record.actor;
          }
        }
        break;
      case "sentinel":
        state.sentinels.set(record.branchId ?? record.projectId, record);
        break;
      case "sentinel-retired":
        state.sentinels.delete(record.branchId ?? record.projectId);
        break;
      case "unresolved":
        state.unresolved.push(record);
        break;
      default:
        break;
    }
  }
  // Unresolved = no ID came back and no definitive (4xx) rejection either:
  // the request may never have been sent, or Neon may have created it.
  for (const [intentId, intent] of intents) {
    if (!resolvedIntents.has(intentId)) state.ambiguousIntents.push(intent);
  }
  return state;
}

/** Projects created (or adopted) by the campaign and not yet deleted. */
export function liveOwnedProjects(state: CampaignState): OwnedProject[] {
  return [...state.projects.values()].filter((p) => !p.deleted);
}

/**
 * Rough count of running computes the campaign owns: each live project's
 * default branch plus every live campaign-created branch with an endpoint.
 */
export function estimatedActiveEndpoints(state: CampaignState): number {
  const liveProjects = new Set(
    liveOwnedProjects(state).map((p) => p.projectId),
  );
  let count = liveProjects.size;
  for (const branch of state.branches.values()) {
    if (!branch.deleted && branch.hasEndpoint) count += 1;
  }
  return count;
}
