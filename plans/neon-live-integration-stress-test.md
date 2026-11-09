# Neon live integration stress-test plan

Status: implementation and execution plan; no live tests have been run for this plan.

## Objective

Give an AI agent a throwaway Neon account and a reproducible way to find failures in Dyad's Neon integration under repeated operations, concurrency, provider errors, cancellation, and process crashes. Exercise Dyad's actual handlers and services against live Neon databases and Auth, and verify the resulting remote and local state.

Prioritize data isolation, correct branch targeting, recovery, and resource leaks. Measure latency and throughput as supporting evidence. Raw database throughput is a separate workload and should not displace these integration tests.

## Existing foundations and coverage limits

- Extend [the existing live revert suite](../src/ipc/handlers/__tests__/neon_revert.live.integration.test.tsx). It accepts `DYAD_LIVE_NEON_API_KEY`, uses real Neon API/SQL/Auth, and exercises Dyad handlers through the hybrid harness. It already covers legacy development-branch migration near the branch limit and repeated restores of new root development branches.
- Reuse scenarios from [branch integration tests](../src/ipc/handlers/__tests__/neon_branch.integration.test.tsx), [migration integration tests](../src/ipc/handlers/__tests__/neon_migration.integration.test.tsx), [revert integration tests](../src/ipc/handlers/__tests__/neon_revert.integration.test.tsx), and [branch lease integration tests](../src/ipc/services/neon_test_branch_lease.integration.test.ts). Their fake-provider assertions are starting points for live verification.
- The existing live suite replaces `getNeonClient` and organization lookup with a real SDK client. This covers downstream integration behavior, but bypasses production credential acquisition. An API key does **not** establish coverage of OAuth login, callback handling, token refresh, or credential storage. Report those separately as untested unless a dedicated OAuth test session is supplied later.
- Standard `npm run build` sets `E2E_TEST_BUILD=true`. That selects a fake client in [neon_management_client.ts](../src/neon_admin/neon_management_client.ts) and disables real cleanup in [neon_test_data.ts](../src/ipc/utils/neon_test_data.ts). Simply running existing packaged E2E tests with an API key does not prove live integration.
- Use deterministic local LLM fixtures when a chat/tool flow is needed. A paid model account is not a prerequisite for stressing Neon integration.

## 1. Account, scope, and execution limits

Use a dedicated account with synthetic data. Supply the secret through the agent runtime's secret/environment facility as `DYAD_LIVE_NEON_API_KEY`, not in the prompt, source code, command arguments, or reports.

