import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DYAD_TEST_SCREENSHOT_DIR_NAME } from "./media_path_utils";
import {
  buildUiScreenshotFileName,
  persistTestScreenshot,
  pruneTestScreenshots,
} from "./test_screenshot_store";

const tempDirs: string[] = [];

// A one-pixel PNG is enough: the store copies bytes, it never decodes them.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function makeApp(): string {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "dyad-shot-"));
  tempDirs.push(appPath);
  return appPath;
}

function writeArtifact(appPath: string, relPath: string): string {
  const full = path.join(appPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, PNG_BYTES);
  return full;
}

function screenshotDir(appPath: string): string {
  return path.join(appPath, DYAD_TEST_SCREENSHOT_DIR_NAME);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("buildUiScreenshotFileName", () => {
  it("is flat and unique per chat/message/run/phase", () => {
    const before = buildUiScreenshotFileName({
      chatId: 4,
      messageId: 91,
      seq: 2,
      phase: "before",
    });
    expect(before).toBe("ui-4-91-2-before.png");
    expect(before).not.toContain("/");
    expect(
      buildUiScreenshotFileName({
        chatId: 4,
        messageId: 91,
        seq: 2,
        phase: "after",
      }),
    ).not.toBe(before);
  });
});

describe("persistTestScreenshot", () => {
  it("copies an artifact out of test-results into .dyad/test-screenshot", async () => {
    const appPath = makeApp();
    const sourcePath = writeArtifact(
      appPath,
      path.join("test-results", "cart", "test-finished-1.png"),
    );

    const fileName = await persistTestScreenshot({
      appPath,
      sourcePath,
      fileName: "ui-1-2-1-before.png",
    });

    expect(fileName).toBe("ui-1-2-1-before.png");
    const copied = path.join(screenshotDir(appPath), "ui-1-2-1-before.png");
    expect(fs.readFileSync(copied)).toEqual(PNG_BYTES);
    // The copy is what outlives the run: clearing test-results (as the next
    // Playwright run does) must not affect it.
    fs.rmSync(path.join(appPath, "test-results"), {
      recursive: true,
      force: true,
    });
    expect(fs.existsSync(copied)).toBe(true);
  });

  it("returns null for an artifact outside test-results", async () => {
    const appPath = makeApp();
    const sourcePath = writeArtifact(appPath, path.join("src", "secret.png"));

    expect(
      await persistTestScreenshot({
        appPath,
        sourcePath,
        fileName: "ui-1-2-1-after.png",
      }),
    ).toBeNull();
    expect(fs.existsSync(screenshotDir(appPath))).toBe(false);
  });

  it("returns null when the artifact is missing", async () => {
    const appPath = makeApp();

    expect(
      await persistTestScreenshot({
        appPath,
        sourcePath: path.join(appPath, "test-results", "gone.png"),
        fileName: "ui-1-2-1-after.png",
      }),
    ).toBeNull();
  });

  it("refuses a filename outside the naming convention", async () => {
    const appPath = makeApp();
    const sourcePath = writeArtifact(
      appPath,
      path.join("test-results", "a.png"),
    );

    expect(
      await persistTestScreenshot({
        appPath,
        sourcePath,
        fileName: "../escape.png",
      }),
    ).toBeNull();
  });
});

describe("pruneTestScreenshots", () => {
  it("keeps the newest screenshots and leaves other files alone", async () => {
    const appPath = makeApp();
    const dir = screenshotDir(appPath);
    fs.mkdirSync(dir, { recursive: true });

    // 205 shots, oldest first, plus an unrelated file.
    for (let i = 1; i <= 205; i++) {
      const file = path.join(dir, `ui-1-${i}-1-after.png`);
      fs.writeFileSync(file, PNG_BYTES);
      fs.utimesSync(file, new Date(i * 1000), new Date(i * 1000));
    }
    fs.writeFileSync(path.join(dir, "notes.txt"), "keep me");

    await pruneTestScreenshots(appPath);

    const remaining = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".png"))
      .sort();
    expect(remaining).toHaveLength(200);
    // The five oldest went; the newest stayed.
    expect(remaining).not.toContain("ui-1-1-1-after.png");
    expect(remaining).toContain("ui-1-205-1-after.png");
    expect(fs.existsSync(path.join(dir, "notes.txt"))).toBe(true);
  });

  it("is a no-op when the directory does not exist", async () => {
    await expect(pruneTestScreenshots(makeApp())).resolves.toBeUndefined();
  });
});
