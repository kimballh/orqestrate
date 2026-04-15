# Prompt Customization

This document defines how users should override and enhance agent prompts in Orqestrate.

The goal is:

- users can customize role behavior deeply
- base prompts remain reusable and upgradable
- prompt experiments do not require forking the whole system
- organizations can add their own review heuristics, skills, and workflows

## 1. Main recommendation

Do not make prompt customization a single raw string override.

Use layered prompt composition with explicit override points.

Recommended layers:

1. `base system prompt`
2. `role prompt`
3. `phase prompt`
4. `organization overlay`
5. `project overlay`
6. `run-specific additions`
7. `experiment variant overlay`

That gives users control without forcing them to replace everything.

## 2. Why layering is better than replacement

If prompt customization is only:

- `replace the reviewer prompt with your own markdown`

then several problems appear:

- base improvements are lost
- users copy stale prompt text
- one small customization requires duplicating a large prompt
- prompt behavior drifts unpredictably across repos

Layering avoids that by letting users say:

- keep the base reviewer prompt
- add our QA-specific review checklist
- add our Playwright/browser validation steps
- enable an experiment variant for this repo

## 3. Prompt composition model

Recommended composition order:

```text
final_prompt =
  base_system_prompt
  + hard_invariants
  + role_prompt
  + phase_prompt
  + capability_fragments
  + organization_overlay
  + project_overlay
  + run_specific_context
  + experiment_variant
```

Important rule:

- later layers may add or tighten behavior
- later layers should not silently contradict core safety or authority rules

That means prompt customization is extensible, not anarchic.

## 4. What users should be able to customize

Users should be able to customize:

- role behavior
- checklists
- required tools and skills
- formatting expectations
- project-specific heuristics
- domain-specific workflows
- review focus areas
- test expectations
- experiment variants

Examples:

- “reviewer must use Playwright for changed user flows”
- “reviewer must compare current screenshots to baseline screenshots”
- “implementation agent must check migration safety before schema changes”
- “review agent must review PR comments and unresolved threads before local inspection”

## 5. What users should not override casually

Do not make these fully optional by prompt override:

- global authority boundaries
- runtime cancellation behavior
- claim/lease ownership
- workflow state ownership
- provider credential rules

These are system invariants, not style preferences.

If someone wants to change those, that should be a code/config-level change, not a prompt snippet.

## 6. File layout recommendation

Recommended repo-level layout:

```text
orqestrate/
  prompts/
    base/
      system.md
    roles/
      implement.md
      review.md
      design.md
      plan.md
      merge.md
    phases/
      implement.md
      review.md
    capabilities/
      github-review.md
      github-reply.md
      playwright-exploration.md
      user-journey-comparison.md
    overlays/
      org/
        reviewer-qa.md
      project/
        reviewer-webapp.md
        implement-migrations.md
    experiments/
      reviewer-v2.md
      reviewer-playwright-heavy.md
```

This keeps prompt assets organized by purpose instead of shoving everything into one directory.

## 7. Config-driven prompt selection

Prompt selection should be driven by config, not hardcoded in the orchestrator.

Recommended additions to `config.toml`:

