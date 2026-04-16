import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import type { CreateRunInput, PersistedRunRecord } from "./types.js";
import type { RuntimeConfig } from "./config.js";
import {
  buildRuntimeProviderError,
  type HumanInput,
  type OutputEvent,
  type ProviderAdapter,
  type RunOutcome,
  type RuntimeSessionController,
  type RuntimeSignal,
} from "./provider-adapter.js";
import type {
  LaunchSpec,
  SessionExit,
  SessionObserver,
  SessionSnapshot,
  SessionSupervisor,
} from "./session-supervisor.js";

export type RuntimeFixture = {
  rootDir: string;
  runtimeConfig: RuntimeConfig;
};

export class FakeSessionSupervisor implements SessionSupervisor {
  private readonly sessions = new Map<
    string,
    {
      runId: string;
      observer: SessionObserver;
      recentOutput: string;
      bytesRead: number;
      bytesWritten: number;
      startedAt: string;
      isAlive: boolean;
      exit: SessionExit | null;
    }
  >();

  async launch(
    _spec: LaunchSpec,
    observer: SessionObserver,
  ): Promise<{ sessionId: string; pid: number; runId: string }> {
    const sessionId = `session-${this.sessions.size + 1}`;
    this.sessions.set(sessionId, {
      runId: observer.runId,
      observer,
      recentOutput: "",
      bytesRead: 0,
      bytesWritten: 0,
      startedAt: "2026-04-14T18:00:00.000Z",
      isAlive: true,
      exit: null,
    });

    return {
      sessionId,
      pid: 4242 + this.sessions.size,
      runId: observer.runId,
    };
  }

  async write(sessionId: string, input: string): Promise<void> {
    const session = this.requireSession(sessionId);
    session.bytesWritten += Buffer.byteLength(input);
  }

  async interrupt(_sessionId: string): Promise<void> {}

  async terminate(sessionId: string): Promise<void> {
    this.emitExit(sessionId, 130, "SIGTERM");
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const session = this.requireSession(sessionId);

    return {
      sessionId,
      runId: session.runId,
      pid: 4242,
      recentOutput: session.recentOutput,
      bytesRead: session.bytesRead,
      bytesWritten: session.bytesWritten,
      isAlive: session.isAlive,
      startedAt: session.startedAt,
      lastOutputAt: session.exit?.occurredAt ?? null,
      lastInputAt: null,
    };
  }

  async readRecentOutput(sessionId: string, maxChars: number): Promise<string> {
    const session = this.requireSession(sessionId);
    return session.recentOutput.slice(Math.max(0, session.recentOutput.length - maxChars));
  }

  emitOutput(sessionId: string, chunk: string): void {
    const session = this.requireSession(sessionId);
    session.recentOutput += chunk;
    session.bytesRead += Buffer.byteLength(chunk);
    void session.observer.onOutput({
      sessionId,
      occurredAt: "2026-04-14T18:00:01.000Z",
      chunk,
    });
  }

  emitExit(
    sessionId: string,
    exitCode: number | null,
    signal: string | null,
  ): void {
    const session = this.requireSession(sessionId);

    if (!session.isAlive) {
      return;
    }

    session.isAlive = false;
    session.exit = {
      sessionId,
      occurredAt: "2026-04-14T18:00:02.000Z",
      exitCode,
      signal,
    };
    void session.observer.onExit(session.exit);
  }

  private requireSession(sessionId: string) {
    const session = this.sessions.get(sessionId);

    assert.ok(session);
    return session;
  }
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly kind = "codex" as const;
  humanInputCalls = 0;

  constructor(
    private readonly options: {
      failHumanInput?: boolean;
    } = {},
  ) {}

  buildLaunchSpec(input: { cwd: string }): LaunchSpec {
    return {
      command: "fake-agent",
      args: [],
      env: {},
      cwd: input.cwd,
    };
  }

  detectReady(snapshot: SessionSnapshot): boolean {
    return snapshot.recentOutput.includes("READY");
  }

  classifyOutput(event: OutputEvent): RuntimeSignal[] {
    const signals: RuntimeSignal[] = [];

    if (event.chunk.includes("READY")) {
      signals.push({
        type: "ready",
        payload: {
          source: "fake-output",
        },
      });
    }

    if (event.chunk.includes("PROGRESS")) {
      signals.push({
        type: "progress",
        eventType: "progress_update",
        payload: {
          chunk: event.chunk.trim(),
        },
      });
    }

    if (event.chunk.includes("NEEDS_HUMAN")) {
      signals.push({
        type: "waiting_human",
        reason: "Need an operator decision.",
      });
    }

    return signals;
  }

