# Bug Bash Plan: In-App E2E Testing

This plan covers the in-app E2E testing feature:

- the Tests panel
- test recording and assertion review
- the agent's `run_tests` and `generate_test_assertions` tools
- Playwright bootstrap
- database isolation
- the experimental "Run tests in preview panel" mode

It was written from a code read on 2026-09-24. Items marked **Suspected** are hypotheses from reading the code. Confirm them before you file.

---

## 1. Goals and exit criteria

**Goals**

1. Find the bugs that stop a first-time user from going from "Enable testing" to a green test, whether they write the test with the AI or record it.
2. Stress the risky seams:
   - cancellation and teardown
   - DB isolation (Neon and Supabase)
   - agent retry limits
   - concurrency between the panel, the agent and the recorder
   - Windows
3. Check that nothing corrupts the user's app. That covers `.env.local`, the real database, git state, `package.json` and cookies.

**Exit criteria**

- Every charter in §5 has been run on at least one OS. The P0 charters (A, B, C, D, F) must have been run on macOS **and** Windows.
- Every bug found is filed with a severity (§7) and triaged.
- No open S0 or S1 bugs remain in the "happy path" charters (A, B, C).

---

## 2. Logistics

| Item | Proposal |
|---|---|
| Duration | 2 × 2-hour sessions: (1) happy paths and environments, (2) edge cases and concurrency |
| Participants | 6–8 people, each given 1–2 charters and an OS |
| Build | The latest beta build. Also run a dev build with `npm start` so `userData/logs/main.log` is easy to find. |
| Bug tracker | GitHub issues with the label `bug-bash:e2e-testing` and the template in §7 |
| Channel | One thread per charter so duplicates are easy to spot |
| Triage | 30 minutes right after each session: dedupe, assign severity, assign an owner |

**Pre-work for each participant (15 minutes)**

- Install the build.
- Sign in, and make sure you can use Agent mode (Pro or free agent quota).
- Create the fixture apps in §3.
- Locate `main.log`.

---

## 3. Test environments and fixture apps

### OS / browser matrix

| OS | Browser setups to cover |
|---|---|
| macOS (arm64) | With Chrome installed. Also run once with Chrome not in `/Applications`, so the bundled Chromium download is exercised. |
| Windows 11 | With Edge only (the default). Run at least once from a user path that contains a space or non-ASCII characters. |
| Linux | Only a distro `chromium` package is installed (**Suspected**: not detected, so a ~100 MB download happens). Also a setup with `google-chrome`. |

### Fixture apps (create before the bash)

| ID | App | Why |
|---|---|---|
| F1 | A fresh React/Vite template app with no backend | Baseline happy path, with the "no DB" warning |
| F2 | An app with Supabase connected (org linked, RLS on some tables) | Test-user isolation and the RLS-missing warning |
| F3 | An app with Neon connected (host runtime) | Isolated DB branch and the restore/restart flow |
| F4 | An app with **both** Supabase and Neon | **Suspected**: the panel shows the Neon copy but the main process isolates via Supabase |
| F5 | A pnpm app, and a Yarn PnP app (`.pnp.cjs`) | Package-manager install path. PnP should be refused clearly. |
| F6 | An app with a user-owned `playwright.config.ts` and `e2e-tests/tsconfig.json` | These should be ignored or fall back correctly. **Suspected**: isolated runs hard-fail. |
| F7 | An app with legacy specs in `tests/` | The migration banner and dialog |
| F8 | An app with a login flow, a password field, a file upload, hover menus and an iframe | Recorder capture limits |

**Settings to vary across the bash:**

- **Settings → Enable Testing for New Apps:** on and off.
- **Settings → Experiments → Run tests in preview panel:** on and off.
- **Tests panel Options:** Run in parallel, Show the browser, Slow motion.
- **Agent tool consent for `run_tests` and `generate_test_assertions`:** always, ask, never.
- **UI locale:** en, plus one non-English locale. Nearly all strings in this feature are hardcoded English.

---

## 4. Feature map (for orientation)