```toml
[prompts]
root = "./prompts"
active_pack = "default"
invariants = [
  "invariants/run-scope.md",
  "invariants/authority-boundaries.md",
  "invariants/verification.md",
  "invariants/blockers.md",
]

[prompt_capabilities.github_review]
authority = "execution_surface_read"
allowed_phases = ["review"]
required_context = ["pull_request_url"]

[prompt_capabilities.github_reply]
authority = "execution_surface_write"
allowed_phases = ["implement", "review"]
required_context = ["pull_request_url"]

[prompt_capabilities.playwright_exploration]
authority = "behavioral"
allowed_phases = ["implement", "review"]

[prompt_capabilities.user_journey_comparison]
authority = "behavioral"
allowed_phases = ["review"]
requires = ["playwright_exploration"]

[prompt_packs.default]
base_system = "base/system.md"

[prompt_packs.default.roles]
design = "roles/design.md"
plan = "roles/plan.md"
implement = "roles/implement.md"
review = "roles/review.md"
merge = "roles/merge.md"

[prompt_packs.default.phases]
implement = "phases/implement.md"
review = "phases/review.md"

[prompt_packs.default.capabilities]
github_review = "capabilities/github-review.md"
github_reply = "capabilities/github-reply.md"
playwright_exploration = "capabilities/playwright-exploration.md"
user_journey_comparison = "capabilities/user-journey-comparison.md"

[prompt_packs.default.overlays.organization]
reviewer_qa = "overlays/org/reviewer-qa.md"

[prompt_packs.default.overlays.project]
reviewer_webapp = "overlays/project/reviewer-webapp.md"

[prompt_packs.default.experiments]
reviewer_v2 = "experiments/reviewer-v2.md"
reviewer_playwright_heavy = "experiments/reviewer-playwright-heavy.md"

[profiles.saas]
planning = "linear_main"
context = "notion_main"
prompt_pack = "default"

[profiles.saas.prompt]
organization_overlays = ["reviewer_qa"]
project_overlays = ["reviewer_webapp"]
default_experiment = "reviewer_v2"
```

This gives users a stable way to swap prompt assets without code edits while keeping overlay and default-experiment choice profile-owned.

## 8. Run-time prompt assembly

At run creation time, the orchestrator should assemble the final prompt from:

- role
- phase
- authorized capabilities
- configured organization and project overlays
- run-specific additions
- optional experiment variant

Recommended assembly input:

```ts
type PromptAssemblyRequest = {
  promptPackName?: string;
  role: "design" | "plan" | "implement" | "review" | "merge";
  phase: "design" | "plan" | "implement" | "review" | "merge";
  capabilities?: string[];
  experiment?: string | null;
  runAdditions?: Array<{
    label: string;
    markdown: string;
  }>;
  context: AgentRunContext;
};
```

Recommended output:

```ts
type PromptAssemblyResult = {
  prompt: {
    contractId: string;
    systemPrompt: string;
    userPrompt: string;
    attachments: PromptAttachment[];
    sources: Array<{
      kind:
        | "base_pack"
        | "invariant"
        | "role_prompt"
        | "phase_prompt"
        | "capability"
        | "overlay"
        | "experiment"
        | "artifact"
        | "operator_note"
        | "system_generated";
      ref: string;
    }>;
    digests: {
      system: string;
      user: string;
    };
  };
  provenance: {
    selection: {
      promptPackName: string;
      capabilityNames: string[];
      organizationOverlayNames: string[];
      projectOverlayNames: string[];
      experimentName?: string | null;
    };
    sources: Array<{
      kind: PromptSourceKind;
      ref: string;
      digest: string;
    }>;
    rendered: {
      systemPromptLength: number;
      userPromptLength: number;
      attachmentKinds: PromptAttachmentKind[];
      attachmentCount: number;
    };
  };
  resolvedLayers: Array<{
    kind: PromptSourceKind;
    ref: string;
    path?: string;
    digest: string;
  }>;
};
```

The `sources` list matters for traceability and debugging, and the public refs should stay symbolic so they can be persisted safely across machines and workspaces.
The separate `provenance` object is the canonical run-facing summary: it preserves source digests and selection metadata without exposing raw prompt bodies or attachment values.

## 9. Capability fragments

The best way to express optional behaviors like Playwright exploration is with capability fragments, not entirely new role prompts.

Examples:

### 9.1 `playwright-exploration.md`

```text
If browser-facing functionality changed and Playwright is available, inspect the changed flows in a real browser session before concluding review.

Focus on:
- obvious interaction regressions
- broken navigation or state transitions
- console or network failures that materially affect the flow

If Playwright is not available or the flow cannot be exercised locally, state that explicitly in the review output.
```

### 9.2 `user-journey-comparison.md`

```text
For user-facing flows touched by this change, compare the implemented behavior against the expected user journey from the task context or artifact.

Look for:
- missing steps
- broken handoffs between screens
- behavior that is technically functional but no longer matches the intended journey
```

This keeps prompt customization modular and composable.

## 10. Reviewer customization example

A team that wants a stronger QA-style reviewer might configure:

