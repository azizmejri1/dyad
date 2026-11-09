// Structured, credential-free metrics for live campaigns. Each worker appends
// JSONL to <runDir>/metrics/; the supervisor aggregates them into the report.
//
// Relative imports only: the supervisor CLI loads this through jiti.
import fs from "node:fs";
import path from "node:path";
import type { Redactor, SanitizedError } from "./redact";

export interface RequestSample {
  kind: "request";
  transport: "management" | "sql" | "auth";
  /** Normalized operation, e.g. "POST /projects/{id}/branches". */
  op: string;
  status?: number;
  ok: boolean;
  ms: number;
  injected?: string;
  networkError?: string;
  scenario?: string;
  requestId?: string;
  operationIds?: string[];
}

export interface ScenarioSample {
  kind: "scenario";
  scenario: string;
  outcome: "completed" | "failed" | "cancelled" | "skipped";
  ms: number;
  /** Attempts that failed before the scenario's eventual outcome. */
  firstAttemptFailures?: number;
  error?: SanitizedError;
  detail?: Record<string, unknown>;
}

export interface EventSample {
  kind: "event";
  name: string;
  scenario?: string;
  data: Record<string, unknown>;
}

export type MetricSample = (RequestSample | ScenarioSample | EventSample) & {
  at: string;
  pid: number;
};

export class MetricsRecorder {
  scenario: string | undefined;
  private readonly file: string | undefined;

  constructor(
    runDir: string | undefined,
    phase: string,
    private readonly redact: Redactor,
  ) {
    if (runDir) {
      const dir = path.join(runDir, "metrics");
      fs.mkdirSync(dir, { recursive: true });
      this.file = path.join(dir, `${phase}-${process.pid}.jsonl`);
    }
  }

  private write(sample: RequestSample | ScenarioSample | EventSample): void {
    if (!this.file) return;
    const line = this.redact(
      JSON.stringify({
        ...sample,
        at: new Date().toISOString(),
        pid: process.pid,
      }),
    );
    fs.appendFileSync(this.file, `${line}\n`);
  }

  request(sample: Omit<RequestSample, "kind" | "scenario">): void {
    this.write({ kind: "request", scenario: this.scenario, ...sample });
  }

  scenarioOutcome(sample: Omit<ScenarioSample, "kind">): void {
    this.write({ kind: "scenario", ...sample });
  }

  event(name: string, data: Record<string, unknown>): void {
    this.write({ kind: "event", name, scenario: this.scenario, data });
  }
}

export function readMetrics(runDir: string): MetricSample[] {
  const dir = path.join(runDir, "metrics");
  if (!fs.existsSync(dir)) return [];
  const samples: MetricSample[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of fs
      .readFileSync(path.join(dir, file), "utf8")
      .split("\n")) {
      if (!line.trim()) continue;
      try {
        samples.push(JSON.parse(line) as MetricSample);
      } catch {
        // A worker killed mid-write leaves a torn last line.
      }
    }
  }
  return samples;
}

/** Nearest-rank percentile; `undefined` for no samples. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export interface LatencySummary {
  count: number;
  p50?: number;
  p95?: number;
  /** Exploratory when count < 100. */
  p99?: number;
  max?: number;
  statuses: Record<string, number>;
  injected: number;
}

export function summarizeRequests(
  samples: MetricSample[],
): Record<string, LatencySummary> {
  const groups = new Map<string, Array<RequestSample>>();
  for (const sample of samples) {
    if (sample.kind !== "request") continue;
    const key = `${sample.transport} ${sample.op}`;
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  const out: Record<string, LatencySummary> = {};
  for (const [key, group] of [...groups].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const ms = group.map((s) => s.ms);
    const statuses: Record<string, number> = {};
    for (const s of group) {
      const status =
        s.status !== undefined
          ? String(s.status)
          : (s.networkError ?? "network");
      statuses[status] = (statuses[status] ?? 0) + 1;
    }
    out[key] = {
      count: group.length,
      p50: percentile(ms, 50),
      p95: percentile(ms, 95),
      p99: percentile(ms, 99),
      max: ms.length ? Math.max(...ms) : undefined,
      statuses,
      injected: group.filter((s) => s.injected).length,
    };
  }
  return out;
}

/** Collapses IDs so requests group by endpoint. */
export function normalizeEndpoint(
  method: string,
  endpointPath: string,
): string {
  const collections = new Set([
    "projects",
    "branches",
    "endpoints",
    "operations",
    "databases",
    "roles",
    "organizations",
    "api_keys",
  ]);
  const parts = endpointPath.split("/").filter(Boolean);
  const normalized = parts.map((part, index) =>
    index > 0 && collections.has(parts[index - 1]) ? "{id}" : part,
  );
  return `${method.toUpperCase()} /${normalized.join("/")}`;
}
