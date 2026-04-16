import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { parse as parseToml } from "smol-toml";

import type { WorkspaceConfig } from "../config/types.js";
import type { ProviderError, WorkspaceSetupRecord } from "../domain-model.js";

type ValueRecord = Record<string, unknown>;

export class WorkspaceSetupResolutionError extends Error {
  readonly providerError: ProviderError;

  constructor(
    message: string,
    details: Record<string, string | boolean | number | null> | null = null,
  ) {
    super(message);
    this.name = "WorkspaceSetupResolutionError";
    this.providerError = {
      providerFamily: "runtime",
      providerKind: "workspace_setup",
      code: "validation",
      message,
      retryable: false,
      details,
    };
  }
}

export async function resolveWorkspaceSetup(input: {
  repoRoot: string;
  workspace: WorkspaceConfig;
}): Promise<WorkspaceSetupRecord | null> {
  if (input.workspace.setupScript !== undefined) {
    return resolveConfiguredSetupScript(input.workspace.setupScript);
  }

  return resolveCodexEnvironmentSetup(input.repoRoot);
}

async function resolveConfiguredSetupScript(
  scriptPath: string,
): Promise<WorkspaceSetupRecord> {
  let scriptStat;

  try {
    scriptStat = await stat(scriptPath);
  } catch (error) {
    throw new WorkspaceSetupResolutionError(
      `Workspace setup script '${scriptPath}' configured by 'workspace.setup_script' was not found.`,
      {
        source: "config",
        scriptPath,
      },
    );
  }

  if (!scriptStat.isFile()) {
    throw new WorkspaceSetupResolutionError(
      `Workspace setup script '${scriptPath}' configured by 'workspace.setup_script' must point to a file.`,
      {
        source: "config",
        scriptPath,
      },
    );
  }

  return {
    source: "config",
    scriptPath,
  };
}

async function resolveCodexEnvironmentSetup(
  repoRoot: string,
): Promise<WorkspaceSetupRecord | null> {
  const environmentPath = path.join(
    repoRoot,
    ".codex",
    "environments",
    "environment.toml",
  );
  let source: string;

  try {
    source = await readFile(environmentPath, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }

    throw new WorkspaceSetupResolutionError(
      `Failed to read Codex environment fallback '${environmentPath}'.`,
      {
        source: "codex_environment",
        environmentPath,
      },
    );
  }

  let parsed: unknown;
  try {
    parsed = parseToml(source);
  } catch (error) {
    throw new WorkspaceSetupResolutionError(
      `Failed to parse Codex environment fallback '${environmentPath}'.`,
      {
        source: "codex_environment",
        environmentPath,
      },
    );
  }

  const document = expectRecord(parsed, environmentPath);
  const setup = expectRecord(document.setup, `${environmentPath}.[setup]`);
  const script = setup.script;

  if (typeof script !== "string" || script.trim() === "") {
    throw new WorkspaceSetupResolutionError(
      `Codex environment fallback '${environmentPath}' must define a non-empty [setup].script string.`,
      {
        source: "codex_environment",
        environmentPath,
      },
    );
  }

  return {
    source: "codex_environment",
    environmentPath,
    script,
  };
}

function expectRecord(value: unknown, fieldPath: string): ValueRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WorkspaceSetupResolutionError(
      `Expected '${fieldPath}' to be a TOML table.`,
    );
  }

  return value as ValueRecord;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