- base reviewer role prompt
- `github_review` capability
- `playwright_exploration` capability
- `user_journey_comparison` capability
- project overlay with app-specific expectations

That gives them a stronger reviewer without rewriting the entire reviewer role.

## 11. Prompt testing model

Prompt customization is only useful if users can test it.

Recommended testing modes:

### 11.1 Dry-run assembly

Users should be able to ask the system:

- “show me the final prompt for the reviewer in this profile”

Suggested CLI:

```text
orq prompt render --role review --phase review --profile local
```

This should print:

- final assembled prompt
- source fragments used
- prompt digest

Useful preview options now supported:

```text
orq prompt render \
  --role review \
  --phase review \
  --profile saas \
  --context-file ./fixtures/review-context.json \
  --organization-overlay reviewer_qa \
  --project-overlay reviewer_webapp \
  --no-experiment
```

Notes:

- if `--context-file` is omitted, the CLI renders against a synthetic `Prompt Preview` work item so contributors can inspect prompts without instrumenting the runtime
- explicit overlay flags replace that overlay group for the preview render
- `--format json` returns the resolved selection, prompt envelope, and resolved layers for scripting

### 11.2 Variant comparison

Users should be able to compare prompt variants:

```text
orq prompt diff --role review --phase review --variant-experiment reviewer_v2
```

This should show:

- what text changed
- what fragment sources differ

The shipped diff surface also supports comparing profile defaults and preview inputs:

```text
orq prompt diff \
  --role review \
  --phase review \
  --profile saas \
  --variant-profile hybrid \
  --variant-no-experiment \
  --variant-context-file ./fixtures/review-context.json
```

The text output reports:

- left and right selection summaries
- contract ids and prompt digests
- source refs that were added, removed, or changed
- unified diffs for `systemPrompt` and `userPrompt`

### 11.3 Replay test

Users should be able to replay a past run context against a prompt variant:

```text
orq prompt replay --run-id run-123 --experiment reviewer_playwright_heavy
```

This is still a future workflow. ORQ-45 ships `render` and `diff` plus optional JSON preview context files; historical replay remains a later ticket so prompt iteration can land now without coupling to persisted run records.

### 11.4 Fixture-based tests

The repo should support prompt test fixtures:

```text
tests/
  prompts/
    review/
      unresolved-pr-comments.json
      webapp-flow-change.json
```

These can be used to validate:

- prompt assembly
- expected fragments included
- prompt length stays within budget
- required instructions are present

## 12. Invariants for prompt overrides

Even with prompt customization, some instructions should always be injected by the system and should not be removable by user overlays.

Examples:

- the agent is scoped to one run
- the agent must not mutate global workflow state unless explicitly authorized
- the agent must return structured result data
- the agent must report blockers explicitly

These should be treated as hard prompt invariants.

## 13. Soft vs hard prompt sections

Recommended classification:

### Hard sections

System-enforced, always included:

- run scope
- authority boundaries
- result contract
- cancellation/blocker behavior

### Soft sections

User-overridable or additive:

- review checklists
- domain heuristics
- tool preferences
- style/verbosity preferences
- extra testing guidance

This split keeps the system flexible without breaking core control-plane assumptions.

## 14. Experiment support

Prompt experiments should be first-class.

Recommended model:

- prompt packs define named experiments
- profiles may select a default experiment from the chosen prompt pack
- a run may optionally specify an experiment name
- `experiment = null` explicitly disables the profile default for replay or testing
- experiment prompts are appended late in the composition chain
- the runtime stores the final prompt digest plus safe prompt provenance on the canonical run record

That gives us:

- reproducibility
- A/B testing
- per-project prompt tuning

without hidden prompt drift.

## 15. Recommendation

For v1, I would implement prompt customization this way:

1. layered prompt composition
2. file-based prompt fragments under `prompts/`
3. config-driven prompt pack selection
4. capability fragments for optional behaviors like Playwright exploration
5. hard system invariants that users cannot silently remove
6. prompt render/diff/replay tooling for testing

That gives users real control over reviewer and implementer behavior without turning prompt management into a fork-and-pray system.
