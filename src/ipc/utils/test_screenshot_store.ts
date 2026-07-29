import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

import {
  DYAD_TEST_SCREENSHOT_DIR_NAME,
  MAX_TEST_SCREENSHOTS_PER_APP,
  TEST_SCREENSHOT_FILENAME_REGEX,
} from "./media_path_utils";
import { readTestScreenshotBytes } from "./test_screenshot";

const logger = log.scope("test_screenshot_store");

export type UiScreenshotPhase = "before" | "after";

/**
 * Filename for a UI screenshot. Flat by construction — the `dyad-media://`
 * protocol refuses any filename containing a path separator — and unique per
 * (chat, message, run, phase) so a turn with several before/after pairs never
 * overwrites an earlier card's image.
 */
export function buildUiScreenshotFileName({
  chatId,
  messageId,
  seq,
  phase,
}: {
  chatId: number;
  messageId: number;
  seq: number;
  phase: UiScreenshotPhase;
}): string {
  return `ui-${chatId}-${messageId}-${seq}-${phase}.png`;
}

export function getTestScreenshotDir(appPath: string): string {
  return path.join(appPath, DYAD_TEST_SCREENSHOT_DIR_NAME);
}

/**
 * Copy a Playwright screenshot out of `test-results/` into the app's durable
 * `.dyad/test-screenshot/` directory and return its filename.
 *
 * This copy is what makes the chat card outlive the run: Playwright clears
 * `test-results/` at the start of every run, so a card pointing there would
 * break as soon as the next test executes. `.dyad/` is gitignored, so the
 * copies also survive version checkouts.
 *
 * Reading goes through `readTestScreenshotBytes`, which enforces the same
 * containment guards as the `tests:screenshot` IPC handler (PNG-only, resolved
 * through symlinks, inside the app's `test-results/`). Returns null when the
 * source is missing or fails those guards — a missing screenshot degrades the
 * card, it never fails the run.
 */
export async function persistTestScreenshot({
  appPath,
  sourcePath,
  fileName,
}: {
  appPath: string;
  sourcePath: string;
  fileName: string;
}): Promise<string | null> {
  if (!TEST_SCREENSHOT_FILENAME_REGEX.test(fileName)) {
    logger.warn(`Refusing to persist screenshot with name ${fileName}`);
    return null;
  }

  const bytes = await readTestScreenshotBytes(appPath, sourcePath);
  if (!bytes) {
    return null;
  }

  const targetDir = getTestScreenshotDir(appPath);
  try {
    await fs.promises.mkdir(targetDir, { recursive: true });
    await fs.promises.writeFile(path.join(targetDir, fileName), bytes);
  } catch (error) {
    logger.warn(`Failed to persist screenshot ${fileName}: ${error}`);
    return null;
  }

  await pruneTestScreenshots(appPath);
  return fileName;
}

/**
 * Keep only the newest MAX_TEST_SCREENSHOTS_PER_APP screenshots by mtime.
 * Only files matching our naming convention are considered or deleted, so
 * anything else in the directory is left untouched.
 */
export async function pruneTestScreenshots(appPath: string): Promise<void> {
  const dir = getTestScreenshotDir(appPath);
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }

  const stated: { name: string; mtimeMs: number }[] = [];
  for (const entry of entries) {
    if (!TEST_SCREENSHOT_FILENAME_REGEX.test(entry)) continue;
    try {
      const stat = await fs.promises.stat(path.join(dir, entry));
      stated.push({ name: entry, mtimeMs: stat.mtimeMs });
    } catch {
      // Disappeared between readdir and stat — nothing to prune.
    }
  }
  if (stated.length <= MAX_TEST_SCREENSHOTS_PER_APP) return;

  stated.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const extra of stated.slice(MAX_TEST_SCREENSHOTS_PER_APP)) {
    await fs.promises.unlink(path.join(dir, extra.name)).catch(() => {});
  }
}
