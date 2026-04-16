import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { parseConfig } from "../config/loader.js";
import type { LoadedConfig } from "../config/types.js";

import { assemblePrompt, PromptAssemblyError } from "./prompt-assembly.js";

test("assembles a deterministic prompt with layered overrides and symbolic sources", async () => {
  const fixture = createFixtureWorkspace();
  const result = await assemblePrompt(fixture.loadedConfig, {
    role: "implement",
    phase: "implement",
    capabilities: ["cap_second", "cap_first", "cap_second"],
    experiment: "exp_review",
    runAdditions: [
      {
        label: "Release Checklist",
        markdown: "Double-check release notes before finishing.",
      },
    ],
    context: {
      runId: "run-20",
      workItem: {
        id: "work-20",
        identifier: "ORQ-20",
        title: "Implement prompt assembly pipeline",
        description: "Render layered prompts for the assigned work item.",
        labels: ["prompts", "runtime"],
        url: "https://linear.app/orqestrate/issue/ORQ-20",
      },
      artifact: {
        artifactId: "artifact-20",
        url: "https://www.notion.so/orq-20",
        summary: "Design and plan notes are already captured.",
      },
      workspace: {
        repoRoot: fixture.workspaceDir,
        workingDir: path.join(fixture.workspaceDir, "src"),
        mode: "ephemeral_worktree",
        assignedBranch: "hillkimball/orq-20-implement-prompt-assembly-pipeline-with-layered-overrides",
        baseBranch: "main",
        pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/20",
        pullRequestMode: "draft",
        writeScope: "repo",
      },
      expectations: {
        expectedOutputs: ["code changes", "tests", "artifact update"],
        verificationRequired: true,
        requiredRepoChecks: ["npm run check"],
        testExpectations: "Add focused automated coverage for prompt assembly.",
      },
      operatorNote: "Keep the implementation narrow and deterministic.",
      additionalContext: "The runtime should receive a fully rendered prompt payload.",
      attachments: [
        {
          kind: "text",
          value: "Remember to mention missing coverage explicitly if needed.",
          label: "Reminder",
        },
      ],
    },
  });

  assert.equal(
    result.prompt.contractId,
    "orqestrate/default/implement/implement/v2",
  );
  assert.equal(
    result.prompt.systemPrompt,
    "Base system prompt.\nFollow the repository safety contract.\n\nRun scope invariant.\nStay inside the assigned work item.\n\nVerification invariant.\nReport real evidence and explain coverage gaps.",
  );
  assert.deepEqual(result.prompt.attachments, [
    {
      kind: "planning_url",
      value: "https://linear.app/orqestrate/issue/ORQ-20",
      label: "Planning issue",
    },
    {
      kind: "artifact_url",
      value: "https://www.notion.so/orq-20",
      label: "Issue artifact",
    },
    {
      kind: "text",
      value: "Remember to mention missing coverage explicitly if needed.",
      label: "Reminder",
    },
  ]);

  const layerRefs = result.resolvedLayers.map((layer) => layer.ref);
  assert.deepEqual(layerRefs, [
    "prompt-pack:default/base/system.md",
    "prompt-invariant:invariants/run-scope.md",
    "prompt-invariant:invariants/verification.md",
    "prompt-pack:default/roles/implement.md",
    "prompt-pack:default/phases/implement.md",
    "prompt-pack:default/capabilities/cap-first.md",
    "prompt-pack:default/capabilities/cap-second.md",
    "prompt-pack:default/overlays/org/org.md",
    "prompt-pack:default/overlays/project/project.md",
    "run-addition:release-checklist",
    "prompt-pack:default/experiments/review.md",
    "run-context",
    "artifact:artifact-20",
    "operator-note",
    "additional-context",
  ]);
  assert.deepEqual(result.provenance.selection, {
    promptPackName: "default",
    capabilityNames: ["cap_first", "cap_second"],
    organizationOverlayNames: ["default_org"],
    projectOverlayNames: ["default_project"],
    experimentName: "exp_review",
  });
  assert.deepEqual(
    result.provenance.sources.map((source) => ({
      kind: source.kind,
      ref: source.ref,
      digest: source.digest,
    })),
    result.resolvedLayers.map((layer) => ({
      kind: layer.kind,
      ref: layer.ref,
      digest: layer.digest,
    })),
  );
  assert.equal(
    result.provenance.rendered.systemPromptLength,
    result.prompt.systemPrompt?.length ?? 0,
  );
  assert.equal(
    result.provenance.rendered.userPromptLength,
    result.prompt.userPrompt.length,
  );
  assert.deepEqual(result.provenance.rendered.attachmentKinds, [
    "planning_url",
    "artifact_url",
    "text",
  ]);
  assert.equal(result.provenance.rendered.attachmentCount, 3);

  for (const source of result.prompt.sources) {
    assert.doesNotMatch(source.ref, new RegExp(fixture.workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const source of result.provenance.sources) {
    assert.doesNotMatch(
      source.ref,
      new RegExp(fixture.workspaceDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  }

  const assembledPrompt = result.prompt.userPrompt;
  assert.ok(
    assembledPrompt.indexOf("Capability one comes first.") <
      assembledPrompt.indexOf("Capability two comes second."),
  );
  assert.ok(
    assembledPrompt.indexOf("Project overlay instructions.") >
      assembledPrompt.indexOf("Organization overlay instructions."),
  );
  assert.match(assembledPrompt, /## Release Checklist/);
  assert.match(assembledPrompt, /## Run Context/);
  assert.match(assembledPrompt, /## Artifact Context/);
  assert.match(assembledPrompt, /## Operator Note/);
  assert.match(assembledPrompt, /## Additional Context/);
  assert.match(assembledPrompt, /Verification required: yes/);
  assert.match(assembledPrompt, /Authorized capabilities: cap_first, cap_second/);
  assert.equal(
    JSON.stringify(result.provenance).includes(fixture.workspaceDir),
    false,
  );
  assert.equal(
    JSON.stringify(result.provenance).includes("Remember to mention missing coverage explicitly if needed."),
    false,
  );
  assert.equal(
    JSON.stringify(result.provenance).includes("Base system prompt."),
    false,
  );
});

test("allows phases without a configured phase fragment", async () => {
  const fixture = createFixtureWorkspace();
  const result = await assemblePrompt(fixture.loadedConfig, {
    role: "design",
    phase: "design",
    context: {
      workItem: {
        id: "work-20",
        identifier: "ORQ-20",
        title: "Implement prompt assembly pipeline",
        description: null,
        labels: [],
        url: null,
      },
      workspace: {
        repoRoot: fixture.workspaceDir,
        mode: "ephemeral_worktree",
      },
      expectations: {},
    },
  });

  assert.equal(
    result.prompt.contractId,
    "orqestrate/default/design/design/v2",
  );
  assert.equal(
    result.resolvedLayers.filter((layer) => layer.kind === "invariant").length,
    2,
  );
  assert.equal(
    result.resolvedLayers.some((layer) => layer.kind === "phase_prompt"),
    false,
  );
  assert.match(result.prompt.userPrompt, /Design role instructions\./);
});

test("applies workspace-local prompt replacements plus prepend and append fragments", async () => {
  const fixture = createFixtureWorkspace();
  writePromptFile(
    path.join(fixture.workspaceDir, ".orqestrate", "prompts"),
    "roles/implement.md",
    "Workspace role override.\n",
  );
  writePromptFile(
    path.join(fixture.workspaceDir, ".orqestrate", "prompts"),
    "phases/implement.prepend.md",
    "Workspace phase prepend.\n",
  );
  writePromptFile(
    path.join(fixture.workspaceDir, ".orqestrate", "prompts"),
    "capabilities/cap-first.append.md",
    "Workspace capability append.\n",
  );

  const result = await assemblePrompt(fixture.loadedConfig, {
    role: "implement",
    phase: "implement",
    capabilities: ["cap_first"],
    context: {
      workItem: {
        id: "work-20",
        identifier: "ORQ-20",
        title: "Implement prompt assembly pipeline",
        description: null,
        labels: [],
        url: "https://linear.app/orqestrate/issue/ORQ-20",
      },
      workspace: {
        repoRoot: fixture.workspaceDir,
        mode: "ephemeral_worktree",
      },
      expectations: {},
    },
  });

  assert.deepEqual(
    result.resolvedLayers.map((layer) => layer.ref),
    [
      "prompt-pack:default/base/system.md",
      "prompt-invariant:invariants/run-scope.md",
      "prompt-invariant:invariants/verification.md",
      "workspace-prompt:replace/roles/implement.md",
      "workspace-prompt:prepend/phases/implement.md",
      "prompt-pack:default/phases/implement.md",
      "prompt-pack:default/capabilities/cap-first.md",
      "workspace-prompt:append/capabilities/cap-first.md",
      "prompt-pack:default/overlays/org/org.md",
      "prompt-pack:default/overlays/project/project.md",
      "prompt-pack:default/experiments/review.md",
      "run-context",
    ],
  );
  assert.doesNotMatch(result.prompt.userPrompt, /Implement role instructions\./);
  assert.match(result.prompt.userPrompt, /Workspace role override\./);
  assert.match(
    result.prompt.userPrompt,
    /Workspace phase prepend\.\n\nImplementation phase instructions\./,
  );
  assert.match(
    result.prompt.userPrompt,
    /Capability one comes first\.\n\nWorkspace capability append\./,
  );
});

test("fails clearly when a requested capability is unknown", async () => {
  const fixture = createFixtureWorkspace();

  await assert.rejects(
    () =>
      assemblePrompt(fixture.loadedConfig, {
        role: "implement",
        phase: "implement",
        capabilities: ["missing_capability"],
        context: {
          workItem: {
            id: "work-20",
            identifier: "ORQ-20",
            title: "Implement prompt assembly pipeline",
            description: null,
            labels: [],
            url: null,
          },
          workspace: {
            repoRoot: fixture.workspaceDir,
            mode: "ephemeral_worktree",
          },
          expectations: {},
        },
      }),
    (error) =>
      error instanceof PromptAssemblyError &&
      /Unknown prompt capabilities requested: missing_capability\./.test(
        error.message,
      ),
  );
});

test("fails clearly when a requested experiment is unknown", async () => {
  const fixture = createFixtureWorkspace();

  await assert.rejects(
    () =>
      assemblePrompt(fixture.loadedConfig, {
        role: "implement",
        phase: "implement",
        experiment: "missing_experiment",
        context: {
          workItem: {
            id: "work-20",
            identifier: "ORQ-20",
            title: "Implement prompt assembly pipeline",
            description: null,
            labels: [],
            url: null,
          },
          workspace: {
            repoRoot: fixture.workspaceDir,
            mode: "ephemeral_worktree",
          },
          expectations: {},
        },
      }),
    (error) =>
      error instanceof PromptAssemblyError &&
      /Unknown prompt experiment 'missing_experiment' requested\./.test(
        error.message,
      ),
  );
});

test("rejects capabilities that are unavailable in the selected prompt pack", async () => {
  const fixture = createFixtureWorkspace();

  await assert.rejects(
    () =>
      assemblePrompt(fixture.loadedConfig, {
        role: "implement",
        phase: "implement",
        capabilities: ["cap_registry_only"],
        context: {
          workItem: {
            id: "work-20",
            identifier: "ORQ-20",
            title: "Implement prompt assembly pipeline",
            description: null,
            labels: [],
            url: null,
          },
          workspace: {
            repoRoot: fixture.workspaceDir,
            mode: "ephemeral_worktree",
          },
          expectations: {},
        },
      }),
    (error) =>
      error instanceof PromptAssemblyError &&
      /Prompt pack 'default' does not define requested capabilities: cap_registry_only\./.test(
        error.message,
      ),
  );
});

test("rejects capabilities that are not allowed in the active phase", async () => {
  const fixture = createFixtureWorkspace();

  await assert.rejects(
    () =>
      assemblePrompt(fixture.loadedConfig, {
        role: "implement",
        phase: "implement",
        capabilities: ["cap_review_only"],
        context: {
          workItem: {
            id: "work-20",
            identifier: "ORQ-20",
            title: "Implement prompt assembly pipeline",
            description: null,
            labels: [],
            url: null,
          },
          workspace: {
            repoRoot: fixture.workspaceDir,
            mode: "ephemeral_worktree",
          },
          expectations: {},
        },
      }),
    (error) =>
      error instanceof PromptAssemblyError &&
      /Prompt capability 'cap_review_only' is not allowed in phase 'implement'\./.test(
        error.message,
      ),
  );
});

test("rejects capabilities when required context is missing", async () => {
  const fixture = createFixtureWorkspace();

  await assert.rejects(
    () =>
      assemblePrompt(fixture.loadedConfig, {
        role: "implement",
        phase: "implement",
        capabilities: ["cap_second"],
        context: {
          workItem: {
            id: "work-20",
            identifier: "ORQ-20",
            title: "Implement prompt assembly pipeline",
            description: null,
            labels: [],
            url: null,
          },
          workspace: {
            repoRoot: fixture.workspaceDir,
            mode: "ephemeral_worktree",
          },
          expectations: {},
        },
      }),
    (error) =>
      error instanceof PromptAssemblyError &&
      /Prompt capability 'cap_second' requires context: pull_request_url\./.test(
        error.message,
      ),
  );
});

test("rejects capabilities when required peer capabilities are missing", async () => {
  const fixture = createFixtureWorkspace();

  await assert.rejects(
    () =>
      assemblePrompt(fixture.loadedConfig, {
        role: "implement",
        phase: "implement",
        capabilities: ["cap_requires_first"],
        context: {
          workItem: {
            id: "work-20",
            identifier: "ORQ-20",
            title: "Implement prompt assembly pipeline",
            description: null,
            labels: [],
            url: null,
          },
          workspace: {
            repoRoot: fixture.workspaceDir,
            mode: "ephemeral_worktree",
          },
          expectations: {},
        },
      }),
    (error) =>
      error instanceof PromptAssemblyError &&
      /Prompt capability 'cap_requires_first' requires capabilities: cap_first\./.test(
        error.message,
      ),
  );
});

test("rejects explicitly conflicting capabilities", async () => {
  const fixture = createFixtureWorkspace();

  await assert.rejects(
    () =>
      assemblePrompt(fixture.loadedConfig, {
        role: "implement",
        phase: "implement",
        capabilities: ["cap_first", "cap_conflicts_first"],
        context: {
          workItem: {
            id: "work-20",
            identifier: "ORQ-20",
            title: "Implement prompt assembly pipeline",
            description: null,
            labels: [],
            url: null,
          },
          workspace: {
            repoRoot: fixture.workspaceDir,
            mode: "ephemeral_worktree",
          },
          expectations: {},
        },
      }),
    (error) =>
      error instanceof PromptAssemblyError &&
      /Prompt capabilities conflict: cap_conflicts_first conflicts with cap_first\./.test(
        error.message,
      ),
  );
});

test("uses the profile default experiment when no experiment override is provided", async () => {
  const fixture = createFixtureWorkspace();

  const result = await assemblePrompt(fixture.loadedConfig, {
    role: "implement",
    phase: "implement",
    context: {
      workItem: {
        id: "work-22",
        identifier: "ORQ-22",
        title: "Config-driven prompt selection",
        description: null,
        labels: [],
        url: null,
      },
      workspace: {
        repoRoot: fixture.workspaceDir,
        mode: "ephemeral_worktree",
      },
      expectations: {},
    },
  });

  assert.ok(
    result.resolvedLayers.some(
      (layer) => layer.ref === "prompt-pack:default/experiments/review.md",
    ),
  );
  assert.match(result.prompt.userPrompt, /Experiment variant instructions\./);
});

test("allows callers to disable the profile default experiment explicitly", async () => {
  const fixture = createFixtureWorkspace();

  const result = await assemblePrompt(fixture.loadedConfig, {
    role: "implement",
    phase: "implement",
    experiment: null,
    context: {
      workItem: {
        id: "work-22",
        identifier: "ORQ-22",
        title: "Config-driven prompt selection",
        description: null,
        labels: [],
        url: null,
      },
      workspace: {
        repoRoot: fixture.workspaceDir,
        mode: "ephemeral_worktree",
      },
      expectations: {},
    },
  });

  assert.equal(
    result.resolvedLayers.some((layer) => layer.kind === "experiment"),
    false,
  );
  assert.doesNotMatch(result.prompt.userPrompt, /Experiment variant instructions\./);
});

test("produces stable digests for equivalent capability requests", async () => {
  const fixture = createFixtureWorkspace();
  const baseRequest = {
    role: "implement" as const,
    phase: "implement" as const,
    context: {
      workItem: {
        id: "work-20",
        identifier: "ORQ-20",
        title: "Implement prompt assembly pipeline",
        description: "Ensure prompt digests remain stable.",
        labels: ["prompts"],
        url: "https://linear.app/orqestrate/issue/ORQ-20",
      },
      workspace: {
        repoRoot: fixture.workspaceDir,
        mode: "ephemeral_worktree" as const,
        pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/20",
      },
      expectations: {},
    },
  };

  const first = await assemblePrompt(fixture.loadedConfig, {
    ...baseRequest,
    capabilities: ["cap_second", "cap_first", "cap_second"],
  });
  const second = await assemblePrompt(fixture.loadedConfig, {
    ...baseRequest,
    capabilities: ["cap_first", "cap_second"],
  });

  assert.deepEqual(first.prompt.digests, second.prompt.digests);
  assert.deepEqual(first.prompt.sources, second.prompt.sources);
  assert.equal(first.prompt.userPrompt, second.prompt.userPrompt);
});

test("keeps symbolic source refs stable when unused assets live outside the prompt root", async () => {
  const baseFixture = createFixtureWorkspace();
  const externalFixture = createFixtureWorkspace({
    extraExperiments: {
      unused_external: {
        assetPath: "../external-exp/unused.md",
        contents: "Unused external experiment instructions.\n",
      },
    },
  });

  const request = {
    role: "implement" as const,
    phase: "implement" as const,
    context: {
      workItem: {
        id: "work-20",
        identifier: "ORQ-20",
        title: "Implement prompt assembly pipeline",
        description: "Ensure unrelated assets do not rewrite prompt provenance.",
        labels: ["prompts"],
        url: "https://linear.app/orqestrate/issue/ORQ-20",
      },
      workspace: {
        repoRoot: baseFixture.workspaceDir,
        mode: "ephemeral_worktree" as const,
      },
      expectations: {},
    },
  };

  const baseResult = await assemblePrompt(baseFixture.loadedConfig, request);
  const externalResult = await assemblePrompt(externalFixture.loadedConfig, {
    ...request,
    context: {
      ...request.context,
      workspace: {
        ...request.context.workspace,
        repoRoot: externalFixture.workspaceDir,
      },
    },
  });

  assert.deepEqual(baseResult.prompt.sources, externalResult.prompt.sources);
  assert.deepEqual(
    baseResult.resolvedLayers.map((layer) => layer.ref),
    externalResult.resolvedLayers.map((layer) => layer.ref),
  );
});

function createFixtureWorkspace(options: {
  extraExperiments?: Record<
    string,
    {
      assetPath: string;
      contents: string;
    }
  >;
} = {}): {
  workspaceDir: string;
  loadedConfig: LoadedConfig;
} {
  const workspaceDir = mkdtempSync(path.join(tmpdir(), "orqestrate-prompt-assembly-"));
  const promptRoot = path.join(workspaceDir, "prompts");

  writePromptFile(
    promptRoot,
    "base/system.md",
    "Base system prompt.  \r\nFollow the repository safety contract.\r\n",
  );
  writePromptFile(
    promptRoot,
    "invariants/run-scope.md",
    "Run scope invariant.\nStay inside the assigned work item.\n",
  );
  writePromptFile(
    promptRoot,
    "invariants/verification.md",
    "Verification invariant.\nReport real evidence and explain coverage gaps.\n",
  );
  writePromptFile(promptRoot, "roles/design.md", "Design role instructions.\n");
  writePromptFile(promptRoot, "roles/implement.md", "Implement role instructions.\n");
  writePromptFile(promptRoot, "phases/implement.md", "Implementation phase instructions.\n");
  writePromptFile(promptRoot, "capabilities/cap-first.md", "Capability one comes first.\n");
  writePromptFile(promptRoot, "capabilities/cap-second.md", "Capability two comes second.\n");
  writePromptFile(
    promptRoot,
    "capabilities/cap-review-only.md",
    "Capability available only during review.\n",
  );
  writePromptFile(
    promptRoot,
    "capabilities/cap-requires-first.md",
    "Capability that depends on cap_first.\n",
  );
  writePromptFile(
    promptRoot,
    "capabilities/cap-conflicts-first.md",
    "Capability that conflicts with cap_first.\n",
  );
  writePromptFile(promptRoot, "overlays/org/org.md", "Organization overlay instructions.\n");
  writePromptFile(promptRoot, "overlays/project/project.md", "Project overlay instructions.\n");
  writePromptFile(promptRoot, "experiments/review.md", "Experiment variant instructions.\n");
  for (const { assetPath, contents } of Object.values(options.extraExperiments ?? {})) {
    writePromptFile(promptRoot, assetPath, contents);
  }

  const sourcePath = path.join(workspaceDir, "config.toml");
  const configSource = `version = 1
active_profile = "local"

[paths]
state_dir = ".state"
data_dir = ".data"
log_dir = ".logs"

[prompts]
root = "./prompts"
active_pack = "default"
invariants = [
  "invariants/run-scope.md",
  "invariants/verification.md",
]

[prompt_capabilities.cap_first]
authority = "behavioral"
allowed_phases = ["implement", "review"]

[prompt_capabilities.cap_second]
authority = "behavioral"
allowed_phases = ["implement", "review"]
required_context = ["pull_request_url"]

[prompt_capabilities.cap_review_only]
authority = "execution_surface_read"
allowed_phases = ["review"]

[prompt_capabilities.cap_requires_first]
authority = "behavioral"
allowed_phases = ["implement", "review"]
requires = ["cap_first"]

[prompt_capabilities.cap_conflicts_first]
authority = "behavioral"
allowed_phases = ["implement", "review"]
conflicts_with = ["cap_first"]

[prompt_capabilities.cap_registry_only]
authority = "behavioral"
allowed_phases = ["implement", "review"]

[prompt_packs.default]
base_system = "base/system.md"

[prompt_packs.default.roles]
design = "roles/design.md"
implement = "roles/implement.md"

[prompt_packs.default.phases]
implement = "phases/implement.md"

[prompt_packs.default.capabilities]
cap_first = "capabilities/cap-first.md"
cap_second = "capabilities/cap-second.md"
cap_review_only = "capabilities/cap-review-only.md"
cap_requires_first = "capabilities/cap-requires-first.md"
cap_conflicts_first = "capabilities/cap-conflicts-first.md"

[prompt_packs.default.overlays.organization]
default_org = "overlays/org/org.md"

[prompt_packs.default.overlays.project]
default_project = "overlays/project/project.md"

[prompt_packs.default.experiments]
exp_review = "experiments/review.md"
${renderExtraExperimentsToml(options.extraExperiments)}

[providers.local_planning]
kind = "planning.local_files"
root = ".planning"

[providers.local_context]
kind = "context.local_files"
root = ".context"

[profiles.local]
planning = "local_planning"
context = "local_context"
prompt_pack = "default"

[profiles.local.prompt]
organization_overlays = ["default_org"]
project_overlays = ["default_project"]
default_experiment = "exp_review"
`;

  return {
    workspaceDir,
    loadedConfig: parseConfig(configSource, {
      sourcePath,
      env: {},
    }),
  };
}

function writePromptFile(root: string, relativePath: string, contents: string): void {
  const destination = path.join(root, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, contents, "utf8");
}

function renderExtraExperimentsToml(
  experiments:
    | Record<
        string,
        {
          assetPath: string;
          contents: string;
        }
      >
    | undefined,
): string {
  if (experiments === undefined || Object.keys(experiments).length === 0) {
    return "";
  }

  return Object.entries(experiments)
    .map(([name, experiment]) => `${name} = "${experiment.assetPath}"`)
    .join("\n");
}
