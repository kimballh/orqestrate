import type { IncomingMessage, ServerResponse } from "node:http";

import {
  AGENT_PROVIDERS,
  PROMPT_ATTACHMENT_KINDS,
  PROMPT_SOURCE_KINDS,
  RUN_STATUSES,
  WORK_PHASES,
  type AgentProvider,
  type RunStatus,
  type WorkPhase,
} from "../../domain-model.js";
import type { HumanInput } from "../provider-adapter.js";
import { RuntimeDaemon } from "../daemon.js";
import { RuntimeError } from "../errors.js";
import { waitForEvents, writeSseEvent } from "./event-stream.js";
import { toHttpErrorResponse } from "./errors.js";
import {
  serializeActionRunResponse,
  serializeCreateRunResponse,
  serializeEventsResponse,
  serializeGetRunResponse,
  serializeListRunsResponse,
} from "./serializers.js";
import type {
  ListRunEventsQuery,
  ListRunsQuery,
  RuntimeApiRequestBody,
} from "./types.js";

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "canceled",
  "stale",
]);

export class RuntimeApiRouter {
  constructor(
    private readonly daemon: RuntimeDaemon,
    private readonly getTransportReady: () => boolean,
  ) {}

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", "http://runtime.local");
      const pathSegments = url.pathname.split("/").filter(Boolean);

      if (pathSegments[0] !== "v1") {
        this.writeNotFound(response);
        return;
      }

      if (request.method === "GET" && pathSegments.length === 2) {
        if (pathSegments[1] === "health") {
          this.writeJson(
            response,
            200,
            this.daemon.getReadinessSnapshot({
              transportReady: this.getTransportReady(),
            }),
          );
          return;
        }

        if (pathSegments[1] === "capacity") {
          this.writeJson(response, 200, this.daemon.getCapacitySnapshot());
          return;
        }
      }

      if (pathSegments[1] !== "runs") {
        this.writeNotFound(response);
        return;
      }

      if (request.method === "POST" && pathSegments.length === 2) {
        await this.handleCreateRun(request, response);
        return;
      }

      if (request.method === "GET" && pathSegments.length === 2) {
        this.handleListRuns(url, response);
        return;
      }

      const runId = pathSegments[2];
      if (runId === undefined) {
        this.writeNotFound(response);
        return;
      }

      if (request.method === "GET" && pathSegments.length === 3) {
        this.handleGetRun(runId, response);
        return;
      }

      if (request.method === "GET" && pathSegments[3] === "events") {
        await this.handleListRunEvents(runId, url, response);
        return;
      }

      if (request.method === "GET" && pathSegments[3] === "stream") {
        await this.handleStreamRunEvents(request, response, runId, url);
        return;
      }

      if (
        request.method === "POST" &&
        pathSegments[3] === "actions" &&
        pathSegments[4] === "interrupt"
      ) {
        await this.handleInterruptRun(runId, response);
        return;
      }

      if (
        request.method === "POST" &&
        pathSegments[3] === "actions" &&
        pathSegments[4] === "cancel"
      ) {
        await this.handleCancelRun(request, runId, response);
        return;
      }

      if (
        request.method === "POST" &&
        pathSegments[3] === "actions" &&
        pathSegments[4] === "human-input"
      ) {
        await this.handleHumanInput(request, runId, response);
        return;
      }

