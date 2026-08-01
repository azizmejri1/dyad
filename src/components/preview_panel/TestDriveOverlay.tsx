import { useEffect, useState } from "react";
import { ipc } from "@/ipc/types";
import { FlaskConical } from "lucide-react";

/**
 * Shows a Watch-in-Dyad run in the preview panel.
 *
 * The live iframe stays mounted underneath and is never unloaded, so when the
 * run ends the user is returned to their app exactly where they left it —
 * logged in, scrolled, mid-form. This is only a cover.
 *
 * Frames are painted into an ordinary <img>, which is what keeps the rest of
 * the panel's chrome compositing above it normally.
 */
export function TestDriveOverlay({ appId }: { appId: number | null }) {
  const [active, setActive] = useState(false);
  const [frame, setFrame] = useState<string | null>(null);

  useEffect(() => {
    const offState = ipc.events.tests.onPreviewState((payload) => {
      if (appId != null && payload.appId !== appId) return;
      setActive(payload.active);
      // Drop the last frame on release so a later run never flashes the
      // previous one before its first frame lands.
      if (!payload.active) setFrame(null);
    });
    const offFrame = ipc.events.tests.onPreviewFrame((payload) => {
      if (appId != null && payload.appId !== appId) return;
      setFrame(payload.dataUrl);
    });
    return () => {
      offState?.();
      offFrame?.();
    };
  }, [appId]);

  if (!active) return null;

  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-background"
      data-testid="test-drive-overlay"
    >
      <div className="flex items-center gap-2 border-b border-border bg-teal-50 px-3 py-1.5 text-xs text-teal-800 dark:bg-teal-950/60 dark:text-teal-200">
        <FlaskConical size={14} />
        <span>Tests are driving this preview</span>
      </div>
      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-neutral-900">
        {frame ? (
          <img
            src={frame}
            alt="Test run in progress"
            className="max-h-full max-w-full object-contain"
            data-testid="test-drive-frame"
          />
        ) : (
          <span className="text-xs text-neutral-400">
            Waiting for the first frame…
          </span>
        )}
      </div>
    </div>
  );
}
