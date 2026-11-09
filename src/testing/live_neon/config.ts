// Live Neon campaign configuration and opt-in guard.
//
// Live suites run only when the campaign supervisor (`npm run test:neon:live`)
// launches them. An API key alone never enables them, so ordinary `npm test`
// and CI stay inert even if DYAD_LIVE_NEON_API_KEY happens to be present. When
// the opt-in is set, missing credentials or configuration fail loudly at
// collection time instead of reporting success with zero tests.
//
// This module is shared by the vitest suites and the jiti-run supervisor CLI,
// so it must use relative imports only (no `@/` aliases).
import fs from "node:fs";
import path from "node:path";

export const LIVE_ENV = {
  /** Must be "1". Set by the supervisor, never by a developer shell profile. */
  optIn: "DYAD_LIVE_NEON",
  apiKey: "DYAD_LIVE_NEON_API_KEY",
  /** Expected organization (personal/org key mode). Non-secret. */
  orgId: "DYAD_LIVE_NEON_ORG_ID",
  /** Pre-created project (project-scoped key mode). Non-secret. */
  projectId: "DYAD_LIVE_NEON_PROJECT_ID",
  /** Expected region, e.g. aws-us-east-2. Non-secret. */
  region: "DYAD_LIVE_NEON_REGION",
  campaignId: "DYAD_LIVE_NEON_CAMPAIGN_ID",
  journal: "DYAD_LIVE_NEON_JOURNAL",
  runDir: "DYAD_LIVE_NEON_RUN_DIR",
  profile: "DYAD_LIVE_NEON_PROFILE",
  seed: "DYAD_LIVE_NEON_SEED",
  phase: "DYAD_LIVE_NEON_PHASE",
  /** Epoch ms after which scenarios must stop admitting new work. */
  deadline: "DYAD_LIVE_NEON_DEADLINE",
  /** Crash-probe variant for the cleanup machinery self-test. */
  crashProbe: "DYAD_LIVE_NEON_CRASH_PROBE",
} as const;

export type LiveNeonProfile = "smoke" | "standard" | "soak";
export type LiveNeonKeyMode = "organization" | "project";

/**
 * Campaign limits from plans/neon-live-integration-stress-test.md. These are
 * this campaign's caps, not claims about Neon's limits; preflight records the
 * account's actual quotas next to them.
 */
export const CAMPAIGN_LIMITS = {
  workloadDeadlineMs: 120 * 60_000,
  cleanupWindowMs: 15 * 60_000,
  soakDeadlineMs: 4 * 60 * 60_000,
  maxConcurrentProjects: 2,
  // The plan suggests 6 per campaign. That covers the smoke profile; the
  // standard and soak profiles create one project per suite, so their caps
  // live in PROFILE_WORKLOAD and are recorded in the report.
  maxProjectsPerCampaign: 6,
  maxBranchesPerProject: 10,
  /** Ordinary scenarios keep this many branch slots free. */
  reservedBranchSlots: 1,
  maxActiveEndpoints: 8,
  concurrencyLevels: [1, 2, 4] as const,
  maxConcurrentSql: 16,
  managementRequestsPerSecond: 1,
  managementBurst: 2,
  authRequestsPerSecond: 1,
  maxSyntheticDataBytes: 100 * 1024 * 1024,
  sqlTimeoutMs: 30_000,
  providerReadinessMs: 180_000,
  /** Longer limits for migration/restore; revisit after the smoke run. */
  migrationTimeoutMs: 300_000,
  restoreTimeoutMs: 300_000,
} as const;

/** Per-profile workload sizing. Targets, not guarantees: report actual counts. */
export const PROFILE_WORKLOAD: Record<
  LiveNeonProfile,
  {
    deadlineMs: number;
    maxProjectsPerCampaign: number;
    cyclesPerConcurrencyLevel: number;
    explorationSeeds: number;
    actionsPerSeed: number;
  }
> = {
  smoke: {
    deadlineMs: 30 * 60_000,
    maxProjectsPerCampaign: CAMPAIGN_LIMITS.maxProjectsPerCampaign,
    cyclesPerConcurrencyLevel: 0,
    explorationSeeds: 0,
    actionsPerSeed: 0,
  },
  standard: {
    deadlineMs: CAMPAIGN_LIMITS.workloadDeadlineMs,
    maxProjectsPerCampaign: 16,
    cyclesPerConcurrencyLevel: 10,
    explorationSeeds: 10,
    actionsPerSeed: 20,
  },
  soak: {
    deadlineMs: CAMPAIGN_LIMITS.soakDeadlineMs,
    maxProjectsPerCampaign: 24,
    cyclesPerConcurrencyLevel: 10,
    explorationSeeds: 10,
    actionsPerSeed: 20,
  },
};

