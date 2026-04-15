import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuthenticationLinearError } from "@linear/sdk";

import type {
  ContextProviderDefinition,
  ContextLocalFilesProviderConfig,
  PlanningLinearProviderConfig,
  PlanningProviderDefinition,
  PlanningLocalFilesProviderConfig,
} from "../config/types.js";
import { loadConfig } from "../config/loader.js";
import {
  bootstrapActiveProfile,
  ProviderBootstrapError,
  ProviderRegistry,
} from "../index.js";
import { LocalFilesContextBackend } from "../providers/context/local-files-backend.js";
import { NotionContextBackend } from "../providers/context/notion-backend.js";
import { UnimplementedContextBackend } from "../providers/context/unimplemented-context-backend.js";
import { LinearPlanningClient } from "../providers/planning/linear/client.js";
import { LinearPlanningBackend } from "../providers/planning/linear-backend.js";
import { LocalFilesPlanningBackend } from "../providers/planning/local-files-backend.js";
import { UnimplementedPlanningBackend } from "../providers/planning/unimplemented-planning-backend.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

test("bootstraps the docs example local profile through the built-in registry", async () => {
  const config = await loadExampleConfig();
  const result = await bootstrapActiveProfile(config);

  assert.equal(result.report.profileName, "local");
  assert.ok(result.planning instanceof LocalFilesPlanningBackend);
  assert.ok(result.context instanceof LocalFilesContextBackend);
  assert.deepEqual(
    result.report.checks.map((check) => ({
      family: check.family,
      kind: check.providerKind,
      source: check.source,
      validated: check.validated,
      healthOk: check.healthCheck?.ok ?? null,
    })),
    [
      {
        family: "planning",
        kind: "planning.local_files",
        source: "builtin",
        validated: true,
        healthOk: true,
      },
      {
        family: "context",
        kind: "context.local_files",
        source: "builtin",
        validated: true,
        healthOk: true,
      },
    ],
  );
});

test("fails clearly when the docs example saas profile still uses placeholder Notion ids", async () => {
  const config = await loadExampleConfig("saas", {
    LINEAR_API_KEY: "linear-token",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
    NOTION_TOKEN: "notion-token",
  });

  await assert.rejects(
    () =>
      bootstrapActiveProfile(config, {
        runHealthChecks: false,
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderBootstrapError);
      assert.equal(error.code, "provider_validation_failed");
      assert.equal(error.family, "context");
      assert.equal(error.providerName, "notion_main");
      assert.match(error.message, /failed validation/i);
      assert.match(
        error.cause instanceof Error ? error.cause.message : "",
        /artifacts_database_id/,
      );
      return true;
    },
  );
});

test("bootstraps the docs example hybrid profile through the built-in registry", async () => {
  const config = await loadExampleConfig("hybrid", {
    LINEAR_API_KEY: "linear-token",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  });
  const result = await bootstrapActiveProfile(config, {
    runHealthChecks: false,
  });

  assert.equal(result.report.profileName, "hybrid");
  assert.ok(result.planning instanceof LinearPlanningBackend);
  assert.ok(result.context instanceof LocalFilesContextBackend);
});

test("rejects duplicate provider registrations", () => {
  const registry = new ProviderRegistry().registerPlanning<PlanningLocalFilesProviderConfig>(
    "planning.local_files",
    ({ provider }) => new TrackingPlanningBackend(provider, []),
  );

  assert.throws(
    () =>
      registry.registerPlanning<PlanningLocalFilesProviderConfig>(
        "planning.local_files",
        ({ provider }) => new TrackingPlanningBackend(provider, []),
      ),
    (error: unknown) => {
      assert.ok(error instanceof ProviderBootstrapError);
      assert.equal(error.code, "duplicate_provider_registration");
      assert.equal(error.family, "planning");
      assert.equal(error.providerKind, "planning.local_files");
      return true;
    },
  );
});

test("fails clearly when no factory is registered for the active provider kind", async () => {
  const config = await loadExampleConfig();

  await assert.rejects(
    () =>
      bootstrapActiveProfile(config, {
        registry: new ProviderRegistry(),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderBootstrapError);
      assert.equal(error.code, "unknown_provider_factory");
      assert.equal(error.family, "planning");
      assert.equal(error.providerKind, "planning.local_files");
      return true;
    },
  );
});

