# E2E coverage audit: unrealistic tests and untested workflows

Companion to [`plans/better-e2e.md`](./better-e2e.md), which covers a different axis
(speed, flakiness, snapshot churn) and assumes the coverage we have is coverage we can
trust. This document questions that assumption: which workflows have an E2E test that
does not actually prove the workflow works, and which workflows have no E2E test at all.

**Scope of the sweep.** 128 spec files / 253 test cases in `e2e-tests/`, 69
`*.integration.test.*` files, the IPC contract surface in `src/ipc/types/*.ts`, the
`IS_TEST_BUILD` escape hatches in `src/`, and the fake-service routes in
`testing/fake-llm-server/`.

**How "realistic" was judged.** A test is unrealistic when passing it does not
constrain the production behavior a user depends on. Three concrete forms:

1. **No assertion** — the test drives the UI and never checks the result.
2. **Tautological assertion** — the assertion is satisfied by both success and failure
   (`a.or(b)`, `if (!visible) skip`, "the UI didn't freeze").
3. **Stubbed subject** — the code under test is replaced by an `IS_TEST_BUILD` branch or
   a test-only IPC handler, so the test exercises the UI shell around a constant.

The repo already has the good version of each of these seams — the fake GitHub
device-flow + git server, the MCP OAuth server, the socket firewall in
`package_manager.spec.ts`, and the managed-Node installer that redirects only the
download URL/SHA and keeps the real download → verify → extract → exec pipeline. The
findings below are the places that did not adopt those patterns.

---

## Part 1 — Workflows whose E2E tests don't prove the workflow

Ranked by (user-visible risk) × (confidence the test is not carrying its weight).

### 1.1 App search — 8 tests, 292 lines, zero assertions

**Where:** `e2e-tests/app_search.spec.ts`

Not a single `expect()` in the file. What each test actually does:

- _"search functionality with different terms"_ — types `calculator`, `task`, `weather`,
  waits 500 ms after each, asserts nothing. Only the deliberately-nonexistent term gets
  a real check (`app-search-empty`).
- _"navigation and selection"_ — wrapped in `if (searchItems.length > 0) { … } else {
  Escape }`. A search that returns zero results takes the `else` branch and passes.
- _"empty search shows all apps"_ — ends in
  `console.log(\`Found ${searchItems.length} apps\`)`. Cannot fail.
- _"case insensitive search"_ / _"partial word matching"_ — fill, `waitForTimeout(500)`,
  fill again, Escape. Nothing is read back.
- _"basic search dialog functionality"_ / _"keyboard shortcut functionality"_ — only
  open/close/toggle is verified, via `waitFor` rather than `expect`.

Cost is not zero: each test boots Electron and creates 1–3 apps through full fake-LLM
round trips. Eight boots buy dialog-opens-and-closes.