  async submitInitialPrompt(
    session: RuntimeSessionController,
    prompt: { userPrompt: string },
  ): Promise<void> {
    await session.write(`${prompt.userPrompt}\n`);
  }

  async submitHumanInput(
    session: RuntimeSessionController,
    input: HumanInput,
  ): Promise<void> {
    this.humanInputCalls += 1;

    if (this.options.failHumanInput === true) {
      throw new Error("fake human input failure");
    }

    await session.write(`${input.message}\n`);
  }

  async interrupt(session: RuntimeSessionController): Promise<void> {
    await session.interrupt();
  }

  async cancel(session: RuntimeSessionController): Promise<void> {
    await session.terminate(true);
  }

  async collectOutcome(
    _session: RuntimeSessionController,
    exit: SessionExit | null,
  ): Promise<RunOutcome> {
    if (exit?.exitCode === 0) {
      return {
        status: "completed",
        code: "completed",
        exitCode: 0,
        summary: "Run completed.",
      };
    }

    return {
      status: "canceled",
      code: "canceled",
      exitCode: exit?.exitCode ?? null,
      summary: "Run canceled.",
      error: buildRuntimeProviderError({
        providerKind: "codex",
        code: "transport",
        message: "Canceled by the fake adapter.",
        retryable: false,
      }),
    };
  }
}

export type ScriptedSessionStep =
  | {
      kind: "output";
      chunk: string;
      delayMs?: number;
    }
  | {
      kind: "exit";
      exitCode: number | null;
      signal?: string | null;
      delayMs?: number;
    };

export class ScriptedSessionSupervisor extends FakeSessionSupervisor {
  constructor(
    private readonly steps: ScriptedSessionStep[] = [
      {
        kind: "output",
        chunk: "READY\n",
      },
      {
        kind: "exit",
        exitCode: 0,
      },
    ],
  ) {
    super();
  }

  override async launch(
    spec: LaunchSpec,
    observer: SessionObserver,
  ): Promise<{ sessionId: string; pid: number; runId: string }> {
    const handle = await super.launch(spec, observer);

    void this.playScript(handle.sessionId);

    return handle;
  }

  private async playScript(sessionId: string): Promise<void> {
    for (const step of this.steps) {
      if ((step.delayMs ?? 0) > 0) {
        await delay(step.delayMs);
      } else {
        await Promise.resolve();
      }

      if (step.kind === "output") {
        this.emitOutput(sessionId, step.chunk);
        continue;
      }

      this.emitExit(sessionId, step.exitCode, step.signal ?? null);
      return;
    }
  }
}

export class ScriptedProviderAdapter extends FakeProviderAdapter {
  constructor(
    private readonly completedOutcome: Partial<RunOutcome>,
    options: {
      failHumanInput?: boolean;
    } = {},
  ) {
    super(options);
  }

  override async collectOutcome(
    session: RuntimeSessionController,
    exit: SessionExit | null,
  ): Promise<RunOutcome> {
    if (exit?.exitCode === 0) {
      return {
        status: "completed",
        code: "completed",
        exitCode: 0,
        summary: "Run completed.",
        ...structuredClone(this.completedOutcome),
      };
    }

    return super.collectOutcome(session, exit);
  }
}

