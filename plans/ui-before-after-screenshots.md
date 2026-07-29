# Before/after UI screenshots in chat

When the agent makes a visual change, the user has no way to see it — they can only
infer it from the diff. This plan adds a **before/after screenshot card** to the chat,
captured by the app's own Playwright E2E run.

Requirements (from the feature request):

1. On a visual change, the agent creates a **temporary** E2E spec for the feature (only
   if a permanent one doesn't already cover it) — instructed in the system prompt, and
   only when testing is enabled for the app.
2. The agent runs that spec **before and after** the change.
3. **Every** run takes a screenshot, including passing runs.
4. The chat renders a card: "this is the UI before, this is the UI after".

## What already exists (do not rebuild)

| Piece | Where | State |
| --- | --- | --- |
| Chat cards that render images | `DyadImageGeneration.tsx:140` (`<img src="dyad-media://…">` + `ImageLightbox`), `DyadAttachment.tsx:66` | Works. No CSP blocks custom-protocol images. |
| Media protocol with a screenshot subdir | `src/main/dyad_media_protocol.ts:107` — `allowedSubdirs = [DYAD_MEDIA_SUBDIR, DYAD_SCREENSHOT_SUBDIR]` | Works; `.dyad/` is gitignored per app, so files survive version checkouts. |
| Playwright failure screenshots surfaced in the UI | `TestsPanel.tsx:130` → `ipc.tests.getTestScreenshot` → `src/ipc/utils/test_screenshot.ts` | Works, but reads from `test-results/`, which Playwright wipes each run → unusable for chat history. |
| Tool → chat card mechanism | `ctx.onXmlComplete` / `completeStatus` in `run_tests_utils.ts`, parsed by `streamingMessageParser.ts:26` + `DyadMarkdownParser.tsx:510` | ~50 tags use this. Adding one is 3 small edits. |
| Per-app testing opt-in | `apps.testingEnabled` (`src/db/schema.ts:119`), threaded to the agent at `local_agent_handler.ts:767`, gates the prompt at `local_agent_prompt.ts:425,461` | Works; no new flag needed. |

So the **rendering half is free**. The work is in capture, persistence, and the tool/prompt
protocol that produces a *pair* of screenshots.

## Design

### Flow

```
agent decides change is visual  (testingEnabled only)
  ├─ pick a spec: existing one covering the screen, else write e2e-tests/tmp/<slug>.spec.ts
  ├─ run_tests({ testFile, phase: "before" })   ← baseline; failures expected & harmless
  │     └─ screenshot copied to .dyad/test-screenshot/<id>-before.png
  ├─ edit the app
  ├─ run_tests({ testFile, phase: "after" })    ← normal run, full fix loop applies
  │     └─ screenshot copied to .dyad/test-screenshot/<id>-after.png
  │     └─ emits <dyad-ui-diff before="…" after="…" test-file="…">
  └─ delete the temp spec
```

The card is rendered from the persisted assistant message, so it survives reload and
app restart.

### Why the baseline run needs its own arm

`run_tests` today is a fix loop: a failing run consumes one of `MAX_ATTEMPTS`, records a
failure signature, and the tool text tells the model to read `error-context.md` and fix
it. A baseline run of a spec for a **feature that doesn't exist yet is supposed to
fail** — routing that through the fix loop would burn the fix budget and send the agent
chasing a "failure" before it has written any code.

So `phase: "before"` branches early: capture, report, return. It does **not** touch
`attempts`, `lastFailureSignature`, `passedAtEditCount`, or `fileEditCountAtLastRun`; it
does count against `MAX_RUNS_PER_TURN` (it's a real Playwright run and must be budgeted).

### Storage

New subdir `.dyad/test-screenshot/` — deliberately *not* `.dyad/screenshot/`, which is
owned by the per-commit preview screenshots (`SCREENSHOT_FILENAME_REGEX = ^[0-9a-f]{40}\.png$`,
pruned at `MAX_SCREENSHOTS_PER_APP`, listed by `listAppScreenshots` and rendered in
`VersionPane`). Mixing UI-diff shots in there would either be silently ignored by that
prune (unbounded growth) or pollute the version pane.

Filenames are flat (the protocol rejects `/`, `\`, `..`, and NUL — `dyad_media_protocol.ts:137`)
and deterministic: `ui-<chatId>-<messageId>-<seq>-<before|after>.png`.

### Card

New tag `<dyad-ui-diff>` with attributes only (never base64 — message content is stored
in SQLite):

```xml
<dyad-ui-diff test-file="e2e-tests/tmp/cart-badge.spec.ts"
              label="Cart badge"
              before="ui-42-931-1-before.png"
              after="ui-42-931-1-after.png"
              state="finished"></dyad-ui-diff>
```

The renderer builds `dyad-media://media/app-id/<appId>/.dyad/test-screenshot/<file>` —
the `app-id` form (`dyadMediaUrl.ts:11`) so the renderer never needs the app path.

---

## Work items

### Phase 1 — Capture a screenshot on every run

**1.1 Config template.** `buildPlaywrightConfig` (`playwright_bootstrap.ts:137`) sets
`screenshot: "only-on-failure"` → `"on"`. Playwright then attaches a screenshot at the
end of every test, pass or fail.

**1.2 Migrate existing apps.** An existing Dyad-generated config is *not* rewritten when
the template changes (`ensurePlaywrightBootstrap` only rewrites for the channel upgrade,
plus `migrateConfigTestDir` at `:367`). Add a sibling `migrateConfigScreenshotMode()`
that rewrites `screenshot: "only-on-failure"` → `screenshot: "on"` when
`isDyadGeneratedConfig(appPath)` — same guard, so a config the user has adopted is left
alone.

**1.3 Report parser surfaces passing-run screenshots.** `parsePlaywrightReport`
(`playwright_report.ts`) only records `screenshotPath` for non-passing tests (`:171-182`
for the passed branch, `:257` for the file-level aggregate). Add a **new** field rather
than widening the existing one:

- `TestResult.screenshotPath` — unchanged semantics: *failure* screenshot. Keeps
  `TestsPanel`'s "Failure screenshot" section and `attachFailureArtifacts` (which feeds
  the image to the model) behaving exactly as today.
- `TestResult.finalScreenshotPath` (new, both schemas in `src/ipc/types/tests.ts:92,103`)
  — last screenshot attachment regardless of status, via the existing
  `screenshotFromResult()` (`:104`).

**1.4 Persist + prune.** New module `src/ipc/utils/test_screenshot_store.ts`:

- `DYAD_TEST_SCREENSHOT_SUBDIR = "test-screenshot"` + `DYAD_TEST_SCREENSHOT_DIR_NAME` in
  `media_path_utils.ts` (beside the existing constants at `:14-30`), plus a filename
  regex for prune.
- `persistTestScreenshot({ appPath, sourcePath, fileName })` — reuse the containment
  guards in `test_screenshot.ts` (realpath, `.png` re-check on the resolved path,
  `test-results/` containment, `O_NOFOLLOW`, 5 MB cap) to *read*, then copy into
  `.dyad/test-screenshot/`. Must run **before** the next Playwright run, which clears
  `test-results/`.
- Prune to `MAX_TEST_SCREENSHOTS_PER_APP` (suggest 200) by mtime, mirroring
  `readScreenshotEntries` in `app_handlers.ts:67`.
- Extend `media_cleanup.ts` (30-day TTL sweep) to cover the new dir.

**1.5 Protocol allowlist.** Add the subdir to `allowedSubdirs`
(`dyad_media_protocol.ts:107`). Leave the `thumbnail=1` path media-only (`:157`) — cards
get the full-size PNG and scale it in CSS.

**1.6 URL builder.** `buildDyadTestScreenshotUrlForApp(appId, fileName)` in
`src/lib/dyadMediaUrl.ts`.

**Tests:** extend `dyad_media_protocol.test.ts` (new subdir allowed; traversal/symlink
still 403), unit-test the report-parser change (passing test yields
`finalScreenshotPath`, failing test still yields `screenshotPath`), unit-test
persist+prune, and a config-migration test in the `playwright_bootstrap` tests.

### Phase 2 — `run_tests` before/after protocol

**2.1 New arg** on `runTestsSchema` (`run_tests.ts:36`):

```ts
phase: z.enum(["before", "after"]).optional().describe(
  "Set 'before' to capture the CURRENT UI as a baseline BEFORE you edit the app — " +
  "failures are expected and don't count as fix attempts. Set 'after' once the change " +
  "is in, to capture the new UI and show the user a before/after card. Omit for a " +
  "normal verification run.")
```

**2.2 Baseline arm.** In the `run_tests` handler (`run_tests.ts:530`, where
`TestRunAttemptState` is fetched), branch before the guards for `phase: "before"`:
resolve the spec, run it via `runSpec` (`:278`), persist `finalScreenshotPath`, stash it
on the attempt state, and return. New field on `TestRunAttemptState`
(`tools/types.ts:217`):

```ts
/** Baseline UI screenshot captured by a `phase: "before"` run, for the diff card. */
uiBaseline?: { fileName: string; testFile: string; capturedAt: string };
```

Report with `completeStatus(ctx, "Captured UI baseline: <spec>", …)` and return tool text
that states plainly: baseline captured, pass/fail is informational, no attempt consumed,
now make the change and rerun with `phase: "after"`.

**2.3 After arm.** After the existing pass/fail reporting, if a screenshot was persisted
this run, emit the card:

```ts
ctx.onXmlComplete(
  `<dyad-ui-diff test-file="${escapeXmlAttr(testFile)}" label="${escapeXmlAttr(label)}" ` +
  `before="${escapeXmlAttr(baseline?.fileName ?? "")}" after="${escapeXmlAttr(afterFile)}"></dyad-ui-diff>`)
```

With no baseline (agent skipped the before run, or it errored), emit the card with only
`after` — a single "UI after" shot is still worth showing. The card is emitted for
passing *and* failing after-runs; a failing run's screenshot is the failure state and is
labeled as such in the card.

**2.4 Budgets.** Baseline runs increment `ctx.testRunCount` (`MAX_RUNS_PER_TURN`) but not
`state.attempts`. `guardAlreadyPassed` / `guardChangedSinceLastRun` are skipped for
`phase: "before"` (a baseline is meaningful even with no edits since).

**Tests:** extend `run_tests.spec.ts` — baseline run doesn't consume an attempt; failing
baseline doesn't set `lastFailureSignature`; after-run emits `<dyad-ui-diff>` with both
attributes; after-run with no baseline emits `after` only; baseline counts toward
`MAX_RUNS_PER_TURN`.

### Phase 3 — The chat card

**3.1** Register `"dyad-ui-diff"` in `DYAD_CUSTOM_TAG_NAMES` (`streamingMessageParser.ts:26`).

**3.2** Add the `case` in `renderCustomTag` (`DyadMarkdownParser.tsx:510`), passing
`state: getState({ isStreaming, inProgress })` like its neighbours.

**3.3** New `src/components/chat/DyadUiDiff.tsx`, modeled on `DyadImageGeneration.tsx`:

- `DyadCard` + `DyadCardHeader` + `DyadBadge` (pick an unused accent, e.g. `sky`).
- Two labeled panes, **Before** and **After**, side by side on wide layouts and stacked
  on narrow ones; click either → `ImageLightbox`.
- `appId` from `selectedAppIdAtom` (as `DyadImageGeneration.tsx:48` does); URL from
  `buildDyadTestScreenshotUrlForApp`.
- `onError` per image → "Screenshot unavailable" placeholder, so a pruned/deleted file
  degrades instead of showing a broken image (mirrors the `imageError` state at
  `DyadImageGeneration.tsx:42`).
- Only `after` present → render a single "UI now" pane.

**Tests:** a `DyadUiDiff.test.tsx` (both panes, single-pane fallback, error fallback) plus
a `DyadMarkdownParser.test.tsx` case asserting the tag routes to the component and never
leaks raw markup.

### Phase 4 — Prompt

All of this is gated behind `testingEnabled`, which already controls
`AGENT_TEST_WRITING_GUIDANCE` (`local_agent_prompt.ts:425,461`).

**4.1** New block in `system_prompt.ts` (near `AGENT_RUN_TESTS_GUIDANCE:409`), appended
into `AGENT_TEST_WRITING_GUIDANCE:464`:

> **Showing the user what changed visually.** When your change alters what the user
> sees, capture a before/after so they don't have to read the diff:
> 1. Find a spec that already exercises the screen (`list_files` on `e2e-tests/`). Use it
>    if one exists.
> 2. Otherwise write a **temporary** spec at `e2e-tests/tmp/<slug>.spec.ts` that just
>    navigates to the affected screen and asserts it rendered. Keep it minimal.
> 3. **Before editing the app**, `run_tests({ testFile, phase: "before" })`. A failure
>    here is expected when the feature doesn't exist yet — don't try to fix it.
> 4. Make the change.
> 5. `run_tests({ testFile, phase: "after" })`. Dyad shows the user a before/after card.
> 6. Delete any temp spec you created (`delete_file`) before you finish.
>
> Skip this entirely for non-visual work (logic, config, refactors) and for changes too
> small to see.

**4.2** Extend `verifyTestsClause` (`local_agent_prompt.ts:159`) with one sentence
pointing at the above, so the workflow block and the testing block agree.

**4.3** Update `src/prompts/__snapshots__/local_agent_prompt.test.ts.snap` (`vitest -u`).

### Phase 5 — Temp-spec lifecycle

The agent is told to delete its temp spec, but agents forget and turns get interrupted.

**5.1** Convention: temp specs live under `e2e-tests/tmp/`. `TEST_SPEC_GLOB` already
matches them (`e2e-tests/**/*.spec.{ts,tsx,js,jsx}`), so `listSpecFiles`
(`tests_handlers.ts:96`) and the Tests panel pick them up.

**5.2** Filter `e2e-tests/tmp/` out of the Tests panel listing so a transient spec never
looks like part of the user's suite. Keep it visible to `run_tests`' `resolveSpecPath`
(`run_tests.ts:64`) — the agent must be able to target it.

**5.3** Safety net: at the end of an agent turn (`local_agent_handler.ts`, beside the
existing `ensureDyadGitignored` housekeeping at `:725`), delete `e2e-tests/tmp/` specs
older than the current turn. Screenshots already taken remain valid — they live in
`.dyad/test-screenshot/`, not in the spec.

---

## Risks and decisions

- **Run cost doubles.** A before + after pair is two Playwright runs (browser boot + dev
  server round-trip each). Mitigated by scoping to visual changes, one spec, and letting
  the agent pass `grep` to narrow. Watch `MAX_RUNS_PER_TURN = 10` — a multi-screen change
  could hit it; consider raising it once we see real usage.
- **Baseline failures are load-bearing, and models hate ignoring a red test.** The tool
  text for the baseline arm must be blunt ("this did NOT count as a fix attempt; do not
  fix anything yet") — the same phrasing that already works for
  `reportNoRunnableTests` / `guardChangedSinceLastRun`.
- **`screenshot: "on"` grows `test-results/`.** Playwright clears it per run, so the
  ceiling is one run's worth. Our copies are capped by the new prune.
- **Dev server must be running** for any run (`getRunningTestBaseUrl`, `tests_handlers.ts:270`).
  Unchanged precondition — a stopped app means no card, and the existing message already
  tells the user to press Run.
- **Screenshot timing.** `screenshot: "on"` fires at test end. If a spec ends after
  navigating away, the shot is of the wrong screen. The prompt should tell the agent to
  end a temp spec on the screen it wants shown.
- **Deleted screenshots.** Pruning (or app deletion) leaves an old card pointing at a
  missing file — hence the explicit unavailable-placeholder in 3.3, not a broken `<img>`.
- **Open question — should a *user-visible* button trigger this too?** The Tests panel
  could offer "capture UI" independent of the agent. Out of scope here; the storage +
  card are reusable if we want it later.

## Testing

- **Unit:** report parser, screenshot persist/prune, protocol allowlist, config
  migration, `run_tests` phase arms, prompt snapshot.
- **Component:** `DyadUiDiff` (pair, single, error), parser routing.
- **E2E:** extend `e2e-tests/ai_e2e_testing.spec.ts`'s approach — drive the fake LLM to
  emit a `<dyad-ui-diff>` tag with fixture PNGs staged in `.dyad/test-screenshot/` and
  assert both panes render. Follow that file's existing choice **not** to spawn a real
  Playwright run inside Playwright; the capture path stays covered by unit tests.

## Alternative considered

Dyad already screenshots the **preview iframe** per commit (`src/screenshot/`,
`saveAppScreenshot`, rendered as version thumbnails in `VersionPane.tsx:785`). A
before/after card could be built from two of those with no test involved — much cheaper,
and it works when testing is off. But it can only capture whatever route the preview
happens to be on and can't drive a flow (open a modal, fill a form, reach a detail page),
which is exactly what a "visual change" often lives behind. Worth keeping as a fallback
for apps without testing enabled; the card component in Phase 3 is source-agnostic and
would render either pair.