| Surface | Where | Key code |
|---|---|---|
| Tests tab (always visible, "Experimental" badge) | Preview toolbar → Tests | `src/components/preview_panel/TestsPanel.tsx` |
| Per-app opt-in screen | Tests tab before enabling | `EnableTestingScreen` in `TestsPanel.tsx`, `set-testing-enabled` IPC |
| Run all / run file / run single test / Stop / Options / Delete / Fix / Output drawer | Tests panel | `TestsPanel.tsx`, `src/ipc/handlers/tests_handlers.ts` |
| Record (3 entry points: panel header, empty state, preview toolbar) | Tests panel and preview | `src/hooks/useTestRecorder.ts`, `src/ipc/handlers/recording_handlers.ts`, `worker/dyad-recorder-client.js` |
| Recording bar, then review, then "Generate test proposal" | Above the preview | `RecordingBanner.tsx`, `RecordingBannerHost.tsx` |
| Assertion review card ("Approve & generate") | Pinned above the chat composer | `src/components/chat/TestAssertionsInput.tsx`, `test_assertion_handlers.ts` |
| Agent tools `run_tests`, `generate_test_assertions` | **Agent mode only** (not Build, Ask or Plan). Only when the app has testing enabled. | `src/pro/main/ipc/handlers/local_agent/tools/run_tests*.ts`, `generate_test_assertions.ts` |
| Chat cards | Transcript | `DyadStatus.tsx`, `DyadTestAssertionsCard.tsx`, `CancellationBanner.tsx` |
| Playwright bootstrap | First run | `src/ipc/utils/playwright_bootstrap.ts` |
| DB isolation | Every run and recording | `src/ipc/services/isolated_test_db.ts` |
| Preview-run experiment | Settings → Experiments | `src/main/preview_cdp_broker.ts`, `PreviewWebContentsView.tsx` |

**Agent limits to know when bashing:**

- 4 failed attempts per spec per turn
- 10 run batches per turn
- 10-minute run timeout (20 minutes with slow-mo, ×3 with per-test DB isolation)
- 30-minute assertion-review deadline
- 30-minute recording cap
- 5,000 recorded actions maximum

**On-disk footprint to check after each charter:**

- `e2e-tests/**`
- `e2e-tests/fixtures/dyad/*`
- `playwright-dyad.config.ts`
- `test-results/`
- `.gitignore` additions
- the `package.json` `test` script
- `node_modules/.dyad-playwright-chromium-installed`
- `.env.local`, which must be restored after every run

---

## 5. Charters

Each charter lists **scenarios** with the **expected result**. Go beyond the script: the scenarios are a floor, not a ceiling.

### A. Onboarding and first run (P0)

| # | Scenario | Expected |
|---|---|---|
| A1 | Open the Tests tab on F1 before enabling | The Enable screen appears with the correct backend warning (no-DB amber box) |
| A2 | Enable testing on F1, F2, F3 and F4 | The warning copy matches the backend. **F4: check the copy matches what actually gets isolated.** |
| A3 | First "Run all" with no specs | Empty state "No tests yet" with the generate and record CTAs |
| A4 | First run ever on a machine with no Chrome | `@playwright/test` installs, Chromium downloads, and the output drawer shows progress. It finishes with no manual steps. |
| A5 | Same as A4, but offline | Clear errors: "Couldn't install @playwright/test…" / "Couldn't download the test browser…". A retry works once you are back online. |
| A6 | Press Stop during the first-run install | "Test setup cancelled." The next run resumes cleanly with no half-installed state. |
| A7 | Yarn PnP app (F5) | A clear refusal message, with no partial writes |
| A8 | pnpm app (F5) | Installs with pnpm, and the lockfile is updated consistently |
| A9 | Inspect the files written by bootstrap | Only the expected files. The user's `playwright.config.ts` is untouched. `package.json` `test` is added only if it was absent. |
| A10 | Turn on "Enable Testing for New Apps", then create an app | The new app is already opted in |
| A11 | Disable testing from Options | The panel goes back to the Enable screen and the agent tools disappear on the next turn |

### B. Tests panel: running and results (P0)

