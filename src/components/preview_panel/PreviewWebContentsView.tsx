import { useEffect, useLayoutEffect, useRef } from "react";
import { ipc } from "@/ipc/types";
import type { PreviewViewBounds } from "@/ipc/types";

/**
 * Placeholder that reserves space for the native preview `WebContentsView`.
 *
 * A `WebContentsView` is a sibling of the window's web contents, so it can't be
 * laid out by CSS. This element is laid out normally and continuously reports
 * its rectangle to the main process, which positions the real view on top of
 * it. Everything the user sees inside the rectangle is the native view.
 *
 * Known consequence of that layering: the native view paints ABOVE all renderer
 * content, so renderer-drawn overlays (dropdown menus, dialogs, toasts) that
 * would cross into the preview area are hidden behind it. Callers pass
 * `visible: false` to park the view off-screen while such an overlay is up.
 */

/**
 * Parks scheduled by an unmount, keyed by app, so a remount can cancel one.
 *
 * `PreviewPanel` keys `PreviewIframe` on the reload token, so every reload
 * tears this component down and immediately builds a new one. The unmount's
 * "park" and the remount's "show" travel on different IPC channels with no
 * ordering guarantee between them — if the park arrives last the view stays at
 * its off-screen coordinates and the panel looks permanently blank. Deferring
 * the park by a macrotask lets the remount (same tick) cancel it, while a real
 * tab switch, which has no remount, still parks.
 */
const pendingParks = new Map<number, ReturnType<typeof setTimeout>>();

function cancelPendingPark(appId: number): void {
  const timer = pendingParks.get(appId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingParks.delete(appId);
  }
}

/** Exported for tests: drop any scheduled park without running it. */
export function resetPendingPreviewParksForTests(): void {
  for (const timer of pendingParks.values()) clearTimeout(timer);
  pendingParks.clear();
}
export function PreviewWebContentsView({
  appId,
  url,
  visible,
  reloadToken,
  className,
  style,
}: {
  appId: number;
  url: string;
  visible: boolean;
  reloadToken?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const lastBoundsRef = useRef<PreviewViewBounds | null>(null);

  // Kept in refs so the observer callbacks below always read current values
  // without having to be torn down and rebuilt on every prop change.
  const latestRef = useRef({ appId, url, visible, reloadToken });
  latestRef.current = { appId, url, visible, reloadToken };

  useLayoutEffect(() => {
    const node = slotRef.current;
    if (!node) return;

    let frame = 0;
    const push = (force: boolean) => {
      const rect = node.getBoundingClientRect();
      const bounds: PreviewViewBounds = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
      const previous = lastBoundsRef.current;
      const unchanged =
        previous !== null &&
        previous.x === bounds.x &&
        previous.y === bounds.y &&
        previous.width === bounds.width &&
        previous.height === bounds.height;
      if (unchanged && !force) return;
      lastBoundsRef.current = bounds;

      const { appId, url, visible, reloadToken } = latestRef.current;
      void ipc.previewView
        .syncPreviewView({ appId, url, bounds, visible, reloadToken })
        .catch((error) => {
          console.error("Failed to sync preview view:", error);
        });
    };

    // Resize/scroll can fire many times per frame; coalesce to one sync.
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        push(false);
      });
    };

    push(true);

    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(node);
    window.addEventListener("resize", schedule);
    // The panel scrolls/moves without resizing when siblings change (e.g. the
    // console drawer opens), which changes the rectangle's origin only.
    window.addEventListener("scroll", schedule, true);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
    };
  }, []);

  // Prop changes (URL, visibility, reload) must reach main even when the
  // rectangle itself is unchanged.
  useEffect(() => {
    if (!slotRef.current) return;
    const rect = slotRef.current.getBoundingClientRect();
    void ipc.previewView
      .syncPreviewView({
        appId,
        url,
        bounds: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
        visible,
        reloadToken,
      })
      .catch((error) => {
        console.error("Failed to sync preview view:", error);
      });
  }, [appId, url, visible, reloadToken]);

  // Unmounting must get the view out of the way — it would otherwise stay
  // painted over whatever replaces the panel. It is parked, not destroyed:
  // this component unmounts on every tab switch, and destroying here would
  // reload the app each time and delete the CDP target a test run attaches to.
  //
  // Mounting cancels a park left behind by a reload-token remount (see
  // `pendingParks`), so the view is not parked out from under its replacement.
  useEffect(() => {
    cancelPendingPark(appId);
    return () => {
      cancelPendingPark(appId);
      pendingParks.set(
        appId,
        setTimeout(() => {
          pendingParks.delete(appId);
          void ipc.previewView
            .setPreviewViewVisible({ appId, visible: false })
            .catch(() => {
              // The window may already be gone; nothing to park.
            });
        }, 0),
      );
    };
  }, [appId]);

  return (
    <div
      ref={slotRef}
      data-testid="preview-web-contents-view-slot"
      className={className}
      style={style}
    />
  );
}
