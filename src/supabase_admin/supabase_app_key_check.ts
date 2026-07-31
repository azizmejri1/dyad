import fs from "node:fs";
import path from "node:path";
import log from "electron-log";

import { IS_TEST_BUILD } from "@/ipc/utils/test_utils";
import { getPublishableKey } from "./supabase_context";

const logger = log.scope("supabase_app_key_check");

/**
 * Where the AI is told to write the generated Supabase client
 * (`src/prompts/supabase_prompt.ts`). The prompt allows "the most appropriate
 * path for the project structure", so a miss here is expected and stays silent
 * rather than guessing at other locations.
 */
const CLIENT_FILE_RELATIVE_PATH = path.join(
  "src",
  "integrations",
  "supabase",
  "client.ts",
);

const PUBLISHABLE_KEY_RE =
  /SUPABASE_PUBLISHABLE_KEY\s*[:=]\s*["'`]([^"'`]+)["'`]/;

/** Public auth config. Gated on the `apikey` header, which is what we're testing. */
const PROBE_PATH = "/auth/v1/settings";
const PROBE_TIMEOUT_MS = 5_000;

export type AppSupabaseKeyStatus =
  /** The app's key is the one we'd pick, or it still authenticates. Nothing to say. */
  | { kind: "ok" }
  /** The app holds a legacy key and the project has legacy keys turned off. */
  | { kind: "legacy-disabled" }
  /** The project doesn't recognize the app's key at all (rotated, wrong project, hand-edited). */
  | { kind: "unknown-key" }
  /** Couldn't determine anything — no client file, unreadable key, network failure. */
  | { kind: "unverified" };

// Whether a given key still works is a property of the project, not the app, so
// cache on (project, key): several apps sharing a project and a stale key cost
// one probe between them. Process-lifetime only — flipping the legacy switch in
// Supabase mid-session won't be noticed until Dyad restarts.
const probeCache = new Map<string, AppSupabaseKeyStatus>();

/** Read the publishable key the generated app actually authenticates with. */
function readAppKey(appPath: string): string | undefined {
  try {
    const contents = fs.readFileSync(
      path.join(appPath, CLIENT_FILE_RELATIVE_PATH),
      "utf8",
    );
    return PUBLISHABLE_KEY_RE.exec(contents)?.[1];
  } catch {
    // No client file (or an unreadable one) is normal — the app may not use
    // Supabase auth, or may keep its client somewhere else.
    return undefined;
  }
}

/**
 * Ask the project whether a key still authenticates.
 *
 * The Management API lists disabled legacy keys exactly like enabled ones and
 * exposes no enabled/disabled flag, so the only way to tell a working legacy key
 * from a disabled one is to present it and see what comes back.
 */
async function probeKey({
  projectUrl,
  key,
}: {
  projectUrl: string;
  key: string;
}): Promise<AppSupabaseKeyStatus> {
  try {
    const response = await fetch(`${projectUrl}${PROBE_PATH}`, {
      method: "GET",
      headers: { apikey: key },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      return { kind: "ok" };
    }
    if (response.status === 401) {
      const detail = await response.text().catch(() => "");
      return /legacy api keys/i.test(detail)
        ? { kind: "legacy-disabled" }
        : { kind: "unknown-key" };
    }
    // Any other status says something about the endpoint, not the key.
    return { kind: "unverified" };
  } catch (error) {
    logger.warn(`Could not verify the app's Supabase key: ${error}`);
    return { kind: "unverified" };
  }
}

/**
 * Determine whether the Supabase key baked into an app's generated client still
 * works.
 *
 * The key is written into the app's source once, at generation time, and never
 * refreshed — so it can outlive the key it names. Comparing it against the key
 * Dyad would pick today is nearly free but can't stand alone: an app generated
 * before Dyad preferred the new key formats differs from today's pick while
 * still working perfectly, as long as the project keeps legacy keys enabled.
 * Only a probe separates "out of date" from "broken".
 *
 * Never throws, and reports `unverified` rather than guessing — a diagnostic
 * that cries wolf on a network hiccup teaches users to ignore it.
 */
export async function checkAppSupabaseKey({
  appPath,
  projectId,
  organizationSlug,
}: {
  appPath: string;
  projectId: string;
  organizationSlug: string | null;
}): Promise<AppSupabaseKeyStatus> {
  if (IS_TEST_BUILD) {
    return { kind: "ok" };
  }

  const appKey = readAppKey(appPath);
  if (!appKey) {
    return { kind: "unverified" };
  }

  const cacheKey = `${projectId}:${appKey}`;
  const cached = probeCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  let currentKey: string;
  try {
    currentKey = await getPublishableKey({ projectId, organizationSlug });
  } catch (error) {
    logger.warn(`Could not fetch the current publishable key: ${error}`);
    return { kind: "unverified" };
  }

  // Fast path: the app already holds the key we'd write today. Anything
  // generated after Dyad started preferring the new formats lands here and
  // never reaches the network.
  const status: AppSupabaseKeyStatus =
    appKey === currentKey
      ? { kind: "ok" }
      : await probeKey({
          projectUrl: `https://${projectId}.supabase.co`,
          key: appKey,
        });

  // Don't cache an inconclusive result — the next run should try again.
  if (status.kind !== "unverified") {
    probeCache.set(cacheKey, status);
  }
  return status;
}

/** User-facing warning for a key that no longer works, or undefined when it does. */
export function buildAppKeyWarning(
  status: AppSupabaseKeyStatus,
): string | undefined {
  switch (status.kind) {
    case "legacy-disabled":
      return "This app's Supabase client uses a legacy API key that the project has disabled, so signing in will fail. Replace SUPABASE_PUBLISHABLE_KEY in src/integrations/supabase/client.ts with the project's sb_publishable_… key.";
    case "unknown-key":
      return "This app's Supabase client uses a key the project doesn't recognize, so signing in will fail. It may have been rotated, or the app may be pointed at a different project. Replace SUPABASE_PUBLISHABLE_KEY in src/integrations/supabase/client.ts with the project's sb_publishable_… key.";
    default:
      return undefined;
  }
}

/** Test-only: the probe cache lives for the process lifetime. */
export function resetAppKeyCheckCacheForTesting(): void {
  probeCache.clear();
}