test("runs validation for both backends before running either health check", async () => {
  const config = await loadExampleConfig();
  const events: string[] = [];
  const registry = new ProviderRegistry()
    .registerPlanning<PlanningLocalFilesProviderConfig>(
      "planning.local_files",
      ({ provider }) => new TrackingPlanningBackend(provider, events),
    )
    .registerContext<ContextLocalFilesProviderConfig>(
      "context.local_files",
      ({ provider }) => new TrackingContextBackend(provider, events),
    );

  const result = await bootstrapActiveProfile(config, { registry });

  assert.ok(result.planning instanceof TrackingPlanningBackend);
  assert.ok(result.context instanceof TrackingContextBackend);
  assert.deepEqual(events, [
    "planning.validate",
    "context.validate",
    "planning.health",
    "context.health",
  ]);
});

test("surfaces health-check failures with provider metadata", async () => {
  const config = await loadExampleConfig();
  const registry = new ProviderRegistry()
    .registerPlanning<PlanningLocalFilesProviderConfig>(
      "planning.local_files",
      ({ provider }) => new TrackingPlanningBackend(provider, []),
    )
    .registerContext<ContextLocalFilesProviderConfig>(
      "context.local_files",
      ({ provider }) => new FailingHealthContextBackend(provider),
    );

  await assert.rejects(
    () => bootstrapActiveProfile(config, { registry }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderBootstrapError);
      assert.equal(error.code, "provider_healthcheck_failed");
      assert.equal(error.family, "context");
      assert.equal(error.providerName, "local_context");
      assert.equal(error.providerKind, "context.local_files");
      assert.match(error.message, /context backend is unavailable/i);
      return true;
    },
  );
});

test("can skip health checks while still validating configuration", async () => {
  const config = await loadExampleConfig();
  const events: string[] = [];
  const registry = new ProviderRegistry()
    .registerPlanning<PlanningLocalFilesProviderConfig>(
      "planning.local_files",
      ({ provider }) => new TrackingPlanningBackend(provider, events),
    )
    .registerContext<ContextLocalFilesProviderConfig>(
      "context.local_files",
      ({ provider }) => new TrackingContextBackend(provider, events),
    );

  const result = await bootstrapActiveProfile(config, {
    registry,
    runHealthChecks: false,
  });

  assert.ok(result.planning instanceof TrackingPlanningBackend);
  assert.ok(result.context instanceof TrackingContextBackend);
  assert.deepEqual(events, ["planning.validate", "context.validate"]);
  assert.deepEqual(
    result.report.checks.map((check) => check.healthCheck),
    [null, null],
  );
});

test("surfaces built-in Linear health-check failures with actionable messages", async () => {
  const config = await loadExampleConfig("hybrid", {
    LINEAR_API_KEY: "linear-token",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  });
  const registry = new ProviderRegistry()
    .registerPlanning<PlanningLinearProviderConfig>(
      "planning.linear",
      ({ provider }) =>
        new LinearPlanningBackend(provider, {
          client: new LinearPlanningClient({
            sdkClient: {
              viewer: Promise.reject(createLinearAuthError()),
              teams: async () => ({ nodes: [] }),
            },
          }),
        }),
    )
    .registerContext<ContextLocalFilesProviderConfig>(
      "context.local_files",
      ({ provider }) => new TrackingContextBackend(provider, []),
    );

  await assert.rejects(
    () => bootstrapActiveProfile(config, { registry }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderBootstrapError);
      assert.equal(error.code, "provider_healthcheck_failed");
      assert.equal(error.family, "planning");
      assert.equal(error.providerKind, "planning.linear");
      assert.match(error.message, /configured api token/i);
      return true;
    },
  );
});

test("supports extension registrations with non-built-in provider kinds", async () => {
  const registry = new ProviderRegistry()
    .registerPlanning<AsanaPlanningProviderConfig>(
      "planning.asana",
      ({ provider }) => new ExtensionPlanningBackend(provider),
    )
    .registerContext<GoogleDriveContextProviderConfig>(
      "context.google_drive",
      ({ provider }) => new ExtensionContextBackend(provider),
    );

  const planning = await registry.createPlanningBackend({
    provider: {
      name: "asana_main",
      family: "planning",
      kind: "planning.asana",
      workspace: "workspace-1",
    },
    profile: createFakeProfile(),
    loadedConfig: createFakeLoadedConfig(),
  });
  const context = await registry.createContextBackend({
    provider: {
      name: "drive_main",
      family: "context",
      kind: "context.google_drive",
      driveId: "drive-1",
    },
    profile: createFakeProfile(),
    loadedConfig: createFakeLoadedConfig(),
  });

  assert.ok(planning.backend instanceof ExtensionPlanningBackend);
  assert.ok(context.backend instanceof ExtensionContextBackend);
  assert.equal(planning.registration.kind, "planning.asana");
  assert.equal(context.registration.kind, "context.google_drive");
});

