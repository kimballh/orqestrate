import path from "node:path";
import { fileURLToPath } from "node:url";

import type {
  PromptCapabilityDefinition,
  PromptPackConfig,
  PromptsConfig,
} from "./types.js";

const BUILTIN_PROMPT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/prompts",
);

function resolveBuiltinPromptAsset(...segments: string[]): string {
  return path.join(BUILTIN_PROMPT_ROOT, ...segments);
}

export function createBuiltinPromptsConfig(
  localOverrideRoot: string,
): PromptsConfig {
  return {
    root: BUILTIN_PROMPT_ROOT,
    invariantRoot: BUILTIN_PROMPT_ROOT,
    activePack: "default",
    invariants: [
      resolveBuiltinPromptAsset("invariants", "run-scope.md"),
      resolveBuiltinPromptAsset("invariants", "authority-boundaries.md"),
      resolveBuiltinPromptAsset("invariants", "verification.md"),
      resolveBuiltinPromptAsset("invariants", "blockers.md"),
    ],
    localOverrideRoot,
  };
}

export function createBuiltinPromptCapabilities(): Record<
  string,
  PromptCapabilityDefinition
> {
  return {
    "github.read_pr": {
      authority: "execution_surface_read",
      provider: "github",
      surface: "pull_request",
      effect: "read",
      targetScope: "linked_pull_request",
      allowedPhases: ["implement", "review", "merge"],
      allowedRoles: ["implement", "review", "merge"],
      requiredContext: ["pull_request_url"],
      requires: [],
      conflictsWith: [],
    },
    "github.push_branch": {
      authority: "execution_surface_write",
      provider: "github",
      surface: "branch",
      effect: "write",
      targetScope: "assigned_branch",
      allowedPhases: ["implement"],
      allowedRoles: ["implement"],
      requiredContext: ["assigned_branch", "write_scope"],
      requires: [],
      conflictsWith: [],
    },
    "github.create_pr": {
      authority: "execution_surface_write",
      provider: "github",
      surface: "pull_request",
      effect: "write",
      targetScope: "pull_request_for_assigned_branch",
      allowedPhases: ["implement"],
      allowedRoles: ["implement"],
      requiredContext: ["assigned_branch", "write_scope"],
      requires: [],
      conflictsWith: [],
    },
    "github.reply_review_thread": {
      authority: "execution_surface_write",
      provider: "github",
      surface: "review_thread",
      effect: "write",
      targetScope: "linked_pull_request",
      allowedPhases: ["implement"],
      allowedRoles: ["implement"],
      requiredContext: ["pull_request_url", "write_scope"],
      requires: [],
      conflictsWith: [],
    },
    "github.resolve_review_thread": {
      authority: "execution_surface_write",
      provider: "github",
      surface: "review_thread",
      effect: "state_transition",
      targetScope: "linked_pull_request",
      allowedPhases: ["implement"],
      allowedRoles: ["implement"],
      requiredContext: ["pull_request_url", "write_scope"],
      requires: [],
      conflictsWith: [],
    },
    "github.write_review": {
      authority: "execution_surface_write",
      provider: "github",
      surface: "review_submission",
      effect: "write",
      targetScope: "linked_pull_request",
      allowedPhases: ["review"],
      allowedRoles: ["review"],
      requiredContext: ["pull_request_url", "write_scope"],
      requires: [],
      conflictsWith: [],
    },
    "github.merge_pr": {
      authority: "execution_surface_write",
      provider: "github",
      surface: "merge",
      effect: "state_transition",
      targetScope: "linked_pull_request",
      allowedPhases: ["merge"],
      allowedRoles: ["merge"],
      requiredContext: ["pull_request_url", "write_scope"],
      requires: [],
      conflictsWith: [],
    },
    playwright_exploration: {
      authority: "behavioral",
      allowedPhases: ["implement", "review"],
      allowedRoles: [],
      requiredContext: [],
      requires: [],
      conflictsWith: [],
    },
    user_journey_comparison: {
      authority: "behavioral",
      allowedPhases: ["review"],
      allowedRoles: [],
      requiredContext: [],
      requires: ["playwright_exploration"],
      conflictsWith: [],
    },
  };
}

export function createBuiltinPromptPacks(): Record<string, PromptPackConfig> {
  return {
    default: {
      name: "default",
      root: BUILTIN_PROMPT_ROOT,
      baseSystem: resolveBuiltinPromptAsset("base", "system.md"),
      roles: {
        design: resolveBuiltinPromptAsset("roles", "design.md"),
        plan: resolveBuiltinPromptAsset("roles", "plan.md"),
        implement: resolveBuiltinPromptAsset("roles", "implement.md"),
        review: resolveBuiltinPromptAsset("roles", "review.md"),
        merge: resolveBuiltinPromptAsset("roles", "merge.md"),
      },
      phases: {
        implement: resolveBuiltinPromptAsset("phases", "implement.md"),
        review: resolveBuiltinPromptAsset("phases", "review.md"),
      },
      capabilities: {
        "github.read_pr": resolveBuiltinPromptAsset(
          "capabilities",
          "github-read-pr.md",
        ),
        "github.push_branch": resolveBuiltinPromptAsset(
          "capabilities",
          "github-push-branch.md",
        ),
        "github.create_pr": resolveBuiltinPromptAsset(
          "capabilities",
          "github-create-pr.md",
        ),
        "github.reply_review_thread": resolveBuiltinPromptAsset(
          "capabilities",
          "github-reply-review-thread.md",
        ),
        "github.resolve_review_thread": resolveBuiltinPromptAsset(
          "capabilities",
          "github-resolve-review-thread.md",
        ),
        "github.write_review": resolveBuiltinPromptAsset(
          "capabilities",
          "github-write-review.md",
        ),
        "github.merge_pr": resolveBuiltinPromptAsset(
          "capabilities",
          "github-merge-pr.md",
        ),
        playwright_exploration: resolveBuiltinPromptAsset(
          "capabilities",
          "playwright-exploration.md",
        ),
        user_journey_comparison: resolveBuiltinPromptAsset(
          "capabilities",
          "user-journey-comparison.md",
        ),
      },
      overlays: {
        organization: {
          reviewer_qa: resolveBuiltinPromptAsset(
            "overlays",
            "org",
            "reviewer-qa.md",
          ),
        },
        project: {
          reviewer_webapp: resolveBuiltinPromptAsset(
            "overlays",
            "project",
            "reviewer-webapp.md",
          ),
        },
      },
      experiments: {
        reviewer_v2: resolveBuiltinPromptAsset(
          "experiments",
          "reviewer-v2.md",
        ),
        reviewer_playwright_heavy: resolveBuiltinPromptAsset(
          "experiments",
          "reviewer-playwright-heavy.md",
        ),
      },
    },
  };
}
