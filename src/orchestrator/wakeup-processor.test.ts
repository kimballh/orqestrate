import assert from "node:assert/strict";
import test from "node:test";

import type { LoadedConfig } from "../config/types.js";
import type { WorkItemRecord } from "../domain-model.js";

import { WakeupProcessor } from "./wakeup-processor.js";
import type { WakeupEventRecord } from "./wakeup-types.js";

test("wakeup processor reports no-op decisions from executeClaimedRun", async () => {
  const calls: Array<{ workItemId: string; requestedBy: string | null | undefined }> = [];
  const processor = new WakeupProcessor({
    planning: {} as never,
    context: {} as never,
    loadedConfig: createLoadedConfigFixture(),
    repoRoot: "/repo",
    owner: "orchestrator:test",
    executeClaimedRunFn: async (_dependencies, input) => {
      calls.push({
        workItemId: input.workItemId,
        requestedBy: input.requestedBy,
      });

      return {
        ok: false,
        workItem: createWorkItem(),
        resolution: {
          actionable: false,
          reason: "blocked_status",
          message: "Work item 'issue-1' is blocked and cannot be claimed automatically.",
          phase: "implement",
        },
      };
    },
  });

  const result = await processor.process(createWakeupEvent());

  assert.equal(result.outcome, "noop");
  assert.match(result.summary, /blocked/);
  assert.deepEqual(calls, [
    {
      workItemId: "issue-1",
      requestedBy: "orchestrator:wakeup:delivery-1",
    },
  ]);
});

test("wakeup processor reports executed runs from executeClaimedRun", async () => {
  const processor = new WakeupProcessor({
    planning: {} as never,
    context: {} as never,
    loadedConfig: createLoadedConfigFixture(),
    repoRoot: "/repo",
    owner: "orchestrator:test",
    executeClaimedRunFn: async () =>
      ({
        ok: true,
        prepared: {
          runId: "run-1",
          owner: "orchestrator:test",
          leaseUntil: "2026-04-15T00:30:00.000Z",
          leaseDurationMs: 1_000,
          phase: "implement",
          claimedWorkItem: createWorkItem(),
          artifact: null,
          context: {
            artifact: null,
            contextText: "",
            references: [],
          },
          runLedger: {
            runId: "run-1",
            workItemId: "issue-1",
            phase: "implement",
            status: "queued",
            createdAt: "2026-04-15T00:00:00.000Z",
            updatedAt: "2026-04-15T00:00:00.000Z",
          },
          submission: {} as never,
        },
        resolution: {
          actionable: true,
          phase: "implement",
        },
        decision: {
          claimable: true,
          phase: "implement",
          hasExpiredLease: false,
        },
        execution: {
          prepared: {} as never,
          watched: {
            run: {
              runId: "run-1",
              workItemId: "issue-1",
              workItemIdentifier: "ORQ-40",
              phase: "implement",
              provider: "codex",
              status: "waiting_human",
              repoRoot: "/repo",
              workspace: {
                mode: "ephemeral_worktree",
              },
              grantedCapabilities: [],
              promptContractId: "orq/implement",
              promptDigests: {
                system: null,
                user: null,
              },
              limits: {
                maxWallTimeSec: 10,
                idleTimeoutSec: 10,
                bootstrapTimeoutSec: 10,
              },
              createdAt: "2026-04-15T00:00:00.000Z",
              lastEventSeq: null,
              priority: 100,
              attemptCount: 1,
              version: 1,
            },
            lastEventSeq: null,
          },
          writeback: {} as never,
        },
      }) as never,
  });

  const result = await processor.process(createWakeupEvent());

  assert.equal(result.outcome, "executed");
  assert.match(result.summary, /waiting_human/);
});

function createLoadedConfigFixture(): LoadedConfig {
  return {
    sourcePath: "/tmp/config.toml",
    version: 1,
    env: {},
    paths: {
      stateDir: "/tmp/state",
      dataDir: "/tmp/data",
      logDir: "/tmp/logs",
    },
    policy: {
      maxConcurrentRuns: 1,
      maxRunsPerProvider: 1,
      allowMixedProviders: true,
      defaultPhaseTimeoutSec: 60,
      merge: {
        allowedMethods: ["squash"],
        requireHumanApproval: false,
      },
    },
    prompts: {
      root: "/tmp/prompts",
      activePack: "default",
      invariants: [],
    },
    promptCapabilities: {},
    promptPacks: {},
    providers: {},
    profiles: {},
    activeProfileName: "test",
    activeProfile: {
      name: "test",
      planningProviderName: "planning",
      contextProviderName: "context",
      promptPackName: "default",
      planningProvider: {
        name: "planning",
        family: "planning",
        kind: "planning.local_files",
        root: "/tmp",
      },
      contextProvider: {
        name: "context",
        family: "context",
        kind: "context.local_files",
        root: "/tmp",
        templates: {},
      },
      promptPack: {
        name: "default",
        baseSystem: "/tmp/system.md",
        roles: {},
        phases: {},
        capabilities: {},
        overlays: {
          organization: {},
          project: {},
        },
        experiments: {},
      },
      promptBehavior: {
        promptPackName: "default",
        promptPack: {
          name: "default",
          baseSystem: "/tmp/system.md",
          roles: {},
          phases: {},
          capabilities: {},
          overlays: {
            organization: {},
            project: {},
          },
          experiments: {},
        },
        organizationOverlayNames: [],
        projectOverlayNames: [],
        organizationOverlays: [],
        projectOverlays: [],
      },
    },
  };
}

function createWakeupEvent(): WakeupEventRecord {
  return {
    eventId: "event-1",
    provider: "linear",
    deliveryId: "delivery-1",
    resourceType: "Issue",
    resourceId: "issue-1",
    issueId: "issue-1",
    action: "update",
    dedupeKey: "linear:Issue:issue-1",
    status: "processing",
    attempts: 1,
    firstReceivedAt: "2026-04-15T00:00:00.000Z",
    lastReceivedAt: "2026-04-15T00:00:00.000Z",
    availableAt: "2026-04-15T00:00:00.000Z",
    claimedAt: "2026-04-15T00:00:00.000Z",
    processedAt: null,
    processorOwner: "orchestrator:test",
    coalescedCount: 0,
    lastError: null,
    payloadJson: null,
  };
}

function createWorkItem(): WorkItemRecord {
  return {
    id: "issue-1",
    identifier: "ORQ-40",
    title: "Implement webhook ingress and wakeup queue contract",
    description: null,
    status: "implement",
    phase: "implement",
    priority: 2,
    labels: [],
    url: "https://linear.app/orqestrate/issue/ORQ-40",
    parentId: null,
    dependencyIds: [],
    blockedByIds: [],
    blocksIds: [],
    artifactUrl: null,
    updatedAt: "2026-04-15T00:00:00.000Z",
    createdAt: "2026-04-15T00:00:00.000Z",
    orchestration: {
      state: "queued",
      owner: null,
      runId: null,
      leaseUntil: null,
      reviewOutcome: "none",
      blockedReason: null,
      lastError: null,
      attemptCount: 0,
    },
  };
}