export interface LiveNeonConfig {
  apiKey: string;
  keyMode: LiveNeonKeyMode;
  orgId?: string;
  projectId?: string;
  region?: string;
  campaignId: string;
  /** Every campaign-created project name starts with this. */
  namePrefix: string;
  journalPath: string;
  runDir: string;
  profile: LiveNeonProfile;
  seed: number;
  phase: string;
  deadline: number;
}

export type LiveNeonGate =
  | { enabled: false; reason: string }
  | { enabled: true; config: LiveNeonConfig };

const CAMPAIGN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,40}$/;

/** Unique, Neon-name-safe prefix for every resource this campaign creates. */
export function campaignNamePrefix(campaignId: string): string {
  return `dyad-live-${campaignId}`;
}

export function isProfile(value: string): value is LiveNeonProfile {
  return value === "smoke" || value === "standard" || value === "soak";
}

/**
 * Decides whether live suites run. Throws (failing collection) when the
 * opt-in is present but the run is misconfigured.
 */
export function liveNeonGate(
  env: NodeJS.ProcessEnv = process.env,
): LiveNeonGate {
  if (env[LIVE_ENV.optIn] !== "1") {
    return {
      enabled: false,
      reason: `${LIVE_ENV.optIn} is not "1"; live Neon suites run only via npm run test:neon:live`,
    };
  }
  const problems: string[] = [];
  const apiKey = env[LIVE_ENV.apiKey]?.trim();
  if (!apiKey) problems.push(`${LIVE_ENV.apiKey} is not set`);
  const orgId = env[LIVE_ENV.orgId]?.trim() || undefined;
  const projectId = env[LIVE_ENV.projectId]?.trim() || undefined;
  if (!orgId && !projectId) {
    problems.push(
      `set ${LIVE_ENV.orgId} (organization/personal key) or ${LIVE_ENV.projectId} (project-scoped key)`,
    );
  }
  const campaignId = env[LIVE_ENV.campaignId]?.trim() ?? "";
  if (!CAMPAIGN_ID_PATTERN.test(campaignId)) {
    problems.push(`${LIVE_ENV.campaignId} is missing or malformed`);
  }
  const journalPath = env[LIVE_ENV.journal]?.trim() ?? "";
  if (!journalPath || !path.isAbsolute(journalPath)) {
    problems.push(`${LIVE_ENV.journal} must be an absolute path`);
  } else if (!fs.existsSync(journalPath)) {
    problems.push(
      `${LIVE_ENV.journal} does not exist; the supervisor creates it before launching suites`,
    );
  }
  const runDir = env[LIVE_ENV.runDir]?.trim() ?? "";
  if (!runDir || !path.isAbsolute(runDir)) {
    problems.push(`${LIVE_ENV.runDir} must be an absolute path`);
  }
  const profile = env[LIVE_ENV.profile]?.trim() ?? "";
  if (!isProfile(profile)) {
    problems.push(`${LIVE_ENV.profile} must be smoke, standard or soak`);
  }
  const seed = Number(env[LIVE_ENV.seed] ?? "1");
  if (!Number.isInteger(seed))
    problems.push(`${LIVE_ENV.seed} must be an integer`);
  const deadline = Number(env[LIVE_ENV.deadline] ?? "");
  if (!Number.isFinite(deadline) || deadline <= 0) {
    problems.push(`${LIVE_ENV.deadline} must be an epoch-ms deadline`);
  }
  if (problems.length > 0) {
    throw new Error(
      `Live Neon run requested (${LIVE_ENV.optIn}=1) but misconfigured:\n- ${problems.join("\n- ")}\nStart live runs with: npm run test:neon:live -- --profile smoke`,
    );
  }
  return {
    enabled: true,
    config: {
      apiKey: apiKey!,
      keyMode: projectId && !orgId ? "project" : "organization",
      orgId,
      projectId,
      region: env[LIVE_ENV.region]?.trim() || undefined,
      campaignId,
      namePrefix: campaignNamePrefix(campaignId),
      journalPath,
      runDir,
      profile: profile as LiveNeonProfile,
      seed,
      phase: env[LIVE_ENV.phase]?.trim() || "adhoc",
      deadline,
    },
  };
}

/** Remaining workload budget; scenarios stop admitting work when it is spent. */
export function remainingMs(config: LiveNeonConfig, now = Date.now()): number {
  return config.deadline - now;
}
