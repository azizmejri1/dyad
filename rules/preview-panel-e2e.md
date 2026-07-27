# Preview-panel E2E (experiment)

Experiment behind the `enablePreviewPanelE2E` user setting: render the preview
panel in an Electron `WebContentsView` instead of an `<iframe>`, and run a
user app's Playwright E2E tests **inside that view** rather than launching a
separate Chromium window.

## Why the iframe had to go

Playwright drives pages over the Chrome DevTools Protocol, and CDP only exposes
_targets_. An `<iframe>` is not a target — it is part of its parent page — so
there is no way to hand one to Playwright as a `Page`. A `WebContentsView` has
its own `webContents`, which Electron publishes as a `type: "page"` target
alongside the main window. That single difference is the whole experiment.

Verified against Electron 40 / Playwright 1.58: the view shows up in
`/json/list`, `chromium.connectOverCDP` returns it as an ordinary `Page`, and
`click` / `goto` / `screenshot` / `evaluate` all work against it.

## How a run is wired

1. **Debugging port.** `src/main/preview_debugging.ts` appends
   `--remote-debugging-port=0` before `app.whenReady()` when the flag is on.
   Port `0` means the OS picks a free one; Chromium records it in
   `<userData>/DevToolsActivePort`, which is how the main process recovers the
   endpoint later. The switch cannot be applied to a running process, so
   **toggling the setting requires a restart** — and the flag is read with a raw
   JSON read, because `readSettings()` can touch `safeStorage`, which throws
   before the app is ready.
2. **The view.** `src/main/preview_web_contents_view.ts` owns one view per
   window. The renderer (`PreviewWebContentsView.tsx`) lays out a placeholder
   `<div>` and reports its rectangle; main positions the native view over it.
3. **Mode selection.** `resolvePreviewRunEndpoint` in `tests_handlers.ts` returns
   an endpoint only when the flag is on, the port is actually open, and a live
   preview view is showing the app's dev-server origin. Anything else falls back
   to the normal launch mode — the experiment must never be why a run fails.
4. **The runner.** `playwright_preview_bootstrap.ts` writes `.dyad-e2e/`
   (config + tsconfig + fixture) into the app and the run uses
   `--config .dyad-e2e/playwright.config.ts`.

## Specs stay unmodified

Specs keep `import { test, expect } from "@playwright/test"`. The generated
config sets `tsconfig: "./tsconfig.json"`, whose `paths` remap that specifier to
`.dyad-e2e/fixture.ts`. The fixture replaces only the `page` fixture, with the
live preview page.

Two constraints fall out of this and must be preserved:

- **The fixture must import `playwright/test`, never `@playwright/test`.** The
  alias applies to every file the config loads, the fixture included, so the
  latter would make it import itself. `playwright/test` is the same API under a
  specifier the alias does not match.
- **Relative navigation is resolved by hand.** A CDP-attached `BrowserContext`
  carries no `baseURL` option (Playwright only applies it to contexts it
  creates), so `page.goto("/")` would throw. The fixture wraps `goto` and
  `waitForURL`. `expect(page).toHaveURL("/relative")` is **not** covered — it
  resolves inside `expect`, out of reach of the fixture.

## What this mode gives up

- **No visual editing, component selection, or annotator.** Those are built on
  `iframe.contentWindow.postMessage`; a native view has no `contentWindow`. Load,
  navigation, and console signals are forwarded from main over
  `preview-view:event` instead, but the component-selector bridge is not ported.
- **Renderer overlays cannot paint over the preview.** A `WebContentsView` is
  composited above all renderer content, so a dropdown or dialog that extends
  into the preview area is hidden behind it. The panel parks the view off-screen
  for the cases it knows about (error banner, panel unmounted); menus that
  overlap remain a known artifact.
- **No parallel runs.** There is exactly one preview view, so the Tests panel's
  parallel option is ignored, and `--headed` is meaningless.
- **`browser.newContext()` / `context.newPage()` in a spec will not work.**
  Electron does not support CDP browser-context creation. Specs that need more
  than one page belong in the launch mode.