test("built-in Linear registration uses the loaded config env snapshot instead of process.env", async () => {
  const config = await loadExampleConfig("hybrid", {
    LINEAR_API_KEY: "env-snapshot-token",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  });
  const originalToken = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;

  try {
    const result = await bootstrapActiveProfile(config, {
      runHealthChecks: false,
    });

    assert.ok(result.planning instanceof LinearPlanningBackend);
    assert.equal(
      (result.planning as unknown as { apiKey?: string }).apiKey,
      "env-snapshot-token",
    );
  } finally {
    if (originalToken === undefined) {
      delete process.env.LINEAR_API_KEY;
    } else {
      process.env.LINEAR_API_KEY = originalToken;
    }
  }
});

async function loadExampleConfig(
  activeProfile?: string,
  env?: NodeJS.ProcessEnv,
) {
  return loadConfig({
    configPath: path.join(REPO_ROOT, "docs", "config.example.toml"),
    activeProfile,
    env: env ?? {},
  });
}

class TrackingPlanningBackend extends UnimplementedPlanningBackend<PlanningLocalFilesProviderConfig> {
  constructor(
    config: PlanningLocalFilesProviderConfig,
    private readonly events: string[],
  ) {
    super(config);
  }

  override async validateConfig(): Promise<void> {
    this.events.push("planning.validate");
  }

  override async healthCheck() {
    this.events.push("planning.health");
    return { ok: true };
  }
}

class TrackingContextBackend extends UnimplementedContextBackend<ContextLocalFilesProviderConfig> {
  constructor(
    config: ContextLocalFilesProviderConfig,
    private readonly events: string[],
  ) {
    super(config);
  }

  override async validateConfig(): Promise<void> {
    this.events.push("context.validate");
  }

  override async healthCheck() {
    this.events.push("context.health");
    return { ok: true };
  }
}

class FailingHealthContextBackend extends UnimplementedContextBackend<ContextLocalFilesProviderConfig> {
  override async healthCheck() {
    return {
      ok: false,
      message: "context backend is unavailable",
    };
  }
}

type AsanaPlanningProviderConfig = PlanningProviderDefinition<"planning.asana"> & {
  workspace: string;
};

type GoogleDriveContextProviderConfig =
  ContextProviderDefinition<"context.google_drive"> & {
    driveId: string;
  };

class ExtensionPlanningBackend extends UnimplementedPlanningBackend<AsanaPlanningProviderConfig> {}

class ExtensionContextBackend extends UnimplementedContextBackend<GoogleDriveContextProviderConfig> {}

function createFakeProfile() {
  return {
    name: "extension",
    planningProviderName: "planning_ext",
    contextProviderName: "context_ext",
    promptPackName: "default",
    planningProvider: {
      name: "local_planning",
      family: "planning",
      kind: "planning.local_files",
      root: "/tmp/planning",
    } as PlanningLocalFilesProviderConfig,
    contextProvider: {
      name: "local_context",
      family: "context",
      kind: "context.local_files",
      root: "/tmp/context",
      templates: {},
    } as ContextLocalFilesProviderConfig,
    promptPack: {
      name: "default",
      baseSystem: "/tmp/system.md",
      roles: {},
      phases: {},
      capabilities: {},
      overlays: {},
      experiments: {},
    },
  } as const;
}

function createFakeLoadedConfig() {
  const profile = createFakeProfile();

  return {
    sourcePath: "/tmp/config.toml",
    version: 1 as const,
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
    },
    prompts: {
      root: "/tmp/prompts",
      activePack: "default",
      invariants: [],
    },
    promptCapabilities: {},
    promptPacks: {
      default: profile.promptPack,
    },
    providers: {
      [profile.planningProvider.name]: profile.planningProvider,
      [profile.contextProvider.name]: profile.contextProvider,
    },
    profiles: {
      [profile.name]: profile,
    },
    activeProfileName: profile.name,
    activeProfile: profile,
  };
}

function createLinearAuthError() {
  return new AuthenticationLinearError({
    response: {
      status: 401,
      error: "Unauthorized",
    },
  } as never);
}
