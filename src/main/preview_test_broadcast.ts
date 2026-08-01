import log from "electron-log";
import { broadcastToRegisteredWindows } from "@/ipc/utils/window_broadcast";
import { PreviewScreencast } from "./preview_screencast";
import type { PreviewTestSession } from "./preview_test_window";

const logger = log.scope("preview_test_broadcast");

/** Channel the preview panel listens on to paint a run. */
export const PREVIEW_TEST_FRAME_CHANNEL = "tests:preview-frame";
/** Channel announcing that a run has taken over / released the preview. */
export const PREVIEW_TEST_STATE_CHANNEL = "tests:preview-state";

export interface PreviewTestFrameMessage {
  appId: number;
  /** A ready-to-assign img/canvas source. */
  dataUrl: string;
  width: number;
  height: number;
}

export interface PreviewTestStateMessage {
  appId: number;
  active: boolean;
}

/**
 * Starts streaming a run into the preview panel and returns the teardown.
 *
 * Screencast failures are logged and swallowed: losing the picture should
 * degrade a Watch-in-Dyad run to an invisible one, never fail the tests.
 */
export function startPreviewTestBroadcast(
  appId: number,
  session: PreviewTestSession,
): () => Promise<void> {
  const contents = session.window.webContents;

  const screencast = new PreviewScreencast(
    contents.debugger as unknown as ConstructorParameters<
      typeof PreviewScreencast
    >[0],
    (frame) => {
      broadcastToRegisteredWindows(null, PREVIEW_TEST_FRAME_CHANNEL, {
        appId,
        dataUrl: `data:image/jpeg;base64,${frame.data}`,
        width: frame.metadata.deviceWidth,
        height: frame.metadata.deviceHeight,
      } satisfies PreviewTestFrameMessage);
    },
  );

  broadcastToRegisteredWindows(null, PREVIEW_TEST_STATE_CHANNEL, {
    appId,
    active: true,
  } satisfies PreviewTestStateMessage);

  void screencast.start().catch((error) => {
    logger.error("Could not start the preview screencast", error);
  });

  return async () => {
    await screencast.stop().catch(() => undefined);
    broadcastToRegisteredWindows(null, PREVIEW_TEST_STATE_CHANNEL, {
      appId,
      active: false,
    } satisfies PreviewTestStateMessage);
  };
}