| # | Scenario | Expected |
|---|---|---|
| B1 | Run all with a mix of passing, failing, skipped and timed-out specs | Correct status per file and per case (passed, failed, inconclusive, partial). The counter line is accurate. |
| B2 | Run a single file, then a single test (`file:line`) | Only that target runs. Parallel is not used for a single test. |
| B3 | Edit a spec in the editor so the test moves lines, then run that single test | **Suspected**: the list is stale, giving "No test was found at line N". Note whether the file list refreshes. |
| B4 | Add or delete a spec file on disk or in the editor | **Suspected**: the panel doesn't refresh until a remount or chat turn. File it if confusing. |
| B5 | Expand a failure: error text and "Failure screenshot" | The screenshot loads. After a re-run, check whether old failures show "Screenshot unavailable". |
| B6 | Fix with AI on a failed test | Switches to or asks for Agent mode, attaches the prompt and screenshot, and shows the toast "Sent to chat…" |
| B7 | Run with the dev server stopped | The "Start the app to run tests." banner with a working Start button, and Run disabled |
| B8 | Force a run error, then click Retry | **Confirmed in code**: Retry reruns the **whole suite** even if the failed run was one file or test. Decide whether that is a bug. |
| B9 | Options: parallel, headed, slow motion | Each takes effect. Parallel is disabled with a hint under isolation or preview mode. Slow-mo is visibly slower. |
| B10 | Output drawer on a very chatty suite | Auto-opens and stays responsive; output is capped at 500k characters |
| B11 | Delete a tracked spec, an untracked spec, and an already-deleted spec | The right toast in each case: "…not committed — see pending changes", "(was untracked, not recoverable)", "Test file not found" |
| B12 | Specs with template-literal titles, titles on the next line, or tests generated in loops | **Suspected**: the line-based parser misses them. Check the panel listing against the actual run. |
| B13 | Legacy `tests/` migration (F7) | Banner and dialog, files moved, conflicts handled, and non-Playwright files left alone |
| B14 | Restart Dyad after a run | Results are gone, since they live in memory only. Confirm the UI isn't misleading. |

### C. Recording (P0)

| # | Scenario | Expected |
|---|---|---|
| C1 | Record from each of the 3 entry points | The storage-warning dialog, then setup overlay, then "Signing in the test user…" (Supabase), then the recording bar |
| C2 | Record click, type, check, select, Enter, and address-bar navigation plus Back/Forward | The step count and code preview update live and accurately |
| C3 | Type into a password field | Recorded as `REPLACE_WITH_PASSWORD`. Is it obvious to the user that they need to edit this? |
| C4 | File upload, hover menu, drag-and-drop, scroll, interaction inside an iframe (F8) | Not captured, by design. Is the user told? Is the generated test obviously incomplete? |
| C5 | Stop, then review the steps, then Generate test proposal | "{N} steps recorded — not saved yet". The chat gets an Agent-mode prompt and the bar shows "Asking the AI for assertions…". |
| C6 | Stop with **0 steps**, then Generate | **Suspected**: allowed. What does the AI and the card do? |
| C7 | Discard (two-step confirm) | The draft is gone and the preview is back to normal |
| C8 | Cancel (X) mid-recording | Recording ends and isolation is torn down |
| C9 | Record for longer than 30 minutes, or over 5,000 actions | Stopped with the documented message, and the draft is kept for review |
| C10 | Switch to another app mid-recording | **Suspected**: the recording is silently lost |
| C11 | Disable testing mid-recording | **Suspected**: the recording bar stays live and the main session isn't ended |
| C12 | Restart Dyad with an unproposed recording | The draft is lost (in-memory). Is the user warned? |
| C13 | Start recording while a test run is active, and run tests while recording | Both refused with a clear reason |
| C14 | After recording, check other localhost previews and apps | Cookies and storage are cleared for **all** localhost previews (known TODO). Assess the severity. |
| C15 | Use the annotator during a recording | Mutually exclusive, with a tooltip explaining why |
| C16 | Very large recording | "This recording is too large to send to the AI…" |

### D. Assertion review and test generation (P0)

| # | Scenario | Expected |
|---|---|---|
| D1 | The AI proposes checks, you edit, add, reorder and remove them, then Approve & generate | Toast "Generated e2e-tests/recorded-….spec.ts". The spec is `git add`-ed, not committed. The agent then runs it. |
| D2 | Leave a check blank | Approve is disabled: "Describe every check before approving." |
| D3 | "Close without generating" | The receipt shows "Closed without generating a test." and the agent does not call `run_tests` |
| D4 | Double-click Approve, or approve from two cards, or approve after "Ask again" | Idempotent: "This test was already generated." / "already saved as X". No `-2` twin file. |
| D5 | Leave the card for more than 30 minutes, then approve | **Suspected**: the model was told "closed", but the card is still approvable. Look for duplicate generation or runs. |
| D6 | Record a new flow while a proposal is pending | The old proposal is marked stale (`STALE_DRAFT_MESSAGE`) with no crash |
| D7 | Stop the chat turn while the card is waiting | The card and the turn end consistently |
| D8 | Name the recording with non-Latin, very long or emoji text | Slug and file name are sane. **Note:** the recording bar has no name field. Stop always sends an empty name. |
| D9 | Recorded spec with login (F2) | Uses `e2e-tests/fixtures/test-user.ts` `signIn` and passes |
| D10 | Legacy `dyad-generate-test` tag in an old chat | Still renders as a write card |

