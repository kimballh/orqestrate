# Quality Policy

This document defines the quality bar Orqestrate agents should follow locally today and what we intend to enforce automatically in CI over time.

## 1. Purpose

The goal is simple:

- agents should not treat implementation as complete until verification is real
- reviewers should flag missing tests and weak verification early
- CI should mirror the same checks agents are expected to run locally

This keeps "done" consistent across local runs, human review, and future automation.

## 2. Current baseline

The repository is still in an early scaffold stage, so the current enforced baseline is intentionally small:

- `npm run typecheck`
- `npm run build`
- `npm run test`
- `npm run check`

At the moment, `npm run check` is the canonical aggregate command and expands to:

- `npm run typecheck`
- `npm run build`
- `npm run test`

As the codebase grows, this command should remain the single CI entrypoint and expand to include linting, tests, and any other required checks.

## 3. Agent requirements

### 3.1 Plan

Every implementation plan should include:

- expected code changes
- expected verification steps
- automated test impact
- known verification gaps or areas that still require manual evidence

If a change is likely to affect behavior, the plan should say whether:

- an existing test should be updated
- a new test should be added
- automated coverage is not practical yet and why

### 3.2 Implement

Implementation agents must:

- run the required repo checks that exist at the time of the run
- run the strongest practical targeted verification for the change
- add or update automated tests when behavior changes, unless that is not practical yet
- report verification evidence explicitly

Behavior change means any change that alters:

- runtime behavior
- serialization or API behavior
- configuration resolution
- provider behavior
- orchestration logic
- persistence behavior

When automated coverage is not added, the implementation result must explain:

- why coverage was not added
- what was verified instead
- what residual risk remains

### 3.3 Review

Review agents should treat these as first-class findings:

- missing automated coverage for behavior-changing work
- stale tests that no longer match behavior
- verification commands that are too weak for the risk level of the change
- claims of completion without evidence

Review should prioritize:

- correctness
- regression risk
- missing tests
- verification gaps

before lower-signal style concerns.

## 4. Current enforcement model

Today:

- agents are expected to run local verification
- humans enforce quality by reviewing summaries and artifacts
- CI enforces the current baseline check command

Soon:

- more repo scripts should be added as the codebase grows
- CI should stay aligned to those scripts, not duplicate their logic inline
- pull request protections should require the CI workflow to pass before merge

## 5. GitHub Actions policy

GitHub Actions should mirror the local policy rather than invent a separate one.

Current rule:

- the default workflow runs `npm ci`
- then runs `npm run check`

Future rule:

- keep `npm run check` as the aggregate CI entrypoint
- add `lint`, `test`, integration checks, or contract checks under that script as the repo matures

This reduces drift between:

- what agents do locally
- what developers do locally
- what GitHub enforces

## 6. Evolution path

Expected next additions once implementation starts landing:

1. `npm test` for unit and contract coverage
2. targeted integration scripts for local-files and SaaS-backed provider flows
3. lint or formatting validation if we decide the signal is worth the friction
4. PR-required checks in GitHub branch protection

When those exist, update:

- `package.json`
- this policy
- the implementation and review prompts
- the CI workflow

in the same change whenever possible.

## 7. Practical definition of done

A change is not done just because the code compiles.

For Orqestrate, done should mean:

- the change is implemented
- the strongest practical verification has been run
- automated coverage was added or the gap was explained
- the result summary names remaining risks honestly

That is the standard agents should follow now, even before the full CI and testing stack exists.
