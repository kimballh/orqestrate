import assert from "node:assert/strict";
import test from "node:test";

import { NodePtySessionSupervisor } from "./supervisor/node-pty-session-supervisor.js";

test("node PTY supervisor captures output, snapshots recent output, and interrupts the session", async (t) => {
  const supervisor = new NodePtySessionSupervisor();
  const outputs: string[] = [];
  let exitCode: number | null = null;

  let handle;

  try {
    handle = await supervisor.launch(
      {
        command: "/bin/sh",
        args: [
          "-lc",
          [
            "printf 'boot\\n';",
            "trap \"printf 'interrupted\\n'; exit 130\" INT;",
            "while IFS= read -r line; do",
            "  if [ \"$line\" = 'ping' ]; then",
            "    printf 'pong\\n';",
            "  fi;",
            "done",
          ].join(" "),
        ],
        env: {},
        cwd: "/tmp",
      },
      {
        runId: "run-001",
        onOutput: ({ chunk }) => {
          outputs.push(chunk);
        },
        onExit: (event) => {
          exitCode = event.exitCode;
        },
      },
    );
  } catch (error) {
    if (error instanceof Error && error.message.includes("posix_spawnp failed")) {
      t.skip("PTY spawn is unavailable in this test environment.");
      return;
    }

    throw error;
  }

  await waitForCondition(() => outputs.join("").includes("boot"));
  await supervisor.write(handle.sessionId, "ping\n");
  await waitForCondition(() => outputs.join("").includes("pong"));

  const snapshot = await supervisor.snapshot(handle.sessionId);
  const recentOutput = await supervisor.readRecentOutput(handle.sessionId, 32);

  assert.equal(snapshot.runId, "run-001");
  assert.equal(snapshot.isAlive, true);
  assert.match(recentOutput, /pong/);

  await supervisor.interrupt(handle.sessionId);
  await waitForCondition(() => exitCode !== null);
  assert.equal(exitCode, 130);

  await supervisor.terminate(handle.sessionId, true);
});

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