- **Any local process can drive Dyad while the flag is on**, because the
  debugging port is open for the whole session. This is the main reason the
  experiment is opt-in and warns in the settings UI.

## What it buys

- No Chromium download (~150MB) and no system-Chrome detection — the app already
  has a browser engine.
- No window pops up over the user's work; the run is visible in the panel where
  they were already looking. A preview-panel run sets `previewPanel: true` on the
  `tests:run-state` "started" event so the renderer brings the preview tab
  forward — which also keeps the view on screen, since Chromium render-throttles
  an off-screen view and that stalls Playwright's actionability checks.

## The attached context also contains Dyad's own window

`connectOverCDP` gives you the whole browser, and Dyad's main window is a page
in the same context as the preview view. Two context-wide Playwright options are
therefore actively wrong here and are set to `"off"` in the generated config:

- `screenshot: "only-on-failure"` shoots **every** page in the context. The
  first artifact was a screenshot of Dyad's own UI — which the Tests panel would
  display as the failure, and which `findFirstScreenshot` in the agent's
  `run_tests` tool would upload to the model along with the user's chat and code.
  The fixture takes the screenshot itself, from the preview page only.
- `trace: "retain-on-failure"` records screencast frames for the whole context,
  so it leaks the same way. Traces are unavailable in this mode.

When adding anything else that operates on `context` rather than `page`, assume
it sees Dyad's window too.

## Diagnosing "it did nothing"

The two failure reports look identical from the outside — blank preview, browser
window still opens — so both paths now say why:

- **Settings** shows whether the experiment is actually operative in this
  process (`preview-view:status`), not just switched on. Enabling the setting
  does nothing until a restart, because the remote-debugging switch is applied
  before `app.whenReady()`.
- **A test run** that falls back prints `Reason: …` into the run output naming
  the missing precondition (port closed, no preview view open, preview on a
  different origin, port not published).

Keep both. A silent fallback here is indistinguishable from a broken feature.

## Gotchas found while building it

- **The panel remounts more often than you think.** `PreviewPanel` keys
  `PreviewIframe` on the reload token, so every reload tears down and rebuilds
  `PreviewWebContentsView`. The unmount's park and the remount's show travel on
  different IPC channels with no ordering guarantee — if the park lands last,
  the view sits at its off-screen coordinates forever and the panel looks blank
  for the rest of the session. Parks are deferred by a macrotask so a remount in
  the same tick cancels them (`pendingParks`).

- **Playwright resolves reporter output and `outputDir` against the config's
  directory, not the cwd.** In the launch mode the config sits at the app root
  so the two coincide and the distinction is invisible; here the config is in
  `.dyad-e2e/`, so `PLAYWRIGHT_JSON_OUTPUT_NAME=test-results/results.json` wrote
  the report to `.dyad-e2e/test-results/` and every run reported "the test
  runner didn't produce a report". Both the env var and `outputDir` step back
  out with `../` so all artifacts land in the app's own `test-results/` — which
  `readTestScreenshotDataUrl` also requires, since it only serves files whose
  first path segment is `test-results`.
- **`testInfo.attach` with a `body` is not enough.** The JSON reporter inlines a
  body as base64 and leaves `path` undefined, and Dyad's `screenshotFromResult`
  only picks up attachments that have a path. Write the file first
  (`testInfo.outputPath(...)`) and attach by path.

- `WebContentsView` bounds are DIP relative to the window's content view, which
  matches `getBoundingClientRect()` at zoom factor 1. Round them, and never let
  width/height reach 0 — Chromium stops compositing and the view can stay blank
  after real bounds arrive.
- The preview view must **outlive** `PreviewIframe`. That component unmounts on
  every tab switch, so releasing the view there would reload the app each time
  and delete the CDP target a run is about to attach to. Unmount parks it
  (`preview-view:set-visible`); only an app switch or quit destroys it.
- Playwright reports spec paths relative to the config's `rootDir`, so this mode
  yields `foo.spec.ts` where the launch mode yields `e2e-tests/foo.spec.ts`.
  `reconcileResultFile` in `src/lib/testResultUtils.ts` already handles the
  difference — do not "fix" it by rewriting paths in the report parser.