      this.writeNotFound(response);
    } catch (error) {
      if (
        response.headersSent ||
        response.writableEnded ||
        response.destroyed
      ) {
        if (response.writableEnded === false && response.destroyed === false) {
          response.end();
        }

        return;
      }

      const httpError = toHttpErrorResponse(error);
      this.writeJson(response, httpError.status, httpError.body);
    }
  }

  private async handleCreateRun(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const body = await this.readJsonBody(request);
    assertObjectBody(body);
    const payload = parseCreateRunBody(body);
    const existing = this.daemon.getRun(payload.runId);
    const run = this.daemon.enqueueRun(payload);

    this.writeJson(
      response,
      existing === null ? 201 : 200,
      serializeCreateRunResponse({
        created: existing === null,
        run,
        lastEventSeq: this.daemon.getRunLastEventSeq(run.runId),
      }),
    );
  }

  private handleGetRun(runId: string, response: ServerResponse): void {
    const run = this.requireRun(runId);

    this.writeJson(
      response,
      200,
      serializeGetRunResponse({
        run,
        lastEventSeq: this.daemon.getRunLastEventSeq(run.runId),
      }),
    );
  }

  private handleListRuns(url: URL, response: ServerResponse): void {
    const query = parseListRunsQuery(url);
    const page = this.daemon.listRunsPage(query);

    this.writeJson(
      response,
      200,
      serializeListRunsResponse({
        runs: page.runs.map((run) => ({
          run,
          lastEventSeq: this.daemon.getRunLastEventSeq(run.runId),
        })),
        nextCursor: page.nextCursor,
      }),
    );
  }

  private async handleListRunEvents(
    runId: string,
    url: URL,
    response: ServerResponse,
  ): Promise<void> {
    this.requireRun(runId);
    const query = parseListRunEventsQuery(url);
    const events = await waitForEvents({
      daemon: this.daemon,
      runId,
      afterSeq: query.after,
      limit: query.limit,
      waitMs: query.waitMs,
    });

    this.writeJson(response, 200, serializeEventsResponse(events));
  }

  private async handleStreamRunEvents(
    request: IncomingMessage,
    response: ServerResponse,
    runId: string,
    url: URL,
  ): Promise<void> {
    this.requireRun(runId);

    const query = parseListRunEventsQuery(url);
    const lastEventId = request.headers["last-event-id"];
    let cursor =
      typeof lastEventId === "string" && lastEventId.length > 0
        ? parseInteger(lastEventId, "Last-Event-ID")
        : query.after;
    let closed = false;

    request.on("close", () => {
      closed = true;
    });
    response.on("close", () => {
      closed = true;
    });

    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    response.flushHeaders();
    response.write(": connected\n\n");

    while (closed === false) {
      const events = await waitForEvents({
        daemon: this.daemon,
        runId,
        afterSeq: cursor,
        limit: query.limit ?? 100,
        waitMs: query.waitMs ?? 1_000,
        shouldStop: () => closed,
      });

      if (closed) {
        break;
      }

      if (events.length === 0) {
        if (response.destroyed || response.writableEnded) {
          break;
        }

        response.write(": keep-alive\n\n");
        continue;
      }

      for (const event of events) {
        if (response.destroyed || response.writableEnded) {
          closed = true;
          break;
        }

        writeSseEvent(response, event);
        cursor = event.seq;
      }
    }

    if (response.writableEnded === false && response.destroyed === false) {
      response.end();
    }
  }

  private async handleInterruptRun(
    runId: string,
    response: ServerResponse,
  ): Promise<void> {
    this.requireRun(runId);
    const accepted = this.daemon.canInterruptRun(runId);
    const run = await this.daemon.interruptRun(runId);

    this.writeJson(
      response,
      202,
      serializeActionRunResponse({
        accepted,
        run,
        lastEventSeq: this.daemon.getRunLastEventSeq(run.runId),
      }),
    );
  }

  private async handleCancelRun(
    request: IncomingMessage,
    runId: string,
    response: ServerResponse,
  ): Promise<void> {
    const before = this.requireRun(runId);
    const body = await this.readJsonBody(request);
    assertObjectBody(body);
    const reason = requireString(body.reason, "reason");
    const requestedBy = optionalString(body.requestedBy, "requestedBy");
    const run = await this.daemon.cancelRun(runId, reason, requestedBy);

    this.writeJson(
      response,
      202,
      serializeActionRunResponse({
        accepted: TERMINAL_STATUSES.has(before.status) === false,
        run,
        lastEventSeq: this.daemon.getRunLastEventSeq(run.runId),
      }),
    );
  }

  private async handleHumanInput(
    request: IncomingMessage,
    runId: string,
    response: ServerResponse,
  ): Promise<void> {
    this.requireRun(runId);
    const body = await this.readJsonBody(request);
    assertObjectBody(body);
    const input = parseHumanInputBody(body);
    const run = await this.daemon.submitHumanInput(runId, input);

    this.writeJson(
      response,
      202,
      serializeActionRunResponse({
        accepted: true,
        run,
        lastEventSeq: this.daemon.getRunLastEventSeq(run.runId),
      }),
    );
  }

  private async readJsonBody(
    request: IncomingMessage,
  ): Promise<RuntimeApiRequestBody> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    if (chunks.length === 0) {
      return null;
    }

    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as RuntimeApiRequestBody;
  }

  private requireRun(runId: string) {
    const run = this.daemon.getRun(runId);

    if (run === null) {
      throw new RuntimeError(`Run '${runId}' was not found.`, {
        code: "run_not_found",
      });
    }

    return run;
  }

  private writeNotFound(response: ServerResponse): void {
    this.writeJson(response, 404, {
      error: {
        code: "not_found",
        message: "Runtime API route was not found.",
      },
    });
  }

  private writeJson(
    response: ServerResponse,
    status: number,
    body: unknown,
  ): void {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
    });
    response.end(JSON.stringify(body));
  }
}

