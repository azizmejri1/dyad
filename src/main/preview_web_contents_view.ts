import { WebContentsView, shell } from "electron";
import type { BrowserWindow } from "electron";
import log from "electron-log";

import { safeSend } from "../ipc/utils/safe_sender";
import {
  previewViewEvents,
  type PreviewViewBounds,
} from "../ipc/types/preview_view";

const logger = log.scope("preview_web_contents_view");

/** Chromium's ERR_ABORTED, emitted whenever a load is superseded or cancelled. */
const ERR_ABORTED = -3;

const SUPPORTED_PROTOCOLS = new Set(["http:", "https:"]);

interface PreviewViewEntry {
  view: WebContentsView;
  /** The URL most recently handed to loadURL, used to keep `show` idempotent. */
  currentUrl: string | null;
  disposeHostHooks: () => void;
}

/**
 * Live preview views, keyed by the id of the *host* renderer's webContents so
 * each product window gets its own view. Entries only exist while the preview
 * is meant to be visible: hiding destroys the view rather than detaching it, so
 * a backgrounded preview cannot keep timers, sockets, or audio running.
 */
const entries = new Map<number, PreviewViewEntry>();

function resolveKey(window: BrowserWindow): number | null {
  try {
    if (window.isDestroyed()) return null;
    return window.webContents.id;
  } catch {
    return null;
  }
}

function getEntry(window: BrowserWindow): PreviewViewEntry | undefined {
  const key = resolveKey(window);
  return key === null ? undefined : entries.get(key);
}

export function isSupportedPreviewUrl(url: string): boolean {
  try {
    return SUPPORTED_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

function roundBounds(bounds: PreviewViewBounds) {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.max(0, Math.round(bounds.width)),
    height: Math.max(0, Math.round(bounds.height)),
  };
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function openExternally(url: string): void {
  if (!isSupportedPreviewUrl(url)) return;
  void shell.openExternal(url).catch((error) => {
    logger.warn(`Failed to open ${url} externally:`, error);
  });
}

function emitNavigationState(
  window: BrowserWindow,
  entry: PreviewViewEntry,
): void {
  const contents = entry.view.webContents;
  if (contents.isDestroyed()) return;

  safeSend(window.webContents, previewViewEvents.navigationState.channel, {
    url: contents.getURL(),
    canGoBack: contents.navigationHistory.canGoBack(),
    canGoForward: contents.navigationHistory.canGoForward(),
    isLoading: contents.isLoading(),
  } satisfies {
    url: string;
    canGoBack: boolean;
    canGoForward: boolean;
    isLoading: boolean;
  });
}

function createEntry(window: BrowserWindow, key: number): PreviewViewEntry {
  const view = new WebContentsView({
    webPreferences: {
      // The previewed app is untrusted, user-generated code. It gets no
      // preload, no Node, and no access to Dyad's IPC surface.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  const entry: PreviewViewEntry = {
    view,
    currentUrl: null,
    disposeHostHooks: () => {},
  };

  const contents = view.webContents;

  contents.setWindowOpenHandler(({ url }) => {
    openExternally(url);
    return { action: "deny" };
  });

  const restrictNavigation = (
    event: Electron.Event,
    url: string,
    isInPlace?: boolean,
    isMainFrame?: boolean,
  ) => {
    // Sub-frame and same-document navigations stay inside the app.
    if (isMainFrame === false || isInPlace) return;
    if (entry.currentUrl && sameOrigin(url, entry.currentUrl)) return;

    event.preventDefault();
    logger.debug(`Opening off-origin preview navigation externally: ${url}`);
    openExternally(url);
  };
  contents.on("will-navigate", restrictNavigation);
  contents.on("will-redirect", restrictNavigation);

  const publishNavigationState = () => emitNavigationState(window, entry);
  contents.on("did-navigate", publishNavigationState);
  contents.on("did-navigate-in-page", publishNavigationState);
  contents.on("did-start-loading", publishNavigationState);
  contents.on("did-stop-loading", publishNavigationState);

  contents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === ERR_ABORTED) return;
      safeSend(window.webContents, previewViewEvents.loadFailed.channel, {
        errorCode,
        errorDescription,
        url: validatedURL,
      });
    },
  );

  window.contentView.addChildView(view);

  // The host renderer navigating away (a dev-mode reload, for instance) tears
  // down the React tree without running cleanup, which would otherwise leave
  // this view floating over a renderer that no longer knows about it.
  const onHostNavigation = (
    _event: Electron.Event,
    _url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (!isMainFrame || isInPlace) return;
    destroyEntry(key, window);
  };
  const onWindowClosed = () => destroyEntry(key, window);

  window.webContents.on("did-start-navigation", onHostNavigation);
  window.once("closed", onWindowClosed);

  entry.disposeHostHooks = () => {
    if (window.isDestroyed()) return;
    window.webContents.removeListener("did-start-navigation", onHostNavigation);
    window.removeListener("closed", onWindowClosed);
  };

  entries.set(key, entry);
  return entry;
}

function destroyEntry(key: number, window: BrowserWindow): void {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);

  try {
    entry.disposeHostHooks();
  } catch (error) {
    logger.warn("Failed to remove preview view host hooks:", error);
  }

  try {
    if (!window.isDestroyed()) {
      window.contentView.removeChildView(entry.view);
    }
  } catch (error) {
    logger.warn("Failed to detach preview view:", error);
  }

  try {
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close();
    }
  } catch (error) {
    logger.warn("Failed to close preview view webContents:", error);
  }
}

