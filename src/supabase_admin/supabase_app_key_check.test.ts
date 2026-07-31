import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPublishableKey } from "./supabase_context";
import {
  buildAppKeyWarning,
  checkAppSupabaseKey,
  resetAppKeyCheckCacheForTesting,
} from "./supabase_app_key_check";

vi.mock("./supabase_context", () => ({ getPublishableKey: vi.fn() }));
vi.mock("electron-log", () => ({
  default: { scope: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn() }) },
}));

const getPublishableKeyMock = vi.mocked(getPublishableKey);

const CURRENT_KEY = "sb_publishable_current";
const LEGACY_KEY = "eyJhbGciOiJIUzI1NiJ9.legacy-anon";

const appDirs: string[] = [];

/** Write an app whose generated Supabase client holds `key`. */
function makeApp(key: string | null): string {
  const appPath = fs.mkdtempSync(path.join(os.tmpdir(), "dyad-key-check-"));
  appDirs.push(appPath);
  if (key !== null) {
    const clientDir = path.join(appPath, "src", "integrations", "supabase");
    fs.mkdirSync(clientDir, { recursive: true });
    fs.writeFileSync(
      path.join(clientDir, "client.ts"),
      `const SUPABASE_URL = "https://proj-1.supabase.co";\nconst SUPABASE_PUBLISHABLE_KEY = "${key}";\n`,
    );
  }
  return appPath;
}

function check(appPath: string) {
  return checkAppSupabaseKey({
    appPath,
    projectId: "proj-1",
    organizationSlug: "org-1",
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  resetAppKeyCheckCacheForTesting();
  getPublishableKeyMock.mockResolvedValue(CURRENT_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of appDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("checkAppSupabaseKey", () => {
  it("stays off the network when the app already holds the current key", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(check(makeApp(CURRENT_KEY))).resolves.toEqual({ kind: "ok" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // The case that makes the comparison alone useless: an app generated before
  // Dyad preferred the new formats differs from today's pick but works fine
  // while the project still accepts legacy keys.
  it("stays quiet when a differing legacy key still authenticates", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );

    await expect(check(makeApp(LEGACY_KEY))).resolves.toEqual({ kind: "ok" });
    expect(buildAppKeyWarning({ kind: "ok" })).toBeUndefined();
  });

  it("reports a legacy key the project has disabled", async () => {
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ message: "Legacy API keys are disabled" }),
          {
            status: 401,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const status = await check(makeApp(LEGACY_KEY));

    expect(status).toEqual({ kind: "legacy-disabled" });
    expect(buildAppKeyWarning(status)).toMatch(/signing in will fail/);
    // Probes the project's own API with the app's key, not the Management API.
    expect(fetchSpy.mock.calls[0][0]).toBe(
      "https://proj-1.supabase.co/auth/v1/settings",
    );
    expect(fetchSpy.mock.calls[0][1]?.headers).toEqual({ apikey: LEGACY_KEY });
  });

  it("distinguishes a key the project doesn't recognize", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ message: "Invalid API key" }), {
            status: 401,
          }),
      ),
    );

    const status = await check(makeApp("sb_publishable_rotated"));

    expect(status).toEqual({ kind: "unknown-key" });
    expect(buildAppKeyWarning(status)).toMatch(/doesn't recognize/);
  });

  // A diagnostic that cries wolf on a network hiccup teaches users to ignore it.
  it("stays quiet when the probe fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    const status = await check(makeApp(LEGACY_KEY));

    expect(status).toEqual({ kind: "unverified" });
    expect(buildAppKeyWarning(status)).toBeUndefined();
  });

  it("stays quiet when the app has no generated client to check", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(check(makeApp(null))).resolves.toEqual({ kind: "unverified" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getPublishableKeyMock).not.toHaveBeenCalled();
  });

  it("stays quiet when the current key can't be fetched", async () => {
    getPublishableKeyMock.mockRejectedValue(new Error("management API down"));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await expect(check(makeApp(LEGACY_KEY))).resolves.toEqual({
      kind: "unverified",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("probes once per project and key, then serves the cached verdict", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ message: "Legacy API keys are disabled" }),
          {
            status: 401,
          },
        ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    // Two apps on the same project sharing the same stale key.
    await check(makeApp(LEGACY_KEY));
    await check(makeApp(LEGACY_KEY));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not cache an inconclusive verdict", async () => {
    const fetchSpy = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);

    const appPath = makeApp(LEGACY_KEY);
    await expect(check(appPath)).resolves.toEqual({ kind: "unverified" });
    await expect(check(appPath)).resolves.toEqual({ kind: "ok" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});
