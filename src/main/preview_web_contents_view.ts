import log from "electron-log";
import { BrowserWindow, WebContentsView, type WebContents } from "electron";
import { broadcastToRegisteredWindows } from "@/ipc/utils/window_broadcast";
import type { PreviewViewEventPayload } from "@/ipc/types/preview_view";

const logger = log.scope("preview_web_contents_view");

export interface PreviewViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface PreviewViewEntry {
  view: WebContentsView;
  window: BrowserWindow;
  windowId: number;
  appId: number;
  /** URL + reload token we last asked the view to load. */
  requestedUrl: string;
  bounds: PreviewViewBounds;
  visible: boolean;
}

/**
 * Live preview views, keyed `windowId:appId`.
 *
 * Scoped per window because two Dyad windows can show different apps at once;
 * within one window we keep exactly one view alive (see `syncPreviewView`).
 *
 * The view deliberately OUTLIVES the React component that positions it: the
 * preview panel unmounts whenever the user switches to the Code or Tests tab,
 * and destroying the view there would both reload the app on every tab switch
 * and delete the CDP target a test run is about to attach to. Unmount parks the
 * view off-screen instead.
 */
const previewViews = new Map<string, PreviewViewEntry>();

const keyOf = (windowId: number, appId: number) => `${windowId}:${appId}`;

/**
 * A snapshot of the registry to iterate over. `destroyEntry` deletes from the
 * live map, so every loop that can destroy must walk a copy.
 */
function entriesSnapshot(): [string, PreviewViewEntry][] {
  return Array.from(previewViews.entries());
}

/**
 * A `WebContentsView` is a sibling of the window's web content, not part of it,
 * so it can't be hidden with CSS. Parking it outside the window is how we get
 * it out of the way while keeping the page (and its CDP target) alive.
 */
const OFFSCREEN_BOUNDS: PreviewViewBounds = {
  x: -20000,
  y: -20000,
  width: 1,
  height: 1,
};

function emit(sender: WebContents, payload: PreviewViewEventPayload): void {
  broadcastToRegisteredWindows(sender, "preview-view:event", payload);
}

/** Only ever let the preview view render http(s); never file:// or app pages. */
function isAllowedPreviewUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function roundBounds(bounds: PreviewViewBounds): PreviewViewBounds {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    // A zero/negative size makes Chromium skip compositing entirely, after
    // which the view can stay blank even once real bounds arrive.
    width: Math.max(1, Math.round(bounds.width)),
    height: Math.max(1, Math.round(bounds.height)),
  };
}

function applyBounds(entry: PreviewViewEntry): void {
  // A collapsed panel reports a degenerate rectangle. Park rather than clamp it
  // to 1x1, which would leave a visible speck in the window corner.
  const onScreen =
    entry.visible && entry.bounds.width >= 2 && entry.bounds.height >= 2;
  entry.view.setBounds(onScreen ? roundBounds(entry.bounds) : OFFSCREEN_BOUNDS);
}

function createPreviewView(
  appId: number,
  window: BrowserWindow,
  sender: WebContents,
): PreviewViewEntry {
  const view = new WebContentsView({
    webPreferences: {
      // The preview renders AI-generated app code — same trust level as the
      // sandboxed iframe it replaces, so it gets no preload and no Node.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isAllowedPreviewUrl(url)) {
      event.preventDefault();
      logger.warn(`Blocked preview navigation to ${url}`);
    }
  });

  contents.on("did-finish-load", () => {
    emit(sender, { appId, type: "loaded", url: contents.getURL() });
  });
  contents.on("did-navigate", (_event, url) => {
    emit(sender, { appId, type: "navigated", url });
  });
  contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
    if (isMainFrame) {
      emit(sender, { appId, type: "navigated", url });
    }
  });
  contents.on("did-fail-load", (_event, errorCode, errorDescription, url) => {
    // -3 (ABORTED) is what a superseded navigation reports; not a user-visible
    // error.
    if (errorCode === -3) return;
    emit(sender, {
      appId,
      type: "failed",
      url,
      message: `${errorDescription} (${errorCode})`,
    });
  });
  contents.on("console-message", (event) => {
    emit(sender, {
      appId,
      type: "console",
      level: String(event.level),
      message: event.message,
    });
  });

  window.contentView.addChildView(view);

  const entry: PreviewViewEntry = {
    view,
    window,
    windowId: window.id,
    appId,
    requestedUrl: "",
    bounds: OFFSCREEN_BOUNDS,
    visible: false,
  };
  applyBounds(entry);
  previewViews.set(keyOf(window.id, appId), entry);
  logger.info(`Created preview WebContentsView for app ${appId}`);
  return entry;
}

