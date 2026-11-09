// Campaign phases (run in this order; escalation stops at the first failure)
// and the plan coverage table the report is built from.
//
// Relative imports only: the supervisor CLI loads this through jiti.
import type { LiveNeonProfile } from "./config";

export interface PhaseDef {
  id: string;
  title: string;
  profiles: LiveNeonProfile[];
  kind: "vitest" | "crash";
  /** Repo-relative test files, run serially in one vitest process. */
  files: string[];
  timeoutMs: number;
  /** Crash probes only. */
  crashVariant?: "fixture" | "product-create";
  /** Soak: repeat until the soak deadline. */
  repeatUntilDeadline?: boolean;
}

const HANDLERS = "src/ipc/handlers/__tests__";
const SERVICES = "src/ipc/services";
const LIVE = "src/testing/live_neon";

export const PHASES: PhaseDef[] = [
  {
    id: "smoke",
    title: "Preflight smoke: live connectivity, SQL, Auth, restore regression",
    profiles: ["smoke", "standard"],
    kind: "vitest",
    files: [
      `${HANDLERS}/neon_smoke.live.integration.test.tsx`,
      `${HANDLERS}/neon_revert.live.integration.test.tsx`,
    ],
    timeoutMs: 30 * 60_000,
  },
  {
    id: "crash-cleanup",
    title:
      "Cleanup machinery: SIGKILL a worker after remote creation, then cleanup-only",
    profiles: ["smoke", "standard"],
    kind: "crash",
    crashVariant: "fixture",
    files: [`${LIVE}/crash_probe.live.integration.test.ts`],
    timeoutMs: 10 * 60_000,
  },
  {
    id: "deterministic",
    title: "Deterministic P0 regressions (serial)",
    profiles: ["standard"],
    kind: "vitest",
    files: [
      `${HANDLERS}/neon_lifecycle.live.integration.test.tsx`,
      `${HANDLERS}/neon_sql_schema.live.integration.test.tsx`,
      `${HANDLERS}/neon_migration.live.integration.test.tsx`,
      `${SERVICES}/neon_test_isolation.live.integration.test.ts`,
    ],
    timeoutMs: 50 * 60_000,
  },
  {
    id: "restart-create",
    title: "Teardown/restart: SIGKILL during Dyad createProject provisioning",
    profiles: ["standard"],
    kind: "crash",
    crashVariant: "product-create",
    files: [`${LIVE}/crash_probe.live.integration.test.ts`],
    timeoutMs: 10 * 60_000,
  },
  {
    id: "concurrency",
    title: "Concurrency ramp 1 → 2 → 4 overlapping workflows",
    profiles: ["standard"],
    kind: "vitest",
    files: [`${SERVICES}/neon_concurrency.live.integration.test.ts`],
    timeoutMs: 40 * 60_000,
  },
  {
    id: "faults",
    title: "Fault campaign (live Neon with injected transport faults)",
    profiles: ["standard"],
    kind: "vitest",
    files: [`${HANDLERS}/neon_faults.live.integration.test.tsx`],
    timeoutMs: 30 * 60_000,
  },
  {
    id: "explore",
    title: "Seeded exploration against an independent model",
    profiles: ["standard"],
    kind: "vitest",
    files: [`${HANDLERS}/neon_explore.live.integration.test.tsx`],
    timeoutMs: 40 * 60_000,
  },
  {
    id: "soak",
    title: "Soak: repeat stable mixes, watch counts/handles/memory",
    profiles: ["soak"],
    kind: "vitest",
    files: [
      `${SERVICES}/neon_concurrency.live.integration.test.ts`,
      `${HANDLERS}/neon_explore.live.integration.test.tsx`,
    ],
    timeoutMs: 4 * 60 * 60_000,
    repeatUntilDeadline: true,
  },
];

export function phasesFor(profile: LiveNeonProfile): PhaseDef[] {
  return PHASES.filter((phase) => phase.profiles.includes(profile));
}

export type CoverageStatus =
  | "implemented"
  | "partial"
  | "not-implemented"
  | "gap";

