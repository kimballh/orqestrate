import type { IncomingMessage, ServerResponse } from "node:http";

import type { IncomingHttpHeaders } from "node:http";

import { normalizeLinearWebhookEvent } from "../providers/planning/linear/webhook-normalizer.js";
import { verifyLinearWebhook } from "../providers/planning/linear/webhook-signature.js";

import { WakeupRepository } from "./wakeup-repository.js";

type WebhookRouterOptions = {
  repository: WakeupRepository;
  linearSigningSecret: string;
  webhookPath?: string;
  now?: () => Date;
};

export class WebhookRouter {
  private readonly webhookPath: string;
  private readonly now: () => Date;

  constructor(private readonly options: WebhookRouterOptions) {
    this.webhookPath = options.webhookPath ?? "/v1/webhooks/linear";
    this.now = options.now ?? (() => new Date());
  }

  async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://webhook.local");

    if (request.method !== "POST" || url.pathname !== this.webhookPath) {
      this.writeJson(response, 404, {
        error: {
          code: "not_found",
          message: "Webhook route not found.",
        },
      });
      return;
    }

    const rawBody = await readRawBody(request);
    const rawBodyText = rawBody.toString("utf8");
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(rawBodyText) as Record<string, unknown>;
    } catch {
      this.writeJson(response, 400, {
        error: {
          code: "invalid_json",
          message: "Webhook payload must be valid JSON.",
        },
      });
      return;
    }

    const verification = verifyLinearWebhook({
      rawBody,
      signature: readHeader(request.headers, "linear-signature"),
      signingSecret: this.options.linearSigningSecret,
      webhookTimestamp:
        typeof payload.webhookTimestamp === "number"
          ? payload.webhookTimestamp
          : null,
      now: this.now,
    });

    if (!verification.ok) {
      this.writeJson(response, 401, {
        error: {
          code: verification.reason,
          message: verification.message,
        },
      });
      return;
    }

    try {
      this.options.repository.enqueue(
        normalizeLinearWebhookEvent({
          headers: request.headers,
          payload,
          receivedAt: this.now().toISOString(),
          payloadJson: rawBodyText,
        }),
      );
    } catch (error) {
      this.writeJson(response, 400, {
        error: {
          code: "invalid_payload",
          message:
            error instanceof Error ? error.message : "Webhook payload is not supported.",
        },
      });
      return;
    }

    this.writeJson(response, 200, { accepted: true });
  }

  private writeJson(
    response: ServerResponse,
    statusCode: number,
    body: unknown,
  ): void {
    const serialized = JSON.stringify(body);
    response.statusCode = statusCode;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", String(Buffer.byteLength(serialized)));
    response.end(serialized);
  }
}

async function readRawBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}

function readHeader(
  headers: IncomingHttpHeaders,
  name: string,
): string | null {
  const value = headers[name];

  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }

  if (Array.isArray(value) && value[0] !== undefined && value[0].trim().length > 0) {
    return value[0].trim();
  }

  return null;
}