export interface SyncPreviewViewInput {
  appId: number;
  url: string;
  bounds: PreviewViewBounds;
  visible: boolean;
  /** Bump to force a reload of an unchanged URL. */
  reloadToken?: number;
  sender: WebContents;
}

/**
 * Reconcile the native view with what the renderer says it should be: called on
 * mount and on every resize/scroll/URL/visibility change of the preview slot.
 */
export function syncPreviewView({
  appId,
  url,
  bounds,
  visible,
  reloadToken,
  sender,
}: SyncPreviewViewInput): void {
  if (!isAllowedPreviewUrl(url)) {
    logger.warn(`Refusing to show preview view for disallowed URL: ${url}`);
    return;
  }
  const window = BrowserWindow.fromWebContents(sender);
  if (!window || window.isDestroyed()) {
    return;
  }

  // One live view per window: showing a different app retires the previous
  // app's view rather than leaving a second renderer process parked forever.
  for (const [key, other] of entriesSnapshot()) {
    if (other.windowId === window.id && other.appId !== appId) {
      destroyEntry(key, other);
    }
  }

  const key = keyOf(window.id, appId);
  let entry = previewViews.get(key);
  if (entry?.view.webContents.isDestroyed()) {
    previewViews.delete(key);
    entry = undefined;
  }
  if (!entry) {
    entry = createPreviewView(appId, window, sender);
  }

  const reloadKey = `${url}#${reloadToken ?? 0}`;
  if (entry.requestedUrl !== reloadKey) {
    entry.requestedUrl = reloadKey;
    entry.view.webContents.loadURL(url).catch((error) => {
      logger.warn(`Preview view failed to load ${url}: ${error}`);
    });
  }

  entry.bounds = bounds;
  entry.visible = visible;
  applyBounds(entry);
}

/**
 * Show or park the view without touching its bounds or its page. Used when the
 * preview panel unmounts (tab switch) and when a run needs the view on screen.
 */
export function setPreviewViewVisible(appId: number, visible: boolean): void {
  for (const entry of previewViews.values()) {
    if (entry.appId !== appId) continue;
    if (entry.view.webContents.isDestroyed()) continue;
    entry.visible = visible;
    applyBounds(entry);
  }
}

function destroyEntry(key: string, entry: PreviewViewEntry): void {
  previewViews.delete(key);
  try {
    if (!entry.window.isDestroyed()) {
      entry.window.contentView.removeChildView(entry.view);
    }
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close();
    }
  } catch (error) {
    logger.warn(
      `Failed to destroy preview view for app ${entry.appId}: ${error}`,
    );
  }
  logger.info(`Destroyed preview WebContentsView for app ${entry.appId}`);
}

export function destroyPreviewView(appId: number): void {
  for (const [key, entry] of entriesSnapshot()) {
    if (entry.appId === appId) {
      destroyEntry(key, entry);
    }
  }
}

export function destroyAllPreviewViews(): void {
  for (const [key, entry] of entriesSnapshot()) {
    destroyEntry(key, entry);
  }
}

/**
 * The URL the app's preview view is currently showing, or null when no live
 * view exists. A test run uses this both to confirm a preview target exists and
 * to restore the user's page afterwards.
 */
export function getPreviewViewUrl(appId: number): string | null {
  for (const entry of previewViews.values()) {
    if (entry.appId !== appId) continue;
    if (entry.view.webContents.isDestroyed()) continue;
    return entry.view.webContents.getURL() || null;
  }
  return null;
}

/** Send the preview view back to a URL (used to restore state after a run). */
export function navigatePreviewView(appId: number, url: string): void {
  if (!isAllowedPreviewUrl(url)) return;
  for (const entry of previewViews.values()) {
    if (entry.appId !== appId) continue;
    if (entry.view.webContents.isDestroyed()) continue;
    entry.requestedUrl = `${url}#restore`;
    entry.view.webContents.loadURL(url).catch((error) => {
      logger.warn(`Preview view failed to restore ${url}: ${error}`);
    });
    return;
  }
}