export function createRuntimeFixture(t: TestContext): RuntimeFixture {
  const rootDir = mkdtempSync(path.join(tmpdir(), "orq-runtime-"));
  t.after(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  return {
    rootDir,
    runtimeConfig: {
      sourcePath: path.join(rootDir, "config.toml"),
      profileName: "test",
      stateDir: path.join(rootDir, "state"),
      logDir: path.join(rootDir, "logs"),
      runtimeLogDir: path.join(rootDir, "logs", "runtime"),
      databasePath: path.join(rootDir, "state", "runtime.sqlite"),
    policy: {
      maxConcurrentRuns: 4,
      maxRunsPerProvider: 2,
      allowMixedProviders: true,
      defaultPhaseTimeoutSec: 5400,
      merge: {
        allowedMethods: ["squash"],
        requireHumanApproval: false,
      },
    },
    },
  };
}

export function createRunInput(
  overrides: {
    runId?: string;
    phase?: CreateRunInput["phase"];
    provider?: CreateRunInput["provider"];
    workItemId?: string;
    workItemIdentifier?: string;
    workspaceSetup?: CreateRunInput["workspace"]["setup"];
    workspace?: Partial<CreateRunInput["workspace"]>;
  } = {},
): CreateRunInput {
  const runId = overrides.runId ?? "run-001";
  const workspaceSetup =
    overrides.workspace?.setup ?? overrides.workspaceSetup;

  return {
    runId,
    phase: overrides.phase ?? "implement",
    workItem: {
      id: overrides.workItemId ?? "issue-1",
      identifier: overrides.workItemIdentifier ?? "ORQ-33",
      title: "Implement PTY session supervisor abstraction and host process control",
      description: "Add the runtime execution seam.",
      labels: ["runtime"],
      url: "https://linear.app/orqestrate/issue/ORQ-33",
    },
    artifact: {
      artifactId: `artifact-${runId}`,
      url: `https://www.notion.so/${runId}`,
      summary: "Artifact placeholder",
    },
    provider: overrides.provider ?? "codex",
    workspace: {
      repoRoot: overrides.workspace?.repoRoot ?? "/repo",
      mode: overrides.workspace?.mode ?? "shared_readonly",
      workingDirHint: overrides.workspace?.workingDirHint ?? "/repo",
      baseRef: overrides.workspace?.baseRef ?? "main",
      assignedBranch:
        overrides.workspace?.assignedBranch ?? `hillkimball/${runId}`,
      pullRequestUrl:
        overrides.workspace?.pullRequestUrl ??
        `https://github.com/kimballh/orqestrate/pull/${runId}`,
      pullRequestMode: overrides.workspace?.pullRequestMode ?? "draft",
      writeScope: overrides.workspace?.writeScope ?? "repo",
      setup: workspaceSetup,
    },
    prompt: {
      contractId: "orqestrate/implement/v1",
      userPrompt: "Implement ORQ-33.",
      attachments: [],
      sources: [],
      digests: {
        system: "sha256-system",
        user: "sha256-user",
      },
    },
    grantedCapabilities: ["github.read_pr", "github.push_branch"],
    promptProvenance: {
      selection: {
        promptPackName: "default",
        capabilityNames: ["runtime"],
        organizationOverlayNames: ["org-default"],
        projectOverlayNames: ["project-default"],
        experimentName: null,
      },
      sources: [
        {
          kind: "base_pack",
          ref: "prompt-pack:default/base/system.md",
          digest: "sha256-base-pack",
        },
      ],
      rendered: {
        systemPromptLength: 0,
        userPromptLength: "Implement ORQ-33.".length,
        attachmentKinds: [],
        attachmentCount: 0,
      },
    },
    promptReplayContext: {
      runId,
      workItem: {
        id: overrides.workItemId ?? "issue-1",
        identifier: overrides.workItemIdentifier ?? "ORQ-33",
        title: "Implement PTY session supervisor abstraction and host process control",
        description: "Add the runtime execution seam.",
        labels: ["runtime"],
        url: "https://linear.app/orqestrate/issue/ORQ-33",
      },
      artifact: {
        artifactId: `artifact-${runId}`,
        url: `https://www.notion.so/${runId}`,
        summary: "Artifact placeholder",
      },
      workspace: {
        repoRoot: overrides.workspace?.repoRoot ?? "/repo",
        workingDir:
          overrides.workspace?.mode === "ephemeral_worktree"
            ? (overrides.workspace.workingDirHint ?? `/repo/.worktrees/${runId}`)
            : (overrides.workspace?.workingDirHint ?? "/repo"),
        mode: overrides.workspace?.mode ?? "shared_readonly",
        assignedBranch:
          overrides.workspace?.assignedBranch ?? `hillkimball/${runId}`,
        baseBranch: overrides.workspace?.baseRef ?? "main",
        pullRequestUrl:
          overrides.workspace?.pullRequestUrl ??
          `https://github.com/kimballh/orqestrate/pull/${runId}`,
        pullRequestMode: overrides.workspace?.pullRequestMode ?? "draft",
        writeScope: overrides.workspace?.writeScope ?? "repo",
        setup: workspaceSetup,
      },
      expectations: {
        expectedOutputs: ["implement the change"],
        verificationRequired: true,
        requiredRepoChecks: ["npm run check"],
        testExpectations: "Add targeted coverage.",
      },
      operatorNote: "Stay focused on the assigned ticket.",
      additionalContext: "Captured during prompt replay fixture setup.",
      attachments: [],
    },
    limits: {
      maxWallTimeSec: 5400,
      idleTimeoutSec: 300,
      bootstrapTimeoutSec: 120,
    },
    requestedBy: "Kimball Hill",
  };
}

export async function waitForAsyncTurn(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

export async function waitForRunStatus(
  daemon: { getRun(runId: string): PersistedRunRecord | null },
  runId: string,
  expectedStatus: string,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (daemon.getRun(runId)?.status === expectedStatus) {
      return;
    }

    await waitForAsyncTurn();
  }

  assert.fail(`Run '${runId}' never reached status '${expectedStatus}'.`);
}
