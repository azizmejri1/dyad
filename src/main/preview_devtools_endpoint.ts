/**
 * Discovery for Chromium's debugging port.
 *
 * Launching with `--remote-debugging-port=0` picks an ephemeral port and writes
 * it, with the browser's WebSocket path, to `DevToolsActivePort` in the user
 * data directory. Asking for a fixed port instead would collide between two
 * running Dyad instances, so the file is the only reliable source.
 */

export interface DevToolsEndpoint {
  port: number;
  browserWsEndpoint: string;
}

/**
 * Parses the two-line DevToolsActivePort file: the port, then the browser's
 * WebSocket path. Returns null for anything malformed — callers treat that as
 * "debugging is not available" rather than crashing the app.
 */
export function parseDevToolsActivePort(
  contents: string,
): DevToolsEndpoint | null {
  const [portLine, pathLine] = contents.split("\n");
  const port = Number.parseInt((portLine ?? "").trim(), 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const path = (pathLine ?? "").trim();
  if (!path.startsWith("/devtools/browser/")) return null;
  return { port, browserWsEndpoint: `ws://127.0.0.1:${port}${path}` };
}

export interface TargetDescription {
  id?: string;
  type?: string;
  url?: string;
}

/**
 * Picks the preview page out of `/json/list`. Dyad's own renderer is in that
 * list too, so matching is by URL rather than by taking the first page.
 */
export function findPreviewTarget(
  targets: readonly TargetDescription[],
  previewUrl: string,
): string | null {
  const normalize = (value: string) => value.replace(/\/+$/, "");
  const wanted = normalize(previewUrl);
  const page = targets.find(
    (target) =>
      target.type === "page" &&
      typeof target.url === "string" &&
      normalize(target.url) === wanted,
  );
  return page?.id ?? null;
}
