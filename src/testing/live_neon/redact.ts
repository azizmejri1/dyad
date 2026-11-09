// Keeps credentials out of live-campaign logs, journals, metrics and reports.
//
// Relative imports only: the supervisor CLI loads this through jiti.
import fs from "node:fs";
import path from "node:path";

const REDACTED = "[REDACTED]";

/**
 * Shape-based patterns for secrets that are not known up front: database
 * passwords Neon mints per branch, Auth session tokens, and so on.
 */
const SECRET_PATTERNS: Array<{
  name: string;
  pattern: RegExp;
  replace: string;
}> = [
  {
    // postgres://role:password@host -> keep role and host for diagnosis.
    name: "connection-password",
    pattern: /(postgres(?:ql)?:\/\/[^:/@\s]+:)[^@\s]+(@)/gi,
    replace: `$1${REDACTED}$2`,
  },
  {
    name: "neon-api-key",
    pattern: /\bnapi_[A-Za-z0-9]{16,}\b/g,
    replace: REDACTED,
  },
  {
    name: "neon-password",
    pattern: /\bnpg_[A-Za-z0-9]{8,}\b/g,
    replace: REDACTED,
  },
  {
    name: "bearer-token",
    pattern: /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: `$1${REDACTED}`,
  },
  {
    name: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: REDACTED,
  },
  {
    // Better Auth (Neon Auth) and generic session cookies.
    name: "session-cookie",
    pattern:
      /((?:__Secure-)?[A-Za-z0-9_.-]*session[A-Za-z0-9_.-]*=)[^;\s"']+/gi,
    replace: `$1${REDACTED}`,
  },
  {
    name: "json-secret-field",
    pattern:
      /("(?:password|secret_server_key|pub_client_key|cookie_secret|access_token|refresh_token|api_key|apiKey|token)"\s*:\s*")[^"]*(")/gi,
    replace: `$1${REDACTED}$2`,
  },
  {
    name: "env-secret",
    pattern:
      /^((?:DATABASE_URL|DATABASE_URL_UNPOOLED|NEON_AUTH_COOKIE_SECRET|[A-Z_]*SECRET[A-Z_]*|[A-Z_]*PASSWORD[A-Z_]*)=).+$/gm,
    replace: `$1${REDACTED}`,
  },
];

export type Redactor = (text: string) => string;

export function createRedactor(
  knownSecrets: Array<string | undefined>,
): Redactor {
  // Longest first so a secret containing another is replaced whole.
  const secrets = [
    ...new Set(knownSecrets.filter((s): s is string => !!s && s.length >= 6)),
  ].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let out = text;
    for (const secret of secrets) {
      out = out.split(secret).join(REDACTED);
    }
    for (const { pattern, replace } of SECRET_PATTERNS) {
      out = out.replace(pattern, replace);
    }
    return out;
  };
}

/** Deep-redacts a JSON-serializable value. */
export function redactValue<T>(value: T, redact: Redactor): T {
  return JSON.parse(redact(JSON.stringify(value ?? null))) as T;
}

export interface SanitizedError {
  name: string;
  message: string;
  status?: number;
  code?: string;
  providerCode?: string;
  requestId?: string;
  injected?: boolean;
}

/**
 * Projects an error to a credential-free summary. SDK (axios) errors carry the
 * request config, including the Authorization header and request body, so
 * never serialize them directly.
 */
export function sanitizeError(
  error: unknown,
  redact: Redactor,
): SanitizedError {
  const e = error as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    isInjectedFault?: unknown;
    response?: {
      status?: unknown;
      data?: { code?: unknown; message?: unknown; request_id?: unknown };
      headers?: Record<string, unknown>;
    };
  } | null;
  const status = e?.response?.status;
  const providerCode = e?.response?.data?.code;
  const requestId =
    e?.response?.data?.request_id ??
    e?.response?.headers?.["x-neon-ret-request-id"];
  const providerMessage = e?.response?.data?.message;
  const baseMessage =
    typeof providerMessage === "string"
      ? providerMessage
      : typeof e?.message === "string"
        ? e.message
        : String(error);
  return {
    name: typeof e?.name === "string" ? e.name : "Error",
    message: redact(baseMessage).slice(0, 2000),
    ...(typeof status === "number" ? { status } : {}),
    ...(typeof e?.code === "string" ? { code: e.code } : {}),
    ...(typeof providerCode === "string" ? { providerCode } : {}),
    ...(typeof requestId === "string" ? { requestId } : {}),
    ...(e?.isInjectedFault === true ? { injected: true } : {}),
  };
}

export interface SecretFinding {
  file: string;
  /** Which detector matched; never the matched text itself. */
  detector: string;
  line: number;
}

const SCANNABLE_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".md",
  ".txt",
  ".log",
  ".html",
  ".xml",
  ".sql",
  "",
]);

/**
 * Scans retained artifacts for credentials before they are shared. Reports
 * the file, line and detector, never the secret. Binary artifacts such as
 * screenshots and traces cannot be scanned and are listed separately so they
 * are reviewed or deleted rather than silently trusted.
 */
export function scanForSecrets(
  root: string,
  knownSecrets: Array<string | undefined>,
): { findings: SecretFinding[]; unscannable: string[] } {
  const findings: SecretFinding[] = [];
  const unscannable: string[] = [];
  const secrets = knownSecrets.filter((s): s is string => !!s && s.length >= 6);
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!SCANNABLE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        unscannable.push(path.relative(root, full));
        continue;
      }
      const lines = fs.readFileSync(full, "utf8").split(/\r?\n/);
      lines.forEach((text, index) => {
        if (secrets.some((secret) => text.includes(secret))) {
          findings.push({
            file: path.relative(root, full),
            detector: "known-secret",
            line: index + 1,
          });
        }
        for (const { name, pattern } of SECRET_PATTERNS) {
          pattern.lastIndex = 0;
          const match = pattern.exec(text);
          pattern.lastIndex = 0;
          // A pattern whose replacement keeps a prefix still "matches" its own
          // redacted output; only report unredacted values.
          if (match && !match[0].includes(REDACTED)) {
            findings.push({
              file: path.relative(root, full),
              detector: name,
              line: index + 1,
            });
          }
        }
      });
    }
  };
  if (fs.existsSync(root)) visit(root);
  return { findings, unscannable };
}