/**
 * Shows the preview view for `window`, creating it on first call.
 *
 * Idempotent: repeated calls with the same URL only re-apply bounds, so the
 * renderer can call this freely on remount without reloading the app.
 */
export function showPreviewView(
  window: BrowserWindow,
  { url, bounds }: { url: string; bounds: PreviewViewBounds },
): void {
  if (!isSupportedPreviewUrl(url)) {
    throw new Error(`Unsupported preview URL: ${url}`);
  }

  const key = resolveKey(window);
  if (key === null) return;

  const entry = entries.get(key) ?? createEntry(window, key);
  entry.view.setBounds(roundBounds(bounds));

  if (entry.currentUrl !== url) {
    entry.currentUrl = url;
    void entry.view.webContents.loadURL(url).catch((error) => {
      // A superseded load rejects with ERR_ABORTED; did-fail-load reports the
      // failures that actually matter to the user.
      logger.debug(
        `Preview view load settled with an error for ${url}:`,
        error,
      );
    });
  } else {
    // Remounted renderer: replay current state so the toolbar isn't blank.
    emitNavigationState(window, entry);
  }
}

export function setPreviewViewBounds(
  window: BrowserWindow,
  bounds: PreviewViewBounds,
): void {
  const entry = getEntry(window);
  if (!entry) return;

  try {
    entry.view.setBounds(roundBounds(bounds));
  } catch (error) {
    logger.warn("Failed to set preview view bounds:", error);
  }
}

export function hidePreviewView(window: BrowserWindow): void {
  const key = resolveKey(window);
  if (key === null) return;
  destroyEntry(key, window);
}

function withLiveContents(
  window: BrowserWindow,
  action: (contents: Electron.WebContents) => void,
): void {
  const entry = getEntry(window);
  if (!entry) return;
  const contents = entry.view.webContents;
  if (contents.isDestroyed()) return;

  try {
    action(contents);
  } catch (error) {
    logger.warn("Preview view navigation command failed:", error);
  }
}

export function previewViewGoBack(window: BrowserWindow): void {
  withLiveContents(window, (contents) => {
    if (contents.navigationHistory.canGoBack()) {
      contents.navigationHistory.goBack();
    }
  });
}

export function previewViewGoForward(window: BrowserWindow): void {
  withLiveContents(window, (contents) => {
    if (contents.navigationHistory.canGoForward()) {
      contents.navigationHistory.goForward();
    }
  });
}

export function previewViewReload(window: BrowserWindow): void {
  withLiveContents(window, (contents) => contents.reload());
}

/** Test-only: drops all tracked views without touching Electron objects. */
export function resetPreviewViewsForTesting(): void {
  entries.clear();
}
