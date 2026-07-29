import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import log from "electron-log";

import { SPEC_FILE_RE, TEMP_TEST_DIR } from "../types/tests";

const logger = log.scope("temp_specs");

/**
 * Delete throwaway screenshot specs left behind by an earlier turn.
 *
 * The agent is told to delete its own temp spec, but turns get interrupted and
 * models forget, so this runs at the start of each agent turn as a safety net.
 * Sweeping at the START (rather than the end) means it can never race the turn
 * that is still using the spec: anything present when a turn begins belongs to
 * a turn that has already finished.
 *
 * Only files directly under `e2e-tests/tmp/` that look like specs are touched;
 * anything else a user put there is left alone.
 */
export async function sweepTempSpecs(appPath: string): Promise<number> {
  const tempDir = path.join(appPath, ...TEMP_TEST_DIR.split("/"));

  let entries: Dirent[];
  try {
    entries = await fs.readdir(tempDir, { withFileTypes: true });
  } catch {
    return 0;
  }

  let deleted = 0;
  for (const entry of entries) {
    // isFile() is false for a symlink, so a link pointing outside the app is
    // never followed and never unlinked through.
    if (!entry.isFile() || !SPEC_FILE_RE.test(entry.name)) continue;
    try {
      await fs.unlink(path.join(tempDir, entry.name));
      deleted++;
    } catch (error) {
      logger.warn(`Failed to delete temp spec ${entry.name}: ${error}`);
    }
  }

  if (deleted > 0) {
    // Leaves the directory in place if the user put anything else in it.
    await fs.rmdir(tempDir).catch(() => undefined);
    logger.info(`Swept ${deleted} leftover temp spec(s) from ${tempDir}`);
  }
  return deleted;
}
