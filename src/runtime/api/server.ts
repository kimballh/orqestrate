import { createServer, type Server } from "node:http";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import type { RuntimeConfig } from "../config.js";
import type { RuntimeDaemon } from "../daemon.js";
import { RuntimeApiRouter } from "./router.js";
import type { RuntimeApiListenOptions, RuntimeApiServerInfo } from "./types.js";

export class RuntimeApiServer {
  #server: Server | null = null;
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
      endpoint: formatEndpoint(listenOptions),
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
      if (existsSync(this.#listenOptions.socketPath)) {
        rmSync(this.#listenOptions.socketPath, { force: true });
      }
    }

    const server = createServer((request, response) => {
      void this.#router.handle(request, response);
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
      endpoint: formatEndpoint(this.#listenOptions),
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

function formatEndpoint(listenOptions: RuntimeApiListenOptions): string {
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
    return formatEndpoint(listenOptions);
  }

  const address = server.address();

  if (address === null || typeof address === "string") {
    return formatEndpoint(listenOptions);
  }

  return `http://${address.address}:${address.port}`;
}
