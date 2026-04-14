import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ContextLocalFilesProviderConfig,
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

test("bootstraps the docs example saas profile through the built-in registry", async () => {
  const config = await loadExampleConfig("saas", {
    LINEAR_API_KEY: "linear-token",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
    NOTION_TOKEN: "notion-token",
  });
  const result = await bootstrapActiveProfile(config);

  assert.equal(result.report.profileName, "saas");
  assert.ok(result.planning instanceof LinearPlanningBackend);
  assert.ok(result.context instanceof NotionContextBackend);
});

test("bootstraps the docs example hybrid profile through the built-in registry", async () => {
  const config = await loadExampleConfig("hybrid", {
    LINEAR_API_KEY: "linear-token",
    LINEAR_WEBHOOK_SECRET: "webhook-secret",
  });
  const result = await bootstrapActiveProfile(config);

  assert.equal(result.report.profileName, "hybrid");
  assert.ok(result.planning instanceof LinearPlanningBackend);
  assert.ok(result.context instanceof LocalFilesContextBackend);
});

test("rejects duplicate provider registrations", () => {
  const registry = new ProviderRegistry().registerPlanning(
    "planning.local_files",
    ({ provider }) => new TrackingPlanningBackend(provider, []),
  );

  assert.throws(
    () =>
      registry.registerPlanning(
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
    .registerPlanning(
      "planning.local_files",
      ({ provider }) => new TrackingPlanningBackend(provider, events),
    )
    .registerContext(
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
    .registerPlanning(
      "planning.local_files",
      ({ provider }) => new TrackingPlanningBackend(provider, []),
    )
    .registerContext(
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
    .registerPlanning(
      "planning.local_files",
      ({ provider }) => new TrackingPlanningBackend(provider, events),
    )
    .registerContext(
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