export interface CoverageRow {
  priority: "P0" | "P1" | "infra";
  area: string;
  status: CoverageStatus;
  phases: string[];
  notes: string;
}

/**
 * What the suites exercise per plan area. Status here is about test
 * existence; whether a scenario passed comes from the phase results.
 */
export const COVERAGE: CoverageRow[] = [
  {
    priority: "P0",
    area: "Project and branch lifecycle",
    status: "implemented",
    phases: ["smoke", "deterministic", "faults"],
    notes:
      "Create through Dyad, link an existing project, repeated switching, unlink/relink (remote project kept), deleted/foreign branch targets, injected failure during provisioning.",
  },
  {
    priority: "P0",
    area: "SQL and schema",
    status: "implemented",
    phases: ["smoke", "deterministic"],
    notes:
      "execute_sql tool and transaction executor on the selected branch; FKs, views, partitions, quoted identifiers, JSON, sequences, RLS via a restricted role, failing statement, statement timeout, schema tool vs catalog.",
  },
  {
    priority: "P0",
    area: "Migrations",
    status: "implemented",
    phases: ["deterministic", "faults"],
    notes:
      "Additive/destructive preview+apply, no-op, wrong-app and replayed plans, concurrent apply, default-branch change after preview, out-of-band target change, failure mid-transaction, SQL transport loss during apply. Diffing uses unpooled TCP (no fault hooks).",
  },
  {
    priority: "P0",
    area: "Restore and legacy migration",
    status: "implemented",
    phases: ["smoke", "explore"],
    notes:
      "Existing live revert suite (legacy child tree near the branch cap, repeated root restores, Auth users across checkpoints) plus restores in seeded exploration.",
  },
  {
    priority: "P0",
    area: "Tests-panel isolation",
    status: "partial",
    phases: ["deterministic", "concurrency"],
    notes:
      "Real branch leases, per-case data cleaner (preserves neon_auth.project_config/jwks and migration tables), Auth after cleanup, cancellation and capacity waits. The generated Playwright fixture shim and real runner are not driven (needs a packaged runner + browser).",
  },
  {
    priority: "P0",
    area: "Concurrency and capacity",
    status: "implemented",
    phases: ["concurrency", "deterministic"],
    notes:
      "1/2/4 overlapping lease workflows on one project, filled branch capacity, queued waiter cancellation, release wakes waiters, per-run ownership.",
  },
  {
    priority: "P0",
    area: "Teardown and restart",
    status: "partial",
    phases: ["crash-cleanup", "restart-create", "deterministic", "faults"],
    notes:
      "Real SIGKILL during createProject (no product recovery exists for orphaned projects). Lease crash recovery is exercised in-process (durable SQLite record + reconcileOrphanTestBranches), not across a real process restart.",
  },
  {
    priority: "P1",
    area: "Auth and browser routing",
    status: "partial",
    phases: ["smoke", "deterministic"],
    notes:
      "API-level sign-up/sign-in per branch and after switch/restore/cleanup. Browser cookie/origin behaviour, two app previews and Vite/Nitro runtime routing are not covered.",
  },
  {
    priority: "P1",
    area: "External changes and credentials",
    status: "partial",
    phases: ["deterministic", "faults"],
    notes:
      "Out-of-band branch deletion, injected 401/403, invalid API key. Revoking a disposable key is not automated. OAuth login/callback/refresh/storage are NOT covered: live runs inject an API key at getNeonClient().",
  },
  {
    priority: "infra",
    area: "Packaged Electron journeys (plan section 6)",
    status: "not-implemented",
    phases: [],
    notes:
      "Packaged builds use E2E_TEST_BUILD fakes; a test-only live-provider configuration does not exist yet. Deferred until the service-level campaign is reliable.",
  },
  {
    priority: "infra",
    area: "WebSocket / TCP fault injection",
    status: "gap",
    phases: [],
    notes:
      "Faults cover the Management API adapter and SQL/Auth fetch. Pool/WebSocket SQL and pg TCP (schema diff) have no hooks.",
  },
];
