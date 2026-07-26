# Preview panel: migrate from `<iframe>` to `WebContentsView`

**Goal:** run an app's e2e tests *inside the preview panel*, instead of Playwright
spawning a separate Chromium window.

## Why the iframe can't get us there

Today the preview panel renders the app in a sandboxed `<iframe>`
(`src/components/preview_panel/PreviewIframe.tsx`) pointed at the dev-server proxy URL,
and the Tests panel (`src/ipc/handlers/tests_handlers.ts` → `runAppTestsCore`) runs
`npx playwright test` inside the app directory. Playwright then launches its own browser
— the user's system Chrome/Edge, or a ~100MB downloaded Chromium
(`src/ipc/utils/playwright_bootstrap.ts`). The two surfaces are unrelated: the test run
is invisible (or a detached window with `--headed`), and we pay for browser
detection/download and its failure modes (offline installs, stale markers, Yarn PnP
dead-ends).

Playwright can only drive a *browser target* — something addressable over the Chrome
DevTools Protocol. The iframe is not one it can reach in isolation: it lives inside
Dyad's own renderer, behind a `sandbox` attribute, sharing Dyad's session and window.
Driving it would mean attaching Playwright to the entire Dyad UI, with no way to scope
navigation, network, or input to just the preview.

## Why `WebContentsView` gets us there

`WebContentsView` (Electron's replacement for `BrowserView`) is a main-process-owned
browser surface composited into the window at bounds we control. Its `webContents` is a
first-class Chromium page target, which means:

- **Playwright can attach to it directly** via `chromium.connectOverCDP()` against
  Electron's debugging endpoint and drive *only the preview*. Tests navigate, click,
  and assert inside the panel, live in front of the user.
- **No browser install, ever.** Electron ships Chromium. The channel-detection and
  Chromium-download halves of `playwright_bootstrap.ts` disappear, along with their
  network failure modes.
- **The run is inherently "headed" at zero cost** — the panel *is* the browser, so
  users watch tests execute in the same surface they use to preview.

Side benefits: native `goBack`/`goForward`/history (replacing our postMessage-tracked
history in `src/preview_iframe/`), `webContents.capturePage()` for annotator/agent
screenshots (replacing the in-page canvas dance), a per-app `session` partition
(real cache/cookie isolation and targeted "Clear preview data"), and immunity to
`X-Frame-Options`/`frame-ancestors` headers that can break iframe embedding.

**The honest cost:** a `WebContentsView` is not a DOM node. It composites *above* the
renderer, so everything that overlaps the preview today — error banner, visual-editing
toolbar, annotator, dropdowns/popovers — needs bounds management or native-view
layering. And the `window.postMessage` bridge (component selector, console/network
capture, error reports) must be rerouted through a preload script + IPC. This is the
bulk of the migration work, not the view itself.

## Migration plan

Each phase ships independently behind a `previewEngine: "iframe" | "webcontents"`
setting, so the iframe path keeps working until the final flip.

**Phase 0 — Spike (de-risk CDP).** Prototype: create a `WebContentsView`, load a proxy
URL, enable CDP, and drive it from a scratch Playwright script via `connectOverCDP`,
scoped to that target only. Also verify the view shows up as a `Page` for Dyad's own
Playwright-for-Electron suite. Nothing merges to the product path until this works.

**Phase 1 — View host.** Main-process `PreviewViewManager` (create/destroy per app,
`loadURL`, `setBounds`, show/hide) with typed IPC. In the renderer, `PreviewIframe.tsx`
renders a placeholder `<div>` and syncs its rect to the view via `ResizeObserver` +
IPC, including device-mode widths and hiding the view when other panel tabs are active.

**Phase 2 — Bridge parity.** A preload script in the view replaces the
`window.postMessage` bridge: component-selector, console/network, screenshot, and error
messages flow preview → preload → IPC → renderer, feeding the *same*
`src/preview_iframe/` state-machine events (swap the `commands.ts` adapter; the
controller/state/transition logic stays). Navigation/history moves to native
`webContents` events; console capture moves to the `console-message` event.

**Phase 3 — Overlay & UX parity.** Error banner, visual-editing toolbar, annotator
(now fed by `capturePage()`), and menus that overlap the preview. Audit every absolute-
positioned element over the preview area; where DOM overlay is impossible, shrink the
view's bounds or temporarily hide it behind a captured snapshot.

**Phase 4 — Tests in the panel (the payoff).** `runAppTestsCore` gains a
`webcontents` engine: enable CDP for the preview's `webContents`, and generate a
`playwright-dyad.config.ts` whose fixtures override `browser`/`context`/`page` to
`connectOverCDP` and reuse the existing preview target instead of launching a browser.
The generated config already runs `workers: 1` serially, which fits a single shared
view. Skip bootstrap's install/download when this engine is active; reload the preview
after the run to restore the user's state. Keep the spawn-a-browser path as the
fallback for `parallel: true` runs until we decide on a hidden-view pool.

**Phase 5 — Flip & clean up.** Default the setting to `webcontents`, migrate Dyad's
own e2e page objects (`PreviewPanel.getPreviewIframeElement()` / `contentFrame()`
snapshots → the preview's Page target), then delete the iframe path, the postMessage
listener, and the browser-download code.

## Risks

| Risk | Mitigation |
| --- | --- |
| Overlay/z-order regressions (banner, toolbar, annotator) | Phase 3 audit; bounds-shrink or snapshot-hide fallback; iframe flag as escape hatch |
| CDP scoping — tests must never touch the Dyad UI target | Attach to the view's target only; validate in Phase 0 spike |
| Test runs mutate the live preview (storage, routes) | Per-app session partition + automatic reload after runs |
| Dyad's own e2e suite churn (page objects, aria snapshots) | Migrate helpers once in Phase 5; flag keeps both paths testable meanwhile |

**Rough sizing:** Phases 0–1 ~1 week; Phase 2 ~1–2 weeks (largest); Phases 3–4 ~1 week
each; Phase 5 a few days. Parallelizable after Phase 1.
