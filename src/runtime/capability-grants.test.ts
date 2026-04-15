import assert from "node:assert/strict";
import test from "node:test";

import {
  hasGrantedCapability,
  listMissingGrantedCapabilities,
} from "./capability-grants.js";

test("reports granted capabilities for a run contract", () => {
  const run = {
    grantedCapabilities: [
      "github.read_pr",
      "github.create_pr",
      "playwright_exploration",
    ],
  };

  assert.equal(hasGrantedCapability(run, "github.read_pr"), true);
  assert.equal(hasGrantedCapability(run, "github.push_branch"), false);
  assert.deepEqual(
    listMissingGrantedCapabilities(run, [
      "github.read_pr",
      "github.push_branch",
      "github.create_pr",
    ]),
    ["github.push_branch"],
  );
});
