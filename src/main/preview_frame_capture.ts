/**
 * Freezing a preview surface means showing its last painted frame while the
 * live surface is unavailable or would be distracting: during a reload, while a
 * panel resize is in flight, when the tab is hidden, and when a test run pauses
 * on a failing step.
 *
 * All four want the same primitive — one still frame plus its dimensions — so it
 * lives here rather than being re-derived per caller.
 */

export interface CapturedFrame {
  dataUrl: string;
  width: number;
  height: number;
}

interface CapturableImage {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  toDataURL(): string;
}

export interface CapturableContents {
  isDestroyed(): boolean;
  capturePage(): Promise<CapturableImage>;
}

/**
 * Capture the current painted frame. Returns null rather than throwing when the
 * surface is gone or has not painted yet — every caller treats "no frame" as
 * "keep showing whatever is already there", not as an error.
 */
export async function capturePreviewFrame(
  contents: CapturableContents | null | undefined,
): Promise<CapturedFrame | null> {
  if (!contents || contents.isDestroyed()) return null;
  try {
    const image = await contents.capturePage();
    if (image.isEmpty()) return null;
    const { width, height } = image.getSize();
    if (width === 0 || height === 0) return null;
    return { dataUrl: image.toDataURL(), width, height };
  } catch {
    return null;
  }
}
