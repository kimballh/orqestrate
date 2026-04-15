import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeBranchName,
  parseGitRemoteUrl,
  parsePullRequestUrl,
} from "./scope.js";

test("parsePullRequestUrl extracts GitHub repo and number", () => {
  assert.deepEqual(
    parsePullRequestUrl("https://github.com/kimballh/orqestrate/pull/42"),
    {
      owner: "kimballh",
      repo: "orqestrate",
      number: 42,
      url: "https://github.com/kimballh/orqestrate/pull/42",
    },
  );
});

test("parseGitRemoteUrl supports https and ssh GitHub remotes", () => {
  assert.deepEqual(parseGitRemoteUrl("https://github.com/kimballh/orqestrate.git"), {
    owner: "kimballh",
    repo: "orqestrate",
  });
  assert.deepEqual(parseGitRemoteUrl("git@github.com:kimballh/orqestrate.git"), {
    owner: "kimballh",
    repo: "orqestrate",
  });
});

test("normalizeBranchName removes refs prefix", () => {
  assert.equal(
    normalizeBranchName("refs/heads/hillkimball/orq-42"),
    "hillkimball/orq-42",
  );
});
