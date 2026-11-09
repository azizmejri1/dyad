// A real Neon SDK client wrapped at the transport boundary for live runs:
//
// - journals project/branch creation intent before sending and the returned
//   ID before the caller sees the response, so crashes cannot lose ownership;
// - refuses any mutation of a project the campaign does not own, any create
//   outside the campaign's name prefix, and work past the fence or budgets;
// - draws every request from the shared Management API token bucket;
// - applies transport fault rules; and
// - records credential-free latency/status metrics.
//
// Uses Node's http adapter: happy-dom's XHR drops Authorization headers.
//
// Relative imports only: the supervisor CLI loads this through jiti.
import fs from "node:fs";
import { createApiClient, type Api } from "@neondatabase/api-client";
import type { TokenBucket } from "./budget";
import { parseRetryAfter } from "./budget";
import { CAMPAIGN_LIMITS, type LiveNeonConfig } from "./config";
import {
  crashNow,
  injectedHttpError,
  injectedNetworkError,
  type FaultController,
} from "./faults";
import {
  estimatedActiveEndpoints,
  liveOwnedProjects,
  type CampaignJournal,
  type JournalActor,
} from "./journal";
import { normalizeEndpoint, type MetricsRecorder } from "./metrics";

export class CampaignGuardError extends Error {
  constructor(message: string) {
    super(`[live Neon campaign guard] ${message}`);
    this.name = "CampaignGuardError";
  }
}

export interface LiveClientOptions {
  config: Pick<LiveNeonConfig, "apiKey" | "namePrefix" | "orgId" | "projectId">;
  journal: CampaignJournal;
  actor: JournalActor;
  budget: TokenBucket;
  metrics?: MetricsRecorder;
  faults?: FaultController;
  /** Exists once the supervisor fences new work. */
  fencePath?: string;
  /** Per-profile cap on projects created in this journal (sentinels included). */
  maxProjectsPerCampaign?: number;
  /** Overrides the key (invalid-credential scenarios). Never journaled. */
  apiKey?: string;
  baseURL?: string;
}

interface RequestMeta {
  method: string;
  path: string;
  op: string;
  start: number;
  intentId?: string;
  loseResponse?: boolean;
  injectedRule?: string;
}

const META = "__dyadLiveNeon";

type MutableConfig = {
  method?: string;
  url?: string;
  baseURL?: string;
  data?: unknown;
  [META]?: RequestMeta;
};

function endpointPath(config: MutableConfig): string {
  const url = new URL(
    config.url ?? "",
    config.baseURL ?? "https://console.neon.tech/api/v2/",
  );
  return url.pathname.replace(/^\/api\/v2/, "") || "/";
}

function bodyOf(config: MutableConfig): Record<string, any> | undefined {
  if (typeof config.data === "string") {
    try {
      return JSON.parse(config.data);
    } catch {
      return undefined;
    }
  }
  return (config.data as Record<string, any> | undefined) ?? undefined;
}

const PROJECT_PATH = /^\/projects\/([^/]+)(\/.*)?$/;