### E. Agent `run_tests` tool (P1)

| # | Scenario | Expected |
|---|---|---|
| E1 | In Agent mode ask "add a test for X and make sure it passes" | The agent writes a spec, calls `run_tests`, and the card reads "Tests passed" |
| E2 | Break the app so the test fails, then let the agent fix it | Screenshot hand-off, a fix loop, and a green result |
| E3 | Look at the failure card colour | **Confirmed in code**: "Tests failed in N file(s)" is rendered **green** with the finished icon (`completeStatus` with no state, `DyadStatus.tsx`). File it. |
| E4 | A failure the agent can't fix | Stops after 4 attempts per spec ("Attempt limit reached") and 10 batches per turn ("Test run limit reached") |
| E5 | The agent reruns without changing anything | "You haven't made any changes…" guard. The `flakeCheck` rerun is allowed once. |
| E6 | A fix changes the received value but not the matcher | **Suspected**: a false "your last change did NOT alter the failure" note, because the signature uses only the first error line |
| E7 | More than 2 failing files in one batch | Only 2 get details and a screenshot. Does the agent still converge? |
| E8 | A grep that matches only a `describe`, an invalid regex, or `%` and newlines on Windows | Clear refusals or "executed nothing", not a crash |
| E9 | Bad paths: backslashes, `./`, duplicates, a non-existent file, a file outside `e2e-tests/` | Skipped with a note, or the batch is refused with a clear message |
| E10 | Build, Ask and Plan modes | The tools are not available. The model shouldn't claim to have run tests. |
| E11 | Consent set to "ask" | The prompt text reads "Run tests: <files>". Denying it is handled gracefully. |
| E12 | Consent set to "never" | The tool is absent and the prompt adapts |
| E13 | Stop the dev server mid-batch | Reported as an infra failure ("App isn't running"), not a counted attempt |
| E14 | Click Run in the Tests panel while the agent is running tests | **Suspected**: aborts the agent run, which sees "Test run stopped.". Check for loops or confusing chat output. |
| E15 | Implementer subagent (Pro, `enableImplementerSubagent`) runs tests | **Suspected**: the failure screenshot lands in the **root** chat, not the subagent. Its run budget is separate from the root's, and parallel implementers abort each other. |
| E16 | Timeouts: a suite that hangs for more than 10 minutes | "The test run exceeded the N-minute limit…" and teardown completes |
| E17 | Toggle testing on or off mid-turn | Takes effect only on the next turn. Confirm nothing breaks. |

### F. Cancellation, teardown and data safety (P0)

| # | Scenario | Expected |
|---|---|---|
| F1 | Press Stop in the panel at each phase: setting up, running, cleaning up | The label moves "Stop" → "Stopping…" → "Cleaning up…" / "Restoring…". Teardown always finishes. |
| F2 | Stop the chat turn during an agent run | The Cancellation banner reads "Ending the test run." / "Restoring your app's database and preview…". Measure how long the composer stays locked. |
| F3 | Start a new run while the previous one is still cleaning up | Queued with "Waiting for a previous test cleanup…" |
| F4 | After every run or stop, `diff` `.env.local` against a backup | It is byte-identical. The real DB is untouched (F2 and F3 apps). The Neon branch is deleted. The Supabase test user is cleaned up. |
| F5 | Kill Dyad (force quit) mid-run | On relaunch, is `.env.local` correct? Is there an orphan Neon branch or dev-server state? File anything that needs manual recovery. |
| F6 | Make the `.env.local` restore fail (e.g. make it read-only) | The message "Dyad couldn't restore your app's real database settings… Restore .env.local" appears |
| F7 | Neon (F3): the dev-server restart disclosure | The preview comes back pointing at the real DB after the run |
| F8 | Supabase (F2) with tables missing RLS | Warning shown; tests run as the test user |

