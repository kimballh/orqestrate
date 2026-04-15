import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";

import type { RuntimeConfig } from "../config.js";
import type { RuntimeDaemon } from "../daemon.js";
import { RuntimeApiRouter } from "./router.js";
import type { RuntimeApiListenOptions, RuntimeApiServerInfo } from "./types.js";

export class RuntimeApiServer {
  #server: Server | null = null;
  readonly #connections = new Set<Socket>();
  readonly #router: RuntimeApiRouter;
  readonly #listenOptions: RuntimeApiListenOptions;
  #serverInfo: RuntimeApiServerInfo;

  constructor(
    daemon: RuntimeDaemon,
    listenOptions: RuntimeApiListenOptions,
  ) {
    this.#listenOptions = listenOptions;
    this.#router = new RuntimeApiRouter(daemon, () => this.isListening);
    this.#serverInfo = {
      endpoint: formatRuntimeApiEndpoint(listenOptions),
      listening: false,
    };
  }

  get isListening(): boolean {
    return this.#serverInfo.listening;
  }

  get info(): RuntimeApiServerInfo {
    return this.#serverInfo;
  }

  async start(): Promise<void> {
    if (this.#server !== null) {
      return;
    }

    if (this.#listenOptions.kind === "socket") {
      mkdirSync(path.dirname(this.#listenOptions.socketPath), { recursive: true });
      await ensureSocketPathAvailable(this.#listenOptions.socketPath);
    }

    const server = createServer((request, response) => {
      void this.#router.handle(request, response);
    });
    server.on("connection", (connection) => {
      connection.unref();
      this.#connections.add(connection);
      connection.on("close", () => {
        this.#connections.delete(connection);
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);

      switch (this.#listenOptions.kind) {
        case "socket":
          server.listen(this.#listenOptions.socketPath, resolve);
          break;
        case "pipe":
          server.listen(this.#listenOptions.pipeName, resolve);
          break;
        case "tcp":
          server.listen(
            this.#listenOptions.port,
            this.#listenOptions.host,
            resolve,
          );
          break;
      }
    });

    this.#server = server;
    this.#serverInfo = {
      endpoint: resolveListeningEndpoint(server, this.#listenOptions),
      listening: true,
    };
  }

  async stop(): Promise<void> {
    if (this.#server === null) {
      return;
    }

    const server = this.#server;
    this.#server = null;

    for (const connection of this.#connections) {
      connection.destroy();
    }
    this.#connections.clear();

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    if (
      this.#listenOptions.kind === "socket" &&
      existsSync(this.#listenOptions.socketPath)
    ) {
      rmSync(this.#listenOptions.socketPath, { force: true });
    }

    this.#serverInfo = {
      endpoint: formatRuntimeApiEndpoint(this.#listenOptions),
      listening: false,
    };
  }
}

export function resolveRuntimeApiListenOptions(
  runtimeConfig: RuntimeConfig,
): RuntimeApiListenOptions {
  if (process.platform === "win32") {
    const profile = runtimeConfig.profileName.replace(/[^a-zA-Z0-9_-]/g, "-");
    return {
      kind: "pipe",
      pipeName: `\\\\.\\pipe\\orqestrate-runtime-${profile}`,
    };
  }

  return {
    kind: "socket",
    socketPath: path.join(runtimeConfig.stateDir, "sockets", "runtime.sock"),
  };
}

async function ensureSocketPathAvailable(socketPath: string): Promise<void> {
  if (existsSync(socketPath) === false) {
    return;
  }

  try {
    const socket = await connectToSocket(socketPath);
    socket.destroy();
    throw new Error(`Socket path '${socketPath}' is already in use.`);
  } catch (error) {
    if (isRecoverableStaleSocketError(error)) {
      rmSync(socketPath, { force: true });
      return;
    }

    throw error;
  }
}

export function formatRuntimeApiEndpoint(
  listenOptions: RuntimeApiListenOptions,
): string {
  switch (listenOptions.kind) {
    case "socket":
      return `unix://${listenOptions.socketPath}`;
    case "pipe":
      return `pipe://${listenOptions.pipeName}`;
    case "tcp":
      return `http://${listenOptions.host}:${listenOptions.port}`;
  }
}

function resolveListeningEndpoint(
  server: Server,
  listenOptions: RuntimeApiListenOptions,
): string {
  if (listenOptions.kind !== "tcp") {
    return formatRuntimeApiEndpoint(listenOptions);
  }

  const address = server.address();

  if (address === null || typeof address === "string") {
    return formatRuntimeApiEndpoint(listenOptions);
  }

  return `http://${address.address}:${address.port}`;
}

function connectToSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => {
      socket.destroy();
      reject(error);
    });
  });
}

function isRecoverableStaleSocketError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ECONNREFUSED" ||
      error.code === "ENOENT" ||
      error.code === "ENOTSOCK")
  );
}
