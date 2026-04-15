import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPullRequestMatchesLinkedScope,
  requireGrantedCapability,
  requireLinkedPullRequest,
  requireRepoWriteScope,
} from "./permission-gate.js";

test("requireGrantedCapability rejects missing capability grants", () => {
  assert.throws(
    () =>
      requireGrantedCapability(
        createRun({
          grantedCapabilities: ["github.read_pr"],
        }),
        "github.write_review",
      ),
    /github.write_review/,
  );
});

test("requireLinkedPullRequest returns the linked pull request scope", () => {
  const pullRequest = requireLinkedPullRequest(
    createRun({
      workspace: {
        pullRequestUrl: "https://github.com/kimballh/orqestrate/pull/42",
      },
    }),
  );

  assert.equal(pullRequest.number, 42);
  assert.equal(pullRequest.repo, "orqestrate");
});

test("requireRepoWriteScope enforces repo write access", () => {
  assert.throws(
    () =>
      requireRepoWriteScope(
        createRun({
          workspace: {
            writeScope: null,
          },
        }),
      ),
    /write scope/i,
  );
});

test("assertPullRequestMatchesLinkedScope rejects mismatched pull requests", () => {
  assert.throws(
    () =>
      assertPullRequestMatchesLinkedScope(
        {
          owner: "kimballh",
          repo: "orqestrate",
          number: 42,
          url: "https://github.com/kimballh/orqestrate/pull/42",
        },
        {
          owner: "kimballh",
          repo: "orqestrate",
          number: 43,
          url: "https://github.com/kimballh/orqestrate/pull/43",
        },
      ),
    /outside the linked pull request scope/i,
  );
});

function createRun(overrides: {
  grantedCapabilities?: string[];
  workspace?: {
    pullRequestUrl?: string | null;
    writeScope?: string | null;
  };
} = {}) {
  return {
    runId: "run-001",
    grantedCapabilities: overrides.grantedCapabilities ?? [],
    workspace: {
      repoRoot: "/repo",
      mode: "ephemeral_worktree",
      pullRequestUrl:
        overrides.workspace?.pullRequestUrl !== undefined
          ? overrides.workspace.pullRequestUrl
          : "https://github.com/kimballh/orqestrate/pull/42",
      writeScope:
        overrides.workspace?.writeScope !== undefined
          ? overrides.workspace.writeScope
          : "repo",
    },
  } as never;
}
