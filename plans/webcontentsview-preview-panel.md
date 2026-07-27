# Preview panel: migrate from `<iframe>` to `WebContentsView`

**Goal:** run Playwright e2e tests *inside* the preview panel — the user watches
generated tests drive their app live in Dyad (the "integrated browser" model,
cf. VS Code's integrated-browser agent skill) instead of today's detached
headless Chromium. Secondary wins: real process isolation for previews, native
navigation/capture APIs, and a CDP target that agent tooling can drive.

## Why the iframe can't get us there

The preview is a sandboxed cross-origin `<iframe>` inside the main window's
renderer (`src/components/preview_panel/PreviewIframe.tsx`). To Chromium it is
an OOPIF of the Dyad UI page, not an addressable CDP `Page` target, so
`playwright test` cannot bind to it. Everything else about the preview is built
around that embedding:

- `worker/proxy_server.js` proxies the dev server and injects `dyad-shim.js`
  plus the component-selector / screenshot / visual-editor / logs clients into
  the app's HTML.
- All preview↔UI traffic is `window.parent.postMessage` (the shim exits early
  unless `window.parent !== window`), routed in the renderer by
  `src/preview_iframe/commands.ts` into the renderer-owned preview state
  machine (`src/preview_iframe/*`: history, `iframeEpoch`, errors, selector
  lifecycle).
- Overlays (error banner, visual-editing toolbar, annotator, dropdowns,
  dialogs) are ordinary DOM siblings stacked above the iframe.
- Device modes are CSS width on the iframe; screenshots are `html-to-image`
  inside the frame; app tests run via `npx playwright test` against a
  Dyad-written config (`src/ipc/handlers/tests_handlers.ts`,
  `src/ipc/utils/playwright_bootstrap.ts`) in a separate browser.
- Dyad's own e2e suite reaches into the preview with
  `iframe.contentFrame()` (~15 specs + `PreviewPanel` page object).

## Target architecture

`WebContentsView` (Electron ≥ 30; we're on 40) gives each preview its own
top-level `webContents` attached to `mainWindow.contentView`.

- **Main:** a `PreviewViewService` owns one `WebContentsView` per app
  (session `partition` per app, preload bridge, `setWindowOpenHandler` on the
  view). The preview navigation state machine moves to main — consistent with
  `docs/adr/main-owned-state-machines.md` — fed by real `webContents` events
  (`did-navigate`, `did-navigate-in-page`, `did-fail-load`,
  `render-process-gone`) instead of shim messages.
- **Renderer:** the panel keeps a placeholder `<div>` where the iframe was; a
  `ResizeObserver` reports bounds over IPC (rAF-throttled, DPR-aware) to
  `view.setBounds(...)`. The toolbar dispatches intents (navigate, reload,
  back/forward via `webContents.navigationHistory`) and subscribes to the
  main-owned read model. Keep the placeholder's
  `data-testid="preview-iframe-element"` contract stable for e2e.
- **Bridge:** keep proxy-side shim injection, but swap the transport: the
  view's preload exposes `contextBridge`-safe `postMessage`/`onMessage`; main
  forwards to the UI window(s) through the existing `WindowRegistry`. Message
  schemas stay identical so `routePreviewIframeMessage` and the component
  message handling in `PreviewIframe.tsx` survive largely unchanged. The
  shim's `isInsideIframe` guard becomes "bridge present".
- **Native replacements:** `webContents.capturePage()` replaces the
  html-to-image screenshot path (annotator + commit screenshots, simplifying
  the screenshot capability leases in `window_registry.ts`);
  `console-message` events replace the console shim;
  `session.clearStorageData()` scoped to the app partition replaces global
  `clearSessionData`; device modes become `setBounds` width (optionally
  `webContents.enableDeviceEmulation` for real mobile UA/touch emulation).

## Running Playwright inside the panel

1. When testing is enabled for an app, start Electron's DevTools protocol on
   loopback: `app.commandLine.appendSwitch("remote-debugging-port", "0")` at
   launch (requires relaunch to toggle; gate on the existing per-app testing
   opt-in), discover the actual port, never expose beyond `127.0.0.1`.
2. Extend the Dyad-written Playwright config with a fixture that calls
   `chromium.connectOverCDP(endpoint)`, locates the preview page in
   `browser.contexts()[0].pages()` (match by URL/targetId supplied by
   `PreviewViewService` over IPC), and hands it to tests as `page`.
3. Constraints to encode in the generated config: `workers: 1` (one visible
   page), never `page.close()`, restore the preview URL after each test, pin
   panel bounds for a stable viewport during a run. Keep today's headless
   runner as the CI-style fallback mode.
4. The same endpoint lets agent skills (integrated-browser style) click,
   navigate, and screenshot the preview during chats.

## Phased plan (behind a `previewRenderer: "iframe" | "webcontentsview"` setting)

- **P0 — spike:** view + bounds sync in the real panel; `connectOverCDP` from a
  scratch script; confirm the preview appears as a `Page` to Playwright
  (including via `electron.launch` for our own e2e); inventory every UI
  surface that overlaps the preview.
- **P1 — view service:** creation/disposal keyed by app (mirroring
  `KeyedControllerHost` semantics), bounds pipeline, toolbar parity
  (navigate/back/forward/reload, address bar, epoch-equivalent hard reload via
  `loadURL`).
- **P2 — bridge swap:** preload transport, shim guard change, console/network/
  error/selector/visual-editing parity over the new channel.
- **P3 — chrome parity:** overlay/z-order handling, device modes, annotator on
  `capturePage`, per-partition session clearing, popup handling.
- **P4 — tests-in-panel:** CDP endpoint plumbing, config fixture, TestsPanel
  "run in preview" toggle, live status while tests drive the view.
- **P5 — flip default:** migrate our e2e page objects off `contentFrame()`
  (the preview becomes a first-class `Page` — mostly a simplification), burn
  in, then delete the iframe path.

## Key risks

| Risk | Notes / mitigation |
| --- | --- |
| **Z-order (highest)** | A `WebContentsView` composites above all window DOM. Dialogs, dropdowns, tooltips, toasts, and the visual-editing toolbar currently overlap the preview. Mitigate per-surface: `view.setVisible(false)` + `capturePage()` snapshot swap while an overlay is open; `setBorderRadius` for rounded corners. P0 must produce the full overlap inventory. |
| Bridge breadth | Five injected client families assume `window.parent`. Migrate behind a transport adapter with unchanged message schemas; parity-test with existing preview e2e specs. |
| Multi-window / tabs (ADR) | A view belongs to one window; tab transfer means `removeChildView`/`addChildView` reparenting wired into `WindowRegistry`. |
| Memory | One `webContents` per app is heavier than an iframe. Dispose views for background apps; cap live views. |
| CDP exposure | Loopback-only, random port, only when testing is enabled; document that it grants control of all windows. |
| Cloud mode | Remote sandbox URLs still flow through the proxy for shim injection — unchanged; frame-ancestors/CSP headaches actually disappear. |
| E2E churn during hybrid | Gate the `PreviewPanel` page object on the setting so both paths stay testable until P5. |

## Open questions

- One persistent view per app vs. a single re-navigated view (what replaces
  `iframeEpoch` identity semantics)?
- Ship preview DevTools (`view.webContents.openDevTools({ mode: "detach" })`)
  as a user-facing feature while we're here?
- Do visual-editing text edits need anything beyond the bridge swap (they
  mutate DOM in-page, so likely no)?