Full project creation/deletion coverage needs a personal or organization key with access to the throwaway organization. A project-scoped key supports a narrower campaign inside a pre-created project; explicitly skip project lifecycle tests in that mode. Neon documents these scopes and that keys remain valid until revoked in [Manage API keys](https://neon.com/docs/manage/api-keys).

Record the expected organization ID and region as non-secret configuration. Inventory existing projects before any mutation. Never infer permission to delete an existing resource just because the account is described as disposable.

Suggested initial limits, to encode in the runner:

| Limit                      | Initial value                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------- |
| Workload deadline          | 120 minutes, followed by a separate 15-minute cleanup window                           |
| Projects                   | At most 2 owned projects at once; at most 6 created per campaign                       |
| Branches                   | At most 10 per project, further constrained by the actual account quota                |
| Active compute endpoints   | At most 8 across the campaign; smallest suitable compute size, with autoscaling capped |
| Concurrent Dyad workflows  | Ramp through 1, 2, then 4                                                              |
| Concurrent SQL requests    | At most 16, using bounded transactions and statement timeouts                          |
| Management API traffic     | Start at 1 request/second aggregate, burst 2, including polling and retries            |
| Auth traffic               | Start at 1 request/second aggregate; reduce on throttling                              |
| Synthetic application data | At most 100 MB total                                                                   |
| Spending                   | Default to the existing Free plan; never upgrade the account or change billing         |

These are campaign limits, not claims about Neon's current limits. Discover project/branch capacity, restore retention, Auth availability, and compute options at preflight; record unavailable features as coverage gaps. Ordinary scenarios reserve at least one free branch slot. Dedicated full-capacity scenarios may use that last slot only when the real quota fits the campaign cap; remove a filler branch before recovery work needs a slot.

On a paid account, require a configured spend ceiling before executing the campaign. Track usage and estimates, but do not present delayed billing data as an instantaneous hard cap; enforce resource and time limits independently. Stop new work when a budget is reached and preserve the cleanup allowance.

## 2. Build the live test harness first

1. Read `AGENTS.md`, `CONTRIBUTING.md`, and the rules for hybrid tests, E2E tests, app operation coordination, and user-app test isolation. Read IPC, database, agent-tool, and error rules before changes in those areas.
2. Add an explicit live-run opt-in in addition to the API key. Keep ordinary `npm test` and CI inert even if a key happens to be present. An explicitly requested live run must fail clearly when credentials or required configuration are missing, rather than reporting success with zero tests.
3. Reuse the hybrid harness with isolated SQLite, app directories, settings, Git configuration, and runtime state. Use process isolation for campaigns that share module-level mocks. Run test files serially initially and create concurrency explicitly inside scenarios.
4. Use the real SDK and Node networking as the current live suite does: its HTTP adapter and Node fetch avoid happy-dom dropping authorization headers. Keep real SQL, Auth, branch operations, migration execution, leases, and cleanup enabled. Audit `IS_TEST_BUILD` shortcuts before accepting a scenario as live.
5. Prove connectivity with a unique run marker: create a fixture, write a marker through the tested path, and independently read it from the expected live branch. Record provider-returned resource IDs and operation outcomes. Fail if fake-provider identifiers or simulator endpoints are used unexpectedly.
6. Add shared request budgets, seeded scenario scheduling, event-based synchronization, operation deadlines, and structured metrics. Poll provider operation completion and SQL/Auth readiness with bounded backoff. A terminal provider operation marked failed is a failure, not readiness.
7. Keep fixture setup retries separate from behavior under test. Do not wrap every Dyad action in an extra retry that conceals a missing production retry, duplicate mutation, or lost error. Record first-attempt and eventual outcomes separately.
8. Keep raw keys, database URLs/passwords, session cookies, Auth tokens, and connection-bearing SDK error objects out of logs and artifacts. Test the redactor with a synthetic secret, then scan retained reports, traces, and screenshots before sharing them.

Proposed additions:

- `src/testing/live_neon/`: real client setup, owned-resource journal, fixtures, invariant checks, metrics, and transport fault controls.
- Focused `*.live.integration.test.ts(x)` files beside the handlers/services they exercise.
- A separate supervisor/cleanup entry point and an npm script such as `test:neon:live`, with `smoke`, `standard`, and `soak` profiles.
- Explicit selection of live files; do not accidentally run the whole repository suite with live credentials.

These additions and scripts do not exist yet. Preserve the current live suite's regression assertions while adopting the stronger opt-in, redaction, and ownership journal.

## 3. Make cleanup survive a crash

The existing suite keeps project IDs in memory and deletes them in `afterEach`. Strengthen this before increasing load: an abrupt exit bypasses hooks, and a handler can create a project remotely before it returns an ID to the test.

- Generate a unique campaign ID and project name prefix. Persist creation intent before sending the request and the returned project ID immediately at the SDK boundary, before Auth/branch setup continues. Journal branch IDs, owner/run IDs, and cleanup state without credentials.
- Keep the journal outside worker temporary directories. A separate supervisor reads it after normal completion, worker failure, timeout, or crash. Provide a cleanup-only command that can run later with the same journal and credentials.
- Reconcile ambiguous creates using the exact unique name, expected organization, baseline inventory, and creation window. Paginate inventories. Do not blindly retry a non-idempotent create or delete resources based only on a generic `dyad-*` prefix.
- First fence new work and stop owned processes; drain mutations or record unresolved outcomes. Exercise Dyad's own teardown/recovery and record its result **before** the supervisor removes leftovers. Successful emergency cleanup must not hide a product leak.
- Await provider operations, delete only owned resources, and verify their absence. Retry transient cleanup failures within the cleanup budget. Retain unresolved IDs and return a failing/incomplete result if verification is impossible.
- Use expiration as a fallback only for suitable disposable leaf branches. Neon prohibits expiration on default, protected, and parent branches, so it cannot replace campaign cleanup. See [Branch expiration](https://neon.com/docs/guides/branch-expiration).

Test this machinery by terminating a child test process after remote resource creation, then invoking the cleanup-only path. Include a pre-existing sentinel resource and verify it survives untouched.

## 4. Scenario matrix

Use isolated projects containing `main`, root `development`, `preview`, and temporary test branches. Here, “production” means the throwaway project's main branch. Seed distinguishable markers in each branch and app so incorrect targeting becomes an assertion failure.

| Priority / area                      | Live scenarios                                                                                                                                                                                                                   | Required assertions                                                                                                                                                                                                                                  |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0: project and branch lifecycle     | Create through Dyad; link an existing fixture project; switch branches repeatedly; unlink/relink; attempt missing or deleted targets; interrupt partial provisioning.                                                            | SQLite IDs, environment files, runtime target, and remote branch tree agree. Unlinking does not delete the remote project. No silent fallback to production. Partial work remains recoverable.                                                       |
| P0: SQL and schema                   | Exercise Dyad SQL/schema paths with tables, foreign keys, views, partitions, quoted identifiers, JSON, sequences, and RLS fixtures. Test valid transactions, a failing statement, and timeouts.                                  | Reads/writes hit the selected branch. Failed transactions do not partially commit. Schema results match direct catalog reads. RLS tests use a restricted role/session rather than the owner connection.                                              |
| P0: migrations                       | Preview/apply additive and destructive schema changes; no-op; wrong-app/replayed plan; concurrent apply; change project/default branch after preview; change the target schema out of band; inject failure mid-transaction.      | Diffing uses unpooled connections. Reviewed target matches execution. Destructive effects are flagged. Failure does not leave a partial migration; stale/duplicate plans cannot silently affect the wrong database. Record any drift detection gaps. |
| P0: restore and legacy migration     | Extend the existing live suite with repeated version restores; rows and Auth users before/after checkpoints; legacy child-development trees near capacity; unrelated branch preservation.                                        | Intended data/version restored, Auth usable afterward, local IDs and env reconciled, and backup branches return to the expected steady-state count. Production and unrelated branches remain unchanged.                                              |
| P0: Tests-panel isolation            | Use real `isolated_test_db`, branch leases, per-case lifecycle hooks, and a small generated Playwright fixture. Cover two cases, a retry, failure, cancellation, and batch execution.                                            | Each case/retry begins with clean user data. Parent/development/main markers remain unchanged. Preserve `neon_auth.project_config`, `jwks`, migration bookkeeping, and extension-owned tables. Auth signup/signin still works after cleanup.         |
| P0: concurrency and capacity         | Overlap runs for the same app, two apps on one project, and independent projects. Fill branch capacity within limits, queue more work, cancel a waiter, release a lease, and toggle parallel execution during setup.             | Every run owns its temporary branch. Wait notices are per run; releasing one run does not delete another's branch. Eligible work resumes; cancellation releases ownership; independent work progresses. No indefinite lock/lease wait.               |
| P0: teardown and restart             | Cancel during create, Auth provisioning, env switch, SQL cleanup, and branch delete. Kill a worker at named lifecycle events and restart with the same isolated durable state. Delete a local app with pending provider cleanup. | No late callback replaces a newer branch target. Cleanup records survive until remote deletion is verified. Production recovery discovers orphans; a stale live owner cannot hold capacity forever.                                                  |
| P1: Auth and browser routing         | Real signup/signin/signout, session after branch switch/restore, two app previews, trusted domains, and configuration changes. Cover Next.js and Vite/Nitro fixtures where supported.                                            | Correct branch Auth URL and per-app session behavior; no session/credential leakage across apps. API-only Auth success is reported separately from browser cookie/origin coverage.                                                                   |
| P1: external changes and credentials | Delete an owned branch out of band; temporarily select an invalid API key; revoke a separate disposable test key when supported, retaining cleanup credentials.                                                                  | Clear classified error, bounded retries, no fallback to another provider/branch, and preserved recoverable state. OAuth refresh remains a separate coverage gap.                                                                                     |

For SQL/tool paths, call the real implementation with deterministic inputs. Seed data and independently inspect results with direct SDK/SQL calls, but do not replace the Dyad operation being tested with an SDK-only equivalent.

Use two or more distinct apps/chats for concurrent chat-flow coverage; do not overlap streams on the same chat in the existing harness. Preserve the repository's single-worker execution inside a shared per-case test branch, while exercising concurrency across independently isolated runs.

## 5. Stress schedule and fault injection

Run phases in this order, stopping escalation when an invariant fails:

1. **Preflight and smoke:** verify account scope/limits, create one fixture, execute SQL and Auth, run the existing restore regression, and prove both normal and supervisor cleanup. Establish baseline timings.
2. **Deterministic regressions:** run the P0 matrix serially. Use named checkpoints/barriers for races instead of hoping sleeps produce overlap.
3. **Concurrency ramp:** run 1, 2, then 4 overlapping workflows. Aim for at least 10 complete lifecycle cycles per level and repeated same-project contention. Keep global resource and request budgets in force.
4. **Fault campaign:** inject a bounded set of failures at named checkpoints: 401/403, 423, 429, 5xx, delayed responses, connection reset, and response loss after the server has already committed a mutation. Verify state before retrying an ambiguous mutation.
5. **Seeded exploration:** aim for 10 recorded seeds of 20 legal actions each, combining switch, SQL, migration, restore, test start/cancel, and relink. Maintain an independent expected-state model and check invariants after each settled transition. Save and minimize a failing action trace into a small regression.
6. **Soak:** after the standard campaign passes, a separately selected four-hour profile repeats the stable mixes and checks branch counts, local handles/processes, queue depth, and memory trends at equivalent idle checkpoints.

Use a local transport wrapper/proxy for deliberate errors while successful calls still reach real Neon. Label these results **live Neon with injected transport faults**. Record natural provider throttling/locking separately; do not generate an uncontrolled request flood to force 429s. Respect `Retry-After` when supplied and reduce load after throttling. Recheck current guidance in [Neon's API documentation](https://neon.com/docs/reference/api) before execution.

Fault controls must cover the actual transport involved: the SDK HTTP adapter, serverless SQL fetch/WebSocket, or Auth fetch. An HTTP proxy configured only for the Management API does not prove SQL or Auth failure handling.

Iteration counts are targets within the hard deadline. Report unfinished scenarios and actual counts explicitly; a run that exhausts its budget is not a completed campaign. Initial suggested deadlines are 30 seconds for ordinary SQL and 180 seconds for provider readiness, with separately documented longer migration/restore limits based on the smoke run. Preserve nested lifecycle timeout ordering in `rules/user-app-test-isolation.md`.

## 6. A small real Electron/browser pass

After the service-level suite is reliable, add one or two broad packaged journeys: connect/switch/run isolated tests, and migrate/restore/restart. Use a separate profile and the supported build workflow; rebuild after application changes.

Implement an explicit test-only live-provider configuration and audit every provider bypass before running these journeys. Retain isolated userData, app paths, and credentials; never attach to the developer's normal profile. Assert a live SQL marker and real per-case cleanup from the packaged process. Do not count these journeys as live merely because the test runner can make an independent Neon request.

## 7. Evidence, findings, and completion

For every scenario retain a sanitized record of:

- Commit, dependency versions, campaign/seed/scenario IDs, profile, region, observed quotas, workload parameters, and exact rerun command without credentials.
- Attempted/completed/failed/cancelled/skipped counts; skip reasons; first-attempt failures; retries and provider status codes; queue wait, provider time, and total time.
- p50/p95/max latency with sample counts, throughput, peak owned resources, and resource counts after each teardown. Treat p99 as exploratory when sample size is small.
- Expected versus actual branch tree, marker counts/checksums, schema checks, and local ownership/cleanup records. Include provider request/operation IDs when available, never raw credentials.
- Product cleanup outcome, supervisor cleanup outcome, and final remote inventory. Keep these separate.

Classify each failure as Dyad defect, provider/plan constraint, test harness defect, or environment problem. Preserve the original failing trace before fixes. A proposed product fix should include a narrow regression, targeted live rerun, and the relevant normal tests; do not weaken assertions or silently retry the entire test until it passes. Keep product fixes separate from harness changes for review.

The campaign passes only when all scheduled P0 scenarios ran, there were no unresolved isolation/targeting/data-loss failures, admitted work settled or recovered within its deadline, and no campaign resources remain. Supervisor-rescued leaks remain product failures. Unsupported, skipped, interrupted, and unexecuted cases remain visible; do not turn them into passes.

Deliver the reusable tests and runner, a cleanup-only command, a coverage table, minimal reproducible findings, and a final sanitized report. Revoke the supplied key after cleanup has been independently verified. No commit, PR publication, billing change, or deployment is part of this plan's current execution scope.

## Agent handoff prompt

> Implement and execute `plans/neon-live-integration-stress-test.md` against the dedicated throwaway Neon account configured in your runtime. Use `DYAD_LIVE_NEON_API_KEY` without printing or persisting it in reports. Start by inspecting the existing live revert suite and building the opt-in guard, durable ownership journal, cleanup supervisor, and live connectivity assertions. Then run the standard profile within the documented limits, exercising real Dyad handlers/services against real Neon SQL and Auth. Use deterministic fixtures and explicit concurrency; label injected faults separately. Preserve failing evidence, minimize reproducible bugs, and report coverage gaps honestly. Delete only campaign-owned resources and verify cleanup even after failure. Finish with the tests, exact rerun instructions, findings, and remote cleanup inventory. Do not change billing or publish changes.