### G. Preview-run experiment (P2)

Turn on **Settings → Experiments → Run tests in preview panel** and **Show the browser**.

| # | Scenario | Expected |
|---|---|---|
| G1 | Run all | Runs inside the preview. "Test view" / "Tests running…" chip, and controls locked. |
| G2 | Exit the test view mid-run | The run continues in the background |
| G3 | Close the preview or switch apps mid-run | "The preview was closed while tests were running…" or a fallback. No hang. |
| G4 | Two apps running at the same time | The second falls back to a separate browser with a notice |
| G5 | App with a user-owned `e2e-tests/tsconfig.json` (F6) | Falls back. Isolated runs fail with repair instructions. Is the fix clear? |
| G6 | Agent run while the preview shows a different route or app | Falls back after 5 s with no stuck state |

### H. Cross-cutting (P2)

| # | Scenario | Expected |
|---|---|---|
| H1 | Two Dyad windows on the same app | **Suspected**: the second window gets no results for panel runs, and `recording:ended` reaches only one window |
| H2 | Non-English locale | Nearly the whole feature is English-only. File one umbrella i18n issue, not one per string. |
| H3 | Disabled-button tooltips | **Suspected**: a generic or missing reason (`runTitle` is never passed, and Chromium suppresses titles on disabled buttons) |
| H4 | Keyboard and a11y on the assertion card (Enter/Escape edit, reorder buttons) | Fully usable without a mouse |
| H5 | Dark mode on all new surfaces | Readable, with no hardcoded colours breaking |
| H6 | Performance: a suite of 50 or more specs | The panel stays responsive and the output drawer doesn't lag |

---

## 6. Charter assignments (fill in)

| Charter | Priority | Owner | macOS | Windows | Linux |
|---|---|---|---|---|---|
| A. Onboarding and first run | P0 | | ☐ | ☐ | ☐ |
| B. Tests panel | P0 | | ☐ | ☐ | |
| C. Recording | P0 | | ☐ | ☐ | |
| D. Assertion review | P0 | | ☐ | ☐ | |
| E. Agent `run_tests` | P1 | | ☐ | ☐ | |
| F. Cancellation and data safety | P0 | | ☐ | ☐ | |
| G. Preview-run experiment | P2 | | ☐ | ☐ | |
| H. Cross-cutting | P2 | | ☐ | | |

---

## 7. Filing bugs

**Severity**

- **S0:** data loss or corruption. For example: the real DB was written, `.env.local` wasn't restored, a spec was deleted unrecoverably without warning, or cookies were lost unexpectedly with real impact.
- **S1:** the happy path is blocked (can't enable, record, generate or run), or the app is stuck and needs a restart.
- **S2:** wrong result or status, a misleading message, or a workaround exists.
- **S3:** copy, polish or i18n.

**Issue template**

```
Title: [e2e-testing][Charter X#] <short summary>
Severity: S0/S1/S2/S3
Build / OS / browser (Chrome/Edge/bundled):
App fixture (F1–F8) + backend:
Settings: parallel/headed/slow-mo/preview-run/consent:
Steps:
Expected:
Actual:
Attachments: screenshot/video, main.log excerpt, test-results/ contents, chat link
```

Always attach the relevant part of `main.log`. Its scoped lines show whether a failure is in the main process or the renderer.

---

## 8. Automated-coverage gaps (follow-up after the bash)

Existing coverage is mostly unit tests:

- `run_tests.spec.ts` (~65 cases)
- `generate_test_assertions.spec.ts`
- `TestsPanel.test.tsx`

There are also a few E2E specs:

- `test_recording.spec.ts`
- `test_assertions.spec.ts`
- `ai_e2e_testing.spec.ts`

Missing coverage, which is where the manual bash should look hardest:

- **No E2E test drives a real `run_tests` execution.** Pass, fail, fix loop, screenshot hand-off, cancel and timeout are all untested.
- The integration test `local_agent_run_tests.integration.test.ts` covers only the dev-server-not-running refusal.
- There is no coverage of Neon or Supabase isolation end to end, the preview-run mode, or Implementer-subagent runs.
- `subagent_tool_set.spec.ts` doesn't assert that the Implementer *has* `run_tests`.

For each S0 or S1 bug the bash finds, add a regression test at the narrowest level: unit, then Vitest integration, then Playwright.
