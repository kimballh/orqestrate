import { createServer, type Server } from "node:http";
import { type Socket } from "node:net";

import { WebhookRouter } from "./webhook-router.js";

export type WebhookListenOptions = {
  host: string;
  port: number;
};

export type WebhookServerInfo = {
  endpoint: string;
  listening: boolean;
};

export class WebhookServer {
  #server: Server | null = null;
  readonly #connections = new Set<Socket>();
  #info: WebhookServerInfo;

  constructor(
    private readonly router: WebhookRouter,
    private readonly listenOptions: WebhookListenOptions,
  ) {
    this.#info = {
      endpoint: formatEndpoint(listenOptions),
      listening: false,
    };
  }

  get info(): WebhookServerInfo {
    return this.#info;
  }

  async start(): Promise<void> {
    if (this.#server !== null) {
      return;
    }

    const server = createServer((request, response) => {
      void this.router.handle(request, response);
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
      server.listen(this.listenOptions.port, this.listenOptions.host, resolve);
    });

    this.#server = server;
    const address = server.address();
    this.#info = {
      endpoint:
        address !== null && typeof address !== "string"
          ? `http://${address.address}:${address.port}`
          : formatEndpoint(this.listenOptions),
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

    this.#info = {
      endpoint: formatEndpoint(this.listenOptions),
      listening: false,
    };
  }
}

function formatEndpoint(listenOptions: WebhookListenOptions): string {
  return `http://${listenOptions.host}:${listenOptions.port}`;
}