function parseCreateRunBody(body: Record<string, unknown>) {
  const runId = requireString(body.runId, "runId");

  return {
    runId,
    phase: requireOneOf(body.phase, WORK_PHASES, "phase"),
    provider: requireOneOf(body.provider, AGENT_PROVIDERS, "provider"),
    workItem: requireWorkItem(body.workItem),
    workspace: requireWorkspace(body.workspace),
    prompt: requirePrompt(body.prompt),
    grantedCapabilities:
      body.grantedCapabilities === undefined
        ? []
        : requireStringArray(body.grantedCapabilities, "grantedCapabilities"),
    limits: requireLimits(body.limits),
    requestedBy: optionalString(body.requestedBy, "requestedBy"),
    artifact: optionalArtifact(body.artifact),
  };
}

function parseHumanInputBody(body: Record<string, unknown>): HumanInput {
  return {
    kind: requireOneOf(
      body.kind,
      ["answer", "approval", "choice", "note"] as const,
      "kind",
    ),
    message: requireString(body.message, "message"),
    author: optionalString(body.author, "author"),
  };
}

function parseListRunsQuery(url: URL): ListRunsQuery {
  return {
    status: optionalOneOf(url.searchParams.get("status"), RUN_STATUSES, "status"),
    provider: optionalOneOf(
      url.searchParams.get("provider"),
      AGENT_PROVIDERS,
      "provider",
    ),
    workItemId: url.searchParams.get("workItemId") ?? undefined,
    phase: optionalOneOf(url.searchParams.get("phase"), WORK_PHASES, "phase"),
    repoRoot: url.searchParams.get("repoRoot") ?? undefined,
    limit: optionalInteger(url.searchParams.get("limit"), "limit"),
    cursor: url.searchParams.get("cursor") ?? undefined,
  };
}

function parseListRunEventsQuery(url: URL): ListRunEventsQuery {
  return {
    after: optionalInteger(url.searchParams.get("after"), "after"),
    limit: optionalInteger(url.searchParams.get("limit"), "limit"),
    waitMs: optionalInteger(url.searchParams.get("waitMs"), "waitMs"),
  };
}

function requireWorkItem(value: unknown) {
  assertPlainObject(value, "workItem");

  return {
    id: requireString(value.id, "workItem.id"),
    identifier: optionalString(value.identifier, "workItem.identifier"),
    title: requireString(value.title, "workItem.title"),
    description: optionalString(value.description, "workItem.description"),
    labels: requireStringArray(value.labels, "workItem.labels"),
    url: optionalString(value.url, "workItem.url"),
  };
}

function requireWorkspace(value: unknown) {
  assertPlainObject(value, "workspace");

  return {
    repoRoot: requireString(value.repoRoot, "workspace.repoRoot"),
    mode: requireOneOf(
      value.mode,
      ["shared_readonly", "ephemeral_worktree"] as const,
      "workspace.mode",
    ),
    workingDirHint: optionalString(
      value.workingDirHint,
      "workspace.workingDirHint",
    ),
    baseRef: optionalString(value.baseRef, "workspace.baseRef"),
    assignedBranch: optionalString(
      value.assignedBranch,
      "workspace.assignedBranch",
    ),
    pullRequestUrl: optionalString(
      value.pullRequestUrl,
      "workspace.pullRequestUrl",
    ),
    pullRequestMode: optionalString(
      value.pullRequestMode,
      "workspace.pullRequestMode",
    ),
    writeScope: optionalString(value.writeScope, "workspace.writeScope"),
  };
}

function requirePrompt(value: unknown) {
  assertPlainObject(value, "prompt");
  const digests = value.digests;
  assertPlainObject(digests, "prompt.digests");

  return {
    contractId: requireString(value.contractId, "prompt.contractId"),
    userPrompt: requireString(value.userPrompt, "prompt.userPrompt"),
    attachments: requirePromptAttachments(
      value.attachments,
      "prompt.attachments",
    ),
    sources: requirePromptSources(value.sources, "prompt.sources"),
    digests: {
      system: optionalString(digests.system, "prompt.digests.system"),
      user: requireString(digests.user, "prompt.digests.user"),
    },
  };
}