**Proposal.** Replace all 8 with **one** spec that seeds three apps with known names via
IPC (per `better-e2e.md` #3) and asserts the result set at each step: exact-name match
returns exactly that app; a lowercase query matches a mixed-case name; a partial prefix
matches; content-based match (chat text, which the current file claims to test but never
checks) returns the owning app; a nonsense query shows `app-search-empty`; clicking a
result navigates to that app's details route. Drop every `waitForTimeout` in favor of
`expect(...).toHaveCount(n)` — the assertion is the wait. Ranking behavior belongs in a
unit test against the search/scoring function, not in Electron.

### 1.2 Chat search — every test is `test.skip`

**Where:** `e2e-tests/chat_search.spec.ts` (4 of 4 skipped), feature in
`src/components/ChatSearchDialog.tsx`

The file reads as coverage in any inventory, but nothing runs, and the tests wouldn't
assert anything if they were re-enabled (0 `expect()` here too). Chat search also has a
Pro indexer (`src/pro/main/ipc/handlers/local_agent/chat_search_indexer.ts`) with its own
spec, and an agent-facing path covered by `local_agent_search_chats.spec.ts` — so the
*user-facing* search dialog is the uncovered part.

**Proposal.** Delete the four skipped tests. Write one spec that seeds chats with known
titles and message bodies via IPC, opens the dialog by shortcut, asserts a title match
and a body match return the expected chat IDs, asserts the empty state, and asserts that
selecting a result navigates to that chat with the right messages rendered. If the
indexer needs warm-up, assert on it explicitly (`toPass`) instead of sleeping.

### 1.3 Custom provider create / edit / delete — "the UI hasn't frozen"

**Where:** `e2e-tests/edit_provider.spec.ts`, `e2e-tests/delete_provider.spec.ts`

`edit_provider.spec.ts` contains the comment `// Create a provider first` followed by no
code, fills two fields, clicks **Update Provider**, and ends at `// Make sure UI hasn't
freezed` — with no assertion at all. `delete_provider.spec.ts` deletes a provider and
verifies only that navigating to the Apps tab still works. Neither checks that the
provider was actually created, updated, or removed, and neither checks that a model from
that provider can still be selected afterwards.

**Proposal.** Fold both into one provider-lifecycle spec: create a custom provider
through the dialog → assert it appears in the provider list and in the model picker →
edit its display name and base URL → assert the list reflects the edit **and** that a
message sent with its model reaches the new base URL (the fake LLM server can host a
second mount point for this) → delete it → assert it's gone from the list and from the
model picker, and that no orphan model remains selectable.

### 1.4 Supabase and Neon "connect" never touch the connect flow

**Where:** `src/components/SupabaseConnector.tsx:190`,
`src/components/NeonConnector.tsx:160`; handlers
`supabase:fake-connect-and-set-project` (`supabase_handlers.ts:241`) and
`neon:fake-connect` (`neon_handlers.ts:971`); tests `e2e-tests/supabase_client.spec.ts`,
`e2e-tests/supabase_dependency_analysis.spec.ts`

Production components branch on `settings?.isTestMode` and call a **test-only IPC
handler** instead of starting OAuth. So "Connect to Supabase" in E2E means: click a
button that writes a fake project row. The OAuth handshake, token exchange, token
persistence, org/project listing, error handling, and the connection-flow state machine
are all bypassed.

Everything downstream is stubbed too:

- `src/supabase_admin/supabase_management_client.ts` — 9 `IS_TEST_BUILD` early returns
  (orgs, members, project details, API keys…)
- `src/supabase_admin/supabase_context.ts` — 5 more, including the schema and project
  info fed to the model
- `src/neon_admin/neon_context.ts` — 6, including `executeNeonSql` returning
  `` `[[TEST_NEON_SQL_RESULT: …]]` `` and `getNeonProjectInfo` returning a fixed
  markdown block

The repo already knows how to do this properly: GitHub's device flow, user/repo/branch
API, and even `git push` are served by real routes in `testing/fake-llm-server/index.ts`,
and `github.spec.ts` is a genuinely end-to-end publish test.

**Proposal.** Add `/supabase/api/**` and `/neon/api/**` mounts to the fake server
mirroring the shape of the real management APIs (list orgs, list projects, get keys,
create branch, run SQL against a throwaway pglite/sqlite-backed store), plus an OAuth
return that drives the real `dyad://` deep-link path the same way `mcp_oauth.spec.ts`
does. Then point `supabase_management_client.ts` / `neon_*` at a base URL constant (the
one-line pattern `vercel_utils.ts` already uses) and **delete the 20 `IS_TEST_BUILD`
early returns and the two `fake-connect` handlers**. Keep one E2E per integration
(connect → pick project → generate client → agent reads schema); the branch/migration
matrix stays in the existing integration tests. This is the single highest-leverage item
in the audit: it converts three E2E specs from "UI renders" to "integration works".

### 1.5 Neon migration review is tested against a hardcoded diff

**Where:** `src/ipc/utils/migration_utils.ts:129`, UI in
`src/components/preview_panel/DatabaseSection.tsx`, tests
`src/ipc/handlers/__tests__/neon_migration.integration.test.tsx`

Under `IS_TEST_BUILD` the schema-diff engine is replaced by a fixed four-statement array
(two additive, two destructive) and the table count is pinned to 1 at line 314. The
integration test sets `testBuild: true`, so it hits the same stub. The destructive-change
warning UX — the whole point of the review screen — is verified against a constant that
no real schema can influence, and `ts-pg-schema-diff` (a first-party package with its own
suite) is never exercised through the app.

**Proposal.** Drive the diff from a fixture pair of schemas instead of a constant: have
the test-mode branch read a schema snapshot from a fixture path (env-injected, like
`DYAD_TEST_MANAGED_NODE_ARCHIVE_URL` does for Node) and run the **real**
`generateSchemaDiff` over it. Then parameterize the integration test over several fixture
pairs — additive-only, drop-column, drop-table, grant change — and assert the
classification and the resulting UI copy for each. No new E2E needed; this is an
integration-tier fix.

### 1.6 Themes AI generator — the handler returns a canned string before any real logic

**Where:** `src/pro/main/ipc/handlers/themes_handlers.ts:608` and `:762`, tests
`e2e-tests/themes_management.spec.ts` ("AI generator flow", "AI generator from website
URL")

Both `generate-theme-prompt` and `generate-theme-from-url` return a hardcoded
`<theme>…</theme>` block **before** the Pro-entitlement check, the image-count limit, the
keyword-length limit, and the URL validation. Two consequences:

- "AI generator flow" calls `po.setUp()` (non-Pro) and passes — in production that user
  hits `"Dyad Pro is required for AI theme generation"`. The test asserts the opposite of
  the shipped behavior.
- "AI generator image upload limit" only proves the **client-side** cap; the server-side
  `Maximum 5 images allowed` guard is unreachable in tests.

The fake server already hosts `/engine/v1/tools/web-crawl`, so the URL path has a real
seam available and isn't using it.

**Proposal.** Move the `IS_TEST_BUILD` branch *below* the entitlement and validation
block, or better, delete it and route generation through the fake engine
(`/engine/v1/tools/web-crawl` for URLs, an images-in/prompt-out route for uploads).
Change "AI generator flow" to `setUpDyadPro()` and add a non-Pro case asserting the
gating error. Keep the validation-limit assertions at the integration tier where they can
hit the handler directly.

### 1.7 Voice-to-text — an assertion that both branches satisfy

**Where:** `e2e-tests/voice_to_text.spec.ts`

Two of three tests assert only that a button is visible. The third clicks record and then
asserts `expect(stopButton.or(voiceButton)).toBeVisible()` — the mic button is one of
those two states no matter what happens, so the assertion cannot fail. The comment is
candid about it ("we verify the button is still present and the app didn't crash").
Transcription itself (`transcribeAudio` → `transcribeWithDyadEngine`) is never exercised
here; `voice_to_text.integration.test.tsx` covers the handler.

**Proposal.** Keep one E2E for the Pro-lock affordance only, and make the recording test
deterministic: launch with `--use-fake-device-for-media-stream
--use-file-for-fake-audio-capture=<fixture.wav>`, add a transcription route to the fake
engine, and assert the concrete chain — recording state entered → stop → the transcript
text lands in the chat input. If fake media capture proves unreliable under Electron,
delete the third test rather than keep a tautology, and assert the state machine at the
integration tier.

### 1.8 Azure provider settings — visibility only, no persistence

**Where:** `e2e-tests/azure_provider_settings.spec.ts`

Asserts that the resource-name field, API-key field, and Save button exist. Never fills
them, never saves, never reloads to check persistence, never confirms the saved values
produce a working request. Also uses `waitForSelector('h1:has-text("Configure Azure
OpenAI")')` — a raw CSS/text selector where a role query would be stable.

`azure_send_message.spec.ts` sends a real message through Azure but injects credentials
via `TEST_AZURE_BASE_URL` / `AZURE_API_KEY` env vars, so it skips the settings UI
entirely. Between the two, the path a real user takes (type credentials → save → select
model → send) is never covered end to end.

**Proposal.** Merge them: fill the Azure form in the UI, save, assert the settings delta
snapshot, reload the renderer and assert the values persisted (key redacted), then select
the Azure model and send a prompt to the fake Azure mount. Delete the env-var injection
and the visibility-only spec. Same pattern applies to `VertexConfiguration.tsx`, which has
no E2E at all.

### 1.9 Node.js path configuration — a self-skipping tautology

**Where:** `e2e-tests/nodejs_path_configuration.spec.ts:40-59`

```ts
await po.page.waitForTimeout(2000);
const validStatus = po.page.locator("div.flex.items-center.gap-1.text-green-600, …");
if (!(await validStatus.isVisible())) { test.skip(); }
await expect(validStatus).toBeVisible();
```

The assertion is guarded by its own precondition, so the test either skips or passes —
it can never fail. It also depends on ambient system Node and locates by Tailwind utility
classes, which any restyle breaks.

**Proposal.** Point the custom-path field at a fixture directory containing a stub `node`
that prints a chosen `--version`, so validity is controlled rather than observed.
Parameterize over three cases — valid version, below `MINIMUM_SYSTEM_NODE_VERSION`, and
not-a-node-binary — and assert the status text plus the resulting run/preview behavior.
Replace the class-based locator with a `data-testid` and the sleep with `expect().toPass`.
`managed_node.spec.ts` already demonstrates this approach and can absorb these cases.

### 1.10 Auto-update — toggles a switch, tests nothing about updating

**Where:** `e2e-tests/auto_update.spec.ts`

Flips **Enable auto-update**, asserts a "Restart Dyad" button appears, snapshots the
settings delta, flips it back. `rules/auto-update.md` exists precisely because
Squirrel/update-feed behavior is where the bugs are — feed URL construction, channel
selection, updater log capture in bug reports — and none of that is touched. Same shape
in `release_channel.spec.ts` (stable ⇄ beta is a settings write only).

**Proposal.** Demote the toggle to the settings-sweep spec proposed in `better-e2e.md`
#8. Cover the part that can actually regress at the unit/integration tier: given
`{releaseChannel, platform, arch, version}`, assert the exact feed URL passed to
`update-electron-app`, that the channel switch changes it, that `enableAutoUpdate: false`
suppresses initialization entirely, and that updater logs are attached to a generated bug
report.

### 1.11 Crash / force-close session upload — button visibility only

**Where:** `e2e-tests/crash_upload_button.spec.ts`

Both tests write a `session.lock` sentinel and assert **Upload Chat Session** is visible
(with `activeChatId`) or hidden (without). The button is never clicked, so the upload
itself — bundle assembly, redaction, transport, success/failure UI — is untested.

**Proposal.** Keep the two visibility cases (they're cheap and correct) and add one that
clicks through: point the upload endpoint at a fake-server route, assert the request is
made, assert the success state renders, and assert a failing response surfaces an error
instead of a silent no-op. Bundle *contents* (which logs are included, what's redacted)
belong in a unit test over the bundle builder.

### 1.12 Backup — creation is covered, restore is not

**Where:** `e2e-tests/backup.spec.ts`, `src/backup_manager.ts`

Three tests: no backup on first run, backup created on version upgrade, and pruning to
the retention limit. The restore path — the reason backups exist — has no test at any
tier, and neither does the "backup failed, don't destroy the DB" branch.

**Proposal.** Add one spec that boots with a seeded pre-upgrade DB, triggers the upgrade
backup, corrupts/replaces `sqlite.db`, restores from the backup directory, and asserts
apps and chats come back intact. Add an integration test for backup-write failure
asserting the original DB is left untouched and the user sees an error.

### 1.13 Systemic: 47% of E2E test cases never run on Windows

119 of 253 test cases use `testSkipIfWindows` / `testWithConfigSkipIfWindows`, yet CI
runs a full Windows shard matrix and Windows is a shipped platform with its own rule file
(`rules/windows-spawn.md`) documenting real, Windows-specific failure modes (`.cmd` shim
resolution, `cmd.exe` quoting). The skips are individually reasonable — most involve
spawning dev servers or previews — but collectively they mean the platform most likely to
break on process spawning is the one with the least coverage of it.

**Proposal.** Triage the 119 into (a) genuinely POSIX-only, which should say so in a
comment, and (b) skipped because they were flaky on Windows once. For (b), fix or
quarantine explicitly rather than skipping silently. Independently, add a small
Windows-first suite covering exactly what `rules/windows-spawn.md` describes: package
manager invocation through `.cmd` shims, dev-server spawn with arguments containing
spaces, and terminal command execution. That is a handful of tests against the failure
class Windows users actually hit.

---

## Part 2 — Workflows with no E2E coverage at all

### 2.1 Vercel publish / deploy — no test of any kind

**Where:** `src/ipc/handlers/vercel_handlers.ts` (661 lines, 10 IPC channels),
`src/components/VercelConnector.tsx`, `VercelIntegration.tsx`,
`src/components/preview_panel/PublishPanel.tsx`

Zero E2E, zero integration, and no component test. The only related tests are unit tests
of helper functions (`vercel_neon_sync_helpers.test.ts`). The channels with no coverage
include `vercel:create-project`, `vercel:connect-existing-project`,
`vercel:get-deployments`, `vercel:sync-neon-config`, `vercel:remove-neon-env-vars`, and
`vercel:disconnect`.

Notably, the scaffolding is half-built and dead: `src/ipc/utils/vercel_utils.ts:11`
already points `VERCEL_API_BASE` at `http://localhost:${FAKE_LLM_PORT}/vercel/api` under
`IS_TEST_BUILD`, but `testing/fake-llm-server/` has **no** `/vercel` routes. Someone set
up the seam and never landed the other half.

**Proposal.** Highest-value new coverage in this audit, and the cheapest to start because
the redirect already exists. Add `/vercel/api/**` routes to the fake server (projects
list/create, deployments list with a state that advances across polls, env-var CRUD), then
one E2E: connect GitHub → connect Vercel → create project → publish → assert the
deployment URL renders in `PublishPanel` and that a failed deployment surfaces its error.
Cover Neon env-var sync and disconnect at the integration tier against the same fake
routes.

### 2.2 Neon connect / project selection / branch switching UI

**Where:** `src/ipc/handlers/neon_handlers.ts` (987 lines, 11 channels),
`src/components/NeonConnector.tsx`, `src/components/preview_panel/NeonConfigure.tsx`

Branch and migration logic have integration tests, but the user-facing flow — connect,
pick a project, switch dev/prod branch, read env vars — has no E2E, and what exists rides
on `neon:fake-connect` (see 1.4).

**Proposal.** Covered by the fake-server work in 1.4. One E2E: connect → select project →
assert the connected card and branch selector → switch branch → assert `DATABASE_URL` in
the env-var panel changes accordingly. Fold `database_url_guide.spec.ts` into it rather
than adding a second boot.

### 2.3 Help bot — no tests at all

**Where:** `src/ipc/handlers/help_bot_handlers.ts` (173 lines), channels
`help:chat:start` / `help:chat:cancel` and the streaming `help:chat:response:*` events,
UI in `src/components/HelpBotDialog.tsx`

A streaming chat surface with no coverage at any tier. Streaming, cancel, and error
paths are exactly where regressions hide.

**Proposal.** One integration test against the fake LLM: start a help chat, assert chunks
arrive in order and the final message renders, assert cancel mid-stream stops delivery
and leaves the dialog usable, assert a 500 from the backend surfaces an error rather than
a spinner that never resolves. Add it to the nav/dialog E2E sweep only if the dialog has
open/close behavior worth a real boot.

### 2.4 Portal migrations — no tests

**Where:** `src/ipc/handlers/portal_handlers.ts`, channel `portal:migrate-create`,
UI in `src/components/PortalMigrate.tsx`

Runs a migration command against the user's app and writes a DB timestamp. No test at any
tier; failure modes (command not found, non-zero exit, partial write) are unverified.

**Proposal.** Integration test with a fixture app whose migration command is a stub
script: assert success writes the timestamp, assert a non-zero exit surfaces a
`DyadError` with the command output and does **not** write the timestamp.

### 2.5 App upgrades

**Where:** `src/ipc/handlers/app_upgrade_handlers.ts`, channels `get-app-upgrades` /
`execute-app-upgrade`, UI in `src/components/AppUpgrades.tsx`

Exercised only as a side effect of `capacitor.spec.ts` and one case in
`select_component.spec.ts`. The list-available-upgrades path, applying an upgrade to an
app that's already current, and failure/rollback are uncovered.

**Proposal.** One integration test per upgrade type over fixture apps: assert which
upgrades are offered for an outdated app, assert none are offered for a current one,
apply one and assert the resulting file diff, and assert a failing upgrade leaves the app
buildable. Keep exactly one E2E (the existing Capacitor one) for the UI affordance.

### 2.6 Reset Everything (Danger Zone)

**Where:** `src/pages/settings.tsx:366-395`

"This will delete all your apps, chats, and settings. This action cannot be undone" — and
it is untested. The confirmation dialog, the actual teardown, and the post-reset app state
are all unverified.

**Proposal.** One E2E: seed two apps and a chat, open Danger Zone, cancel the dialog and
assert nothing was deleted, then confirm and assert the app list, chat list, and settings
are back to first-run state and the UI is usable without a restart. This is a
low-frequency, high-consequence flow — exactly what an E2E is for.

### 2.7 Copy app / rename app from the UI

**Where:** channels `copy-app`, `rename-app`, `preview-app-folder-name`,
`check-app-name`; `rules/app-naming.md` explicitly lists copy and rename as
folder-slug-affecting flows

`app_naming_handlers.test.ts` covers slug generation as a unit, and
`local_agent_basic.spec.ts` covers blueprint naming, but the user-initiated copy and
rename paths have no test that a name collision, an invalid character, or a rename of a
running app is handled correctly.

**Proposal.** One integration test covering the matrix from `rules/app-naming.md`:
rename to a colliding name, rename with characters invalid on Windows, copy an app twice
(auto-suffix), and rename an app with a running preview — asserting both the DB row and
the on-disk folder end up consistent.

### 2.8 Tests panel: generate → run → report

**Where:** `src/ipc/handlers/tests_handlers.ts`,
`src/components/preview_panel/TestsPanel.tsx`, `MigrateTestsDialog.tsx`

`ai_e2e_testing.spec.ts` deliberately stops at the opt-in gating and isolation warnings
(a reasonable call — spawning Playwright inside Playwright is a bad trade). But that
leaves the actual value of the feature — a generated test runs and its pass/fail is
reported back — with only `tests_handlers.test.ts` and
`local_agent_run_tests.integration.test.ts` behind it, and the migrate-tests dialog with
only a component test.

**Proposal.** Integration test with a fixture app containing one passing and one failing
test and a stub runner: assert results parse into the panel model with correct
pass/fail/duration, assert a runner crash surfaces as an error state rather than an empty
list, and assert the migrate-tests flow rewrites the fixture's config as expected. No new
E2E.

### 2.9 Standalone image generator dialog

**Where:** `src/components/ImageGeneratorDialog.tsx`, opened from `ChatInput.tsx`,
`library-home.tsx`, and `media.tsx`

Only a component unit test. The agent-tool path has an E2E
(`local_agent_generate_image.spec.ts`, which snapshots messages), but the three UI entry
points that generate an image and place it in the media library do not.

**Proposal.** One E2E from the media page against the existing
`/engine/v1/images/generations` fake route: generate → assert progress UI → assert the
image lands in the media library and is referenceable from chat. The other two entry
points are the same dialog; cover them with a component test asserting the props each
passes.

### 2.10 GitHub collaborators and branch management UI

**Where:** `src/components/GithubCollaboratorManager.tsx` (no tests),
`src/components/GithubBranchManager.tsx` (component test only)

`github.spec.ts` covers publish end to end against the fake GitHub server, and that
server already has repo/branch routes plus test helpers (`/github/api/test/push-events`,
`/reset-repos`). Collaborator management has no coverage at any tier.

**Proposal.** Extend the fake GitHub server with collaborator routes and add the
collaborator + branch cases to the existing `github.spec.ts` boot instead of new spec
files — the app is already connected at that point, so the marginal cost is seconds.

### 2.11 Smaller gaps worth a line each

| Workflow | Current state | Proposal |
| --- | --- | --- |
| Language selector / i18n (`LanguageSelector.tsx`, `rules/i18n.md`) | No test at any tier | One E2E: switch language, assert a known chat-tool card renders translated strings, assert the choice survives a renderer reload. Add a unit test asserting locale files have no missing keys vs. `en`. |
| Telemetry toggle (`TelemetrySwitch.tsx`) | No test | Integration test: toggling writes `telemetryConsent` and gates the PostHog init call in both directions. |
| Release notes (`release_note_handlers.ts`) | `IS_TEST_BUILD` returns `{exists:false}`; dialog has a component test | Point the existence check at a fake-server route so the real fetch/404 branches run; keep it integration-tier. |
| Delete chat | No E2E | Add to the chat-tabs or chat-list sweep: delete a chat, assert it leaves the list, its tab closes, and navigation lands somewhere valid. |
| Vertex AI provider config (`VertexConfiguration.tsx`) | No test | Fold into the provider-lifecycle spec from 1.3. |

---

## Suggested sequencing

Each phase is independently landable and leaves the suite better than it found it.

| Phase | Items | Why first |
| --- | --- | --- |
| 1 | 1.1, 1.2, 1.3, 1.7, 1.9 | Delete or fix the tests that assert nothing. Pure win: removes ~14 Electron boots and replaces false confidence with real assertions. |
| 2 | 2.1 Vercel fake routes + E2E | Largest untested surface (661 lines, 10 channels), and the redirect seam already exists. |
| 3 | 1.4, 2.2 Supabase/Neon fake services | Removes ~20 `IS_TEST_BUILD` branches and 2 test-only IPC handlers from production code; upgrades 3 existing specs from "UI renders" to real. |
| 4 | 1.5, 1.6, 1.10, 1.11, 1.12, 2.3–2.8 | Integration-tier work; no new Electron boots. |
| 5 | 1.13 Windows triage, 2.9–2.11 | Ongoing. |

## A note on where these tests should live

Phases 3–4 add almost no Playwright specs — most proposals here are integration-tier,
which is consistent with `AGENTS.md` ("prefer the narrowest test type that proves the
behavior") and with `better-e2e.md`'s finding that 48% of current specs use the UI only
as transport. The net effect of following this document should be **fewer** E2E specs
than today, each of which actually fails when its workflow breaks.
