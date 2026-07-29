import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isTempSpecPath, TEMP_TEST_DIR } from "../types/tests";
import { sweepTempSpecs } from "./temp_specs";

const tempDirs: string[] = [];

function makeApp(): string {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "dyad-tmpspec-"));
  tempDirs.push(appPath);
  return appPath;
}

function tempSpecDir(appPath: string): string {
  return path.join(appPath, ...TEMP_TEST_DIR.split("/"));
}

function write(appPath: string, relPath: string, body = "test('x', () => {})") {
  const full = path.join(appPath, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
  return full;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("isTempSpecPath", () => {
  it("matches only specs under the throwaway directory", () => {
    expect(isTempSpecPath("e2e-tests/tmp/cart.spec.ts")).toBe(true);
    expect(isTempSpecPath("e2e-tests\\tmp\\cart.spec.ts")).toBe(true);
    expect(isTempSpecPath("e2e-tests/cart.spec.ts")).toBe(false);
    // A sibling directory must not be swept up by a prefix match.
    expect(isTempSpecPath("e2e-tests/tmpfoo/cart.spec.ts")).toBe(false);
  });
});

describe("sweepTempSpecs", () => {
  it("deletes leftover temp specs and leaves the real suite alone", async () => {
    const appPath = makeApp();
    write(appPath, "e2e-tests/tmp/cart.spec.ts");
    write(appPath, "e2e-tests/tmp/checkout.spec.ts");
    write(appPath, "e2e-tests/signup.spec.ts");

    expect(await sweepTempSpecs(appPath)).toBe(2);

    expect(fs.existsSync(tempSpecDir(appPath))).toBe(false);
    expect(fs.existsSync(path.join(appPath, "e2e-tests/signup.spec.ts"))).toBe(
      true,
    );
  });

  it("leaves non-spec files (and the directory) in place", async () => {
    const appPath = makeApp();
    write(appPath, "e2e-tests/tmp/cart.spec.ts");
    write(appPath, "e2e-tests/tmp/notes.md", "mine");

    expect(await sweepTempSpecs(appPath)).toBe(1);

    expect(fs.existsSync(path.join(tempSpecDir(appPath), "notes.md"))).toBe(
      true,
    );
  });

  it("does not unlink through a symlink", async () => {
    const appPath = makeApp();
    const outside = write(appPath, "e2e-tests/keep.spec.ts");
    fs.mkdirSync(tempSpecDir(appPath), { recursive: true });
    fs.symlinkSync(outside, path.join(tempSpecDir(appPath), "link.spec.ts"));

    expect(await sweepTempSpecs(appPath)).toBe(0);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it("is a no-op when there is no temp directory", async () => {
    expect(await sweepTempSpecs(makeApp())).toBe(0);
  });
});