function requireLimits(value: unknown) {
  assertPlainObject(value, "limits");

  return {
    maxWallTimeSec: requireNumber(value.maxWallTimeSec, "limits.maxWallTimeSec"),
    idleTimeoutSec: requireNumber(value.idleTimeoutSec, "limits.idleTimeoutSec"),
    bootstrapTimeoutSec: requireNumber(
      value.bootstrapTimeoutSec,
      "limits.bootstrapTimeoutSec",
    ),
  };
}

function optionalArtifact(value: unknown) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  assertPlainObject(value, "artifact");
  return {
    artifactId: requireString(value.artifactId, "artifact.artifactId"),
    url: requireString(value.url, "artifact.url"),
    summary: optionalString(value.summary, "artifact.summary"),
  };
}

function assertObjectBody(value: RuntimeApiRequestBody): asserts value is Record<
  string,
  unknown
> {
  if (value === null) {
    throw new RuntimeError("Request body is required.", {
      code: "invalid_request",
    });
  }
}

function assertPlainObject(
  value: unknown,
  fieldName: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw new RuntimeError(`'${fieldName}' must be an object.`, {
      code: "invalid_request",
    });
  }
}

function requireString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RuntimeError(`'${fieldName}' must be a non-empty string.`, {
      code: "invalid_request",
    });
  }

  return value;
}

function optionalString(
  value: unknown,
  fieldName: string,
): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  return requireString(value, fieldName);
}

function requireNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || Number.isFinite(value) === false) {
    throw new RuntimeError(`'${fieldName}' must be a number.`, {
      code: "invalid_request",
    });
  }

  return value;
}

function parseInteger(value: string, fieldName: string): number {
  const parsed = Number.parseInt(value, 10);

  if (Number.isFinite(parsed) === false) {
    throw new RuntimeError(`'${fieldName}' must be an integer.`, {
      code: "invalid_request",
    });
  }

  return parsed;
}

function optionalInteger(
  value: string | null,
  fieldName: string,
): number | undefined {
  if (value === null) {
    return undefined;
  }

  return parseInteger(value, fieldName);
}

function requireStringArray(value: unknown, fieldName: string): string[] {
  if (Array.isArray(value) === false || value.some((item) => typeof item !== "string")) {
    throw new RuntimeError(`'${fieldName}' must be a string array.`, {
      code: "invalid_request",
    });
  }

  return value;
}

function requireUnknownArray(value: unknown, fieldName: string): unknown[] {
  if (Array.isArray(value) === false) {
    throw new RuntimeError(`'${fieldName}' must be an array.`, {
      code: "invalid_request",
    });
  }

  return value;
}

function requirePromptAttachments(value: unknown, fieldName: string) {
  return requireUnknownArray(value, fieldName).map((item, index) => {
    assertPlainObject(item, `${fieldName}[${index}]`);

    return {
      kind: requireOneOf(
        item.kind,
        PROMPT_ATTACHMENT_KINDS,
        `${fieldName}[${index}].kind`,
      ),
      value: requireString(item.value, `${fieldName}[${index}].value`),
      label: optionalString(item.label, `${fieldName}[${index}].label`),
    };
  });
}

function requirePromptSources(value: unknown, fieldName: string) {
  return requireUnknownArray(value, fieldName).map((item, index) => {
    assertPlainObject(item, `${fieldName}[${index}]`);

    return {
      kind: requireOneOf(
        item.kind,
        PROMPT_SOURCE_KINDS,
        `${fieldName}[${index}].kind`,
      ),
      ref: requireString(item.ref, `${fieldName}[${index}].ref`),
    };
  });
}

function requireOneOf<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  fieldName: string,
): T[number] {
  if (typeof value !== "string" || allowed.includes(value) === false) {
    throw new RuntimeError(
      `'${fieldName}' must be one of: ${allowed.join(", ")}.`,
      {
        code: "invalid_request",
      },
    );
  }

  return value as T[number];
}

function optionalOneOf<const T extends readonly string[]>(
  value: string | null,
  allowed: T,
  fieldName: string,
): T[number] | undefined {
  if (value === null) {
    return undefined;
  }

  return requireOneOf(value, allowed, fieldName);
}
