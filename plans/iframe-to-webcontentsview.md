# Migrating the Preview from `<iframe>` to `WebContentsView`

**Status:** Phase 1 in a draft PR · Phases 2–3 not started

## Summary

Dyad renders the user's app in an `<iframe>` inside the renderer. Playwright cannot attach to
that iframe, so E2E runs can't be driven where the user is looking. Phase 1 adds an Electron
`WebContentsView` — a native child of the window, controllable over the Chrome DevTools
Protocol (CDP) — and uses it **only while tests run**. Phases 2 and 3 widen that view to
ordinary browsing and then retire the iframe.

The hard part is not the view. It is that every preview feature is wired to the iframe as a
DOM element, and those features stop working the moment the preview is no longer a child frame.

| Phase | What the user gets                                 | WebContentsView used for | Status      |
| ----- | -------------------------------------------------- | ------------------------ | ----------- |
| 1     | iframe by default, native view during test runs    | test runs only           | draft PR    |
| 2     | iframe by default, native view can also be browsed | test runs + browsing     | not started |
| 3     | native view only; iframe deleted                   | everything               | not started |

---

## Phase 1 — a native view for test runs

**Why a native view.** Playwright cannot attach to an iframe running inside the Electron
renderer. A `WebContentsView` is a top-level page in its own process, so CDP can drive it.

**Why it is scoped to test runs.** Manual interaction stays on the iframe because several
features depend on `postMessage` into it: component selection, the visual editor, the
annotator, and browser console capture. The native view also composites above all renderer
DOM, so it can obscure Dyad menus and notifications. It is not offered as a general
replacement.

**Positioning.** The view lives outside the React tree and does not follow the Preview panel
on its own. The renderer measures a placeholder element where the iframe would be and streams
those bounds to main, updating on `ResizeObserver` callbacks, window resizes, zoom changes,
and a low-frequency verify tick — the tick catches layout shifts that move the placeholder
without resizing it. Measured CSS pixels are multiplied by the renderer zoom factor, because
`setBounds` works in window DIPs.

**Wiring Playwright.** Electron opens a loopback CDP endpoint at boot when the experiment is
on — which is why enabling it requires a restart. Playwright's config cannot express this
connection: `connectOptions` speaks the Playwright protocol rather than CDP, and fixtures
cannot come from a config file. So the bootstrap generates a fixture shim plus an
`e2e-tests/tsconfig.json` that maps `@playwright/test` onto it, rerouting existing specs
unmodified. The shim is inert unless `DYAD_PREVIEW_CDP_ENDPOINT` is set, so ordinary Tests
panel runs, the agent's `run_tests` tool, and `npm test` outside Dyad are untouched.

**Lifecycle.** A test run is the only way into the native view. While a run owns it, hiding
the Preview panel downgrades to `setVisible(false)` instead of destroying the page, so the run
survives the user navigating away. With no run in flight the view closes and hands the user
back to the Tests panel with results. A hard destroy mid-run reports "the preview was closed"
rather than a bare CDP disconnect. External-link side effects are suppressed for the duration
so a driven test cannot spray windows into the system browser.

**Planned: synthetic cursor for watched runs** (plan: `plans/preview-test-cursor.md`).
Playwright teleports between elements, so a watched run is hard to follow. Since nothing can
draw over the native view, a fake cursor is drawn inside the driven page itself:

- Run slowed via `connectOverCDP`'s `slowMo`, preview runs only
- The fixture shim intercepts pointer actions and measures the target (`boundingBox`)
- A page-injected runtime glides the cursor to the target — straight path, eased, slow
  motion — over the existing CDP channel; no new bridge into the sandboxed view
- Clicks land with a border flash + overlay pulse on the target element
- Inert outside preview runs; action semantics and errors unchanged

---

## Phases 2 and 3 — why browsing isn't there yet

**Everything Dyad injects talks to `window.parent`.** The component selector, visual editor,
screenshot client, console/network capture, and the navigation shim are all scripts our proxy
injects into the app's page. Each posts messages to its parent window and ignores anything
that didn't come from that parent. A `WebContentsView` is a top-level page — it has no parent.
Messages go into the void, Dyad hears nothing, and the navigation shim never even starts:
`worker/dyad-shim.js` returns immediately when `window.parent === window`.

There is no fallback channel by design. The view is deliberately sandboxed
(`sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`, no preload) with no
bridge to Dyad, because the previewed app is untrusted, user-generated code.

**Features that go dark:** component selection into chat · the visual editor (text, style,
image swaps) · the annotator · console and network capture plus in-app error reporting · SPA
navigation history, partly masked today by falling back to Chromium's own back/forward.

**Problems beyond messaging**

- **Compositing.** The OS paints the view above everything in the window. No Dyad UI can be
  drawn over the preview — error banners, loading states, the visual editing toolbar, the
  annotator canvas, and any dropdown or tooltip overlapping the preview area.
- **Layout.** It isn't laid out by CSS; Dyad streams measured coordinates several times a
  second. Device mode is a CSS width today (768px tablet / 375px mobile).
- **Zoom.** It does not inherit the window's zoom level.
- **Lifecycle.** Hiding it destroys it — already worked around to keep a test run alive.

**Why it isn't a small change.** Preview features are wired to the iframe as a DOM element,
not to an abstraction. Fifteen call sites across five files post messages straight at
`iframe.contentWindow`, and the raw element is shared globally through `previewIframeRefAtom`
— reaching as far as the chat input. A transport abstraction exists, but most features bypass
it. There is no single place where "which preview am I talking to" is decided.

---

## Cost of the status quo

Two previews to maintain, with divergent behavior. What our E2E tests drive is not what users
actually use, so preview behavior verified in CI is not the behavior we ship. And the gap is
visible to users as a degraded mode they're told to exit.

## What Phase 2 has to build first

1. A sanctioned message channel between the sandboxed view and Dyad, replacing `window.parent`
   for injected scripts without handing untrusted code a bridge to the main process.
2. One preview transport, with every feature routed through it and the global raw-element
   reference removed — so "which preview am I talking to" is decided in one place.
3. An answer for Dyad UI that must draw over the preview, for device-mode widths, and for zoom
   inheritance.
