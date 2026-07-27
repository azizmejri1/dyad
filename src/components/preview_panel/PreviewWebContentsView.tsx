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
  useEffect(() => {
    return () => {
      void ipc.previewView
        .setPreviewViewVisible({ appId, visible: false })
        .catch(() => {
          // The window may already be gone; nothing to park.
        });
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