export function createJournaledNeonClient(
  options: LiveClientOptions,
): Api<unknown> {
  const { config, journal, actor, budget, metrics, faults, fencePath } =
    options;
  const maxProjects =
    options.maxProjectsPerCampaign ?? CAMPAIGN_LIMITS.maxProjectsPerCampaign;
  const client = createApiClient({
    apiKey: options.apiKey ?? config.apiKey,
    adapter: "http",
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });

  const assertNotFenced = (what: string) => {
    if (fencePath && fs.existsSync(fencePath)) {
      throw new CampaignGuardError(`campaign is fenced; refusing to ${what}`);
    }
  };

  const assertOwnedForMutation = (
    projectId: string,
    method: string,
    rest: string,
  ) => {
    const state = journal.state();
    const baseline = new Set(state.start?.baselineProjectIds ?? []);
    const isProjectDelete = method === "DELETE" && !rest;
    if (config.projectId && projectId === config.projectId) {
      // Project-scoped mode: the pre-created project's branches are fair
      // game, the project itself is not.
      if (isProjectDelete) {
        throw new CampaignGuardError(
          `refusing to delete the configured project ${projectId}`,
        );
      }
      return;
    }
    const owned = state.projects.get(projectId);
    if (!owned || baseline.has(projectId)) {
      throw new CampaignGuardError(
        `refusing ${method} ${rest || "/"} on project ${projectId}: not created by this campaign`,
      );
    }
  };

  client.instance.interceptors.request.use(async (axiosConfig) => {
    const cfg = axiosConfig as unknown as MutableConfig;
    const method = (cfg.method ?? "get").toUpperCase();
    const path = endpointPath(cfg);
    const meta: RequestMeta = {
      method,
      path,
      op: normalizeEndpoint(method, path),
      start: Date.now(),
    };
    cfg[META] = meta;
    const mutating = method !== "GET" && method !== "HEAD";

    if (method === "POST" && path === "/projects") {
      assertNotFenced("create a project");
      const body = bodyOf(cfg);
      const name: unknown = body?.project?.name;
      if (typeof name !== "string" || !name.startsWith(config.namePrefix)) {
        throw new CampaignGuardError(
          `project name must start with the campaign prefix ${config.namePrefix}`,
        );
      }
      const orgId: unknown = body?.project?.org_id;
      if (config.orgId && orgId !== undefined && orgId !== config.orgId) {
        throw new CampaignGuardError(
          "project create targets an unexpected organization",
        );
      }
      const state = journal.state();
      if (
        liveOwnedProjects(state).length >= CAMPAIGN_LIMITS.maxConcurrentProjects
      ) {
        throw new CampaignGuardError(
          `at most ${CAMPAIGN_LIMITS.maxConcurrentProjects} owned projects may exist at once`,
        );
      }
      if (state.projectIntents >= maxProjects) {
        throw new CampaignGuardError(
          `at most ${maxProjects} projects may be created per campaign`,
        );
      }
      meta.intentId = journal.newIntentId();
      journal.append({
        type: "project-create-intent",
        intentId: meta.intentId,
        name,
        orgId: typeof orgId === "string" ? orgId : undefined,
        actor,
      });
    } else if (mutating) {
      const match = PROJECT_PATH.exec(path);
      if (match) {
        const [, projectId, rest = ""] = match;
        assertOwnedForMutation(projectId, method, rest);
        if (method === "POST" && rest === "/branches") {
          assertNotFenced("create a branch");
          const wantsEndpoint = (bodyOf(cfg)?.endpoints?.length ?? 0) > 0;
          if (
            wantsEndpoint &&
            estimatedActiveEndpoints(journal.state()) + 1 >
              CAMPAIGN_LIMITS.maxActiveEndpoints
          ) {
            throw new CampaignGuardError(
              `at most ${CAMPAIGN_LIMITS.maxActiveEndpoints} campaign compute endpoints may run at once`,
            );
          }
        }
      } else if (path !== "/projects") {
        throw new CampaignGuardError(
          `refusing unrecognized mutation ${method} ${path}`,
        );
      }
    }

    const fault = faults?.match("management", method, path);
    if (fault) {
      meta.injectedRule = fault.action.kind;
      switch (fault.action.kind) {
        case "status": {
          const error = injectedHttpError(fault.action.status, fault.action);
          recordFailure(meta, error);
          throw error;
        }
        case "reset-before-send": {
          const error = injectedNetworkError("ECONNRESET", { notSent: true });
          recordFailure(meta, error);
          throw error;
        }
        case "delay": {
          const { ms } = fault.action;
          await new Promise((resolve) => setTimeout(resolve, ms));
          break;
        }
        case "gate":
          await fault.wait();
          break;
        case "lose-response":
          meta.loseResponse = true;
          break;
        case "crash":
          crashNow();
      }
    }

    await budget.take();
    meta.start = Date.now();
    return axiosConfig;
  });

  const recordFailure = (meta: RequestMeta, error: unknown) => {
    const e = error as {
      code?: string;
      notSent?: boolean;
      response?: { status?: number; headers?: Record<string, unknown> };
    };
    const status = e.response?.status;
    if (status === 429) {
      budget.onThrottle(parseRetryAfter(e.response?.headers?.["retry-after"]));
    }
    metrics?.request({
      transport: "management",
      op: meta.op,
      status,
      ok: false,
      ms: Date.now() - meta.start,
      injected: meta.injectedRule,
      networkError: status === undefined ? (e.code ?? "network") : undefined,
    });
    if (meta.intentId) {
      // Never sent, or a definitive 4xx: nothing was created. Otherwise Neon
      // may have created it; reconcile by exact name.
      const definitive =
        e.notSent === true ||
        (status !== undefined && status >= 400 && status < 500);
      journal.append({
        type: "project-create-failed",
        intentId: meta.intentId,
        status,
        ambiguous: !definitive,
        actor,
      });
    }
  };

  client.instance.interceptors.response.use(
    (response) => {
      const cfg = response.config as unknown as MutableConfig;
      const meta = cfg[META];
      if (!meta) return response;
      const data = response.data as Record<string, any> | undefined;
      budget.onSuccess();

      if (meta.loseResponse) {
        // Simulates loss below the SDK: the server committed, but neither the
        // caller nor the journal learns the result. Cleanup must reconcile.
        const error = injectedNetworkError("ECONNRESET", { notSent: false });
        recordFailure(meta, error);
        throw error;
      }

      const match = PROJECT_PATH.exec(meta.path);
      if (
        meta.method === "POST" &&
        meta.path === "/projects" &&
        data?.project?.id
      ) {
        journal.append({
          type: "project-created",
          intentId: meta.intentId,
          projectId: data.project.id,
          name: data.project.name,
          actor,
        });
      } else if (
        match &&
        meta.method === "POST" &&
        match[2] === "/branches" &&
        data?.branch?.id
      ) {
        journal.append({
          type: "branch-created",
          projectId: match[1],
          branchId: data.branch.id,
          name: data.branch.name,
          hasEndpoint: (data.endpoints?.length ?? 0) > 0,
          actor,
        });
      } else if (match && meta.method === "DELETE") {
        const branchMatch = /^\/branches\/([^/]+)$/.exec(match[2] ?? "");
        if (!match[2]) {
          journal.append({
            type: "deleted",
            kind: "project",
            projectId: match[1],
            actor,
            verified: false,
          });
        } else if (branchMatch) {
          journal.append({
            type: "deleted",
            kind: "branch",
            projectId: match[1],
            branchId: branchMatch[1],
            actor,
            verified: false,
          });
        }
      }

      metrics?.request({
        transport: "management",
        op: meta.op,
        status: response.status,
        ok: true,
        ms: Date.now() - meta.start,
        injected: meta.injectedRule,
        requestId: response.headers?.["x-neon-ret-request-id"] as
          | string
          | undefined,
        operationIds: Array.isArray(data?.operations)
          ? data.operations.map((o: { id: string }) => o.id)
          : undefined,
      });
      return response;
    },
    (error) => {
      const cfg = (error as { config?: MutableConfig }).config;
      const meta = cfg?.[META];
      // Errors thrown by the request interceptor were recorded there.
      if (meta && !(error as { isInjectedFault?: boolean }).isInjectedFault) {
        recordFailure(meta, error);
      }
      return Promise.reject(error);
    },
  );

  return client;
}
