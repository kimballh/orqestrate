import { createHmac, timingSafeEqual } from "node:crypto";

export type VerifyLinearWebhookInput = {
  rawBody: Buffer;
  signature: string | null;
  signingSecret: string;
  webhookTimestamp: number | null;
  now?: () => Date;
  maxSkewMs?: number;
};

export type VerifyLinearWebhookResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      reason: "missing_signature" | "invalid_signature" | "stale_timestamp";
      message: string;
    };

export function verifyLinearWebhook(
  input: VerifyLinearWebhookInput,
): VerifyLinearWebhookResult {
  if (input.signature === null || input.signature.trim().length === 0) {
    return {
      ok: false,
      reason: "missing_signature",
      message: "Linear webhook signature is missing.",
    };
  }

  const signature = decodeSignature(input.signature);
  if (signature === null) {
    return {
      ok: false,
      reason: "invalid_signature",
      message: "Linear webhook signature is invalid.",
    };
  }

  const computedSignature = createHmac("sha256", input.signingSecret)
    .update(input.rawBody)
    .digest();

  if (
    signature.length !== computedSignature.length ||
    timingSafeEqual(signature, computedSignature) === false
  ) {
    return {
      ok: false,
      reason: "invalid_signature",
      message: "Linear webhook signature is invalid.",
    };
  }

  if (input.webhookTimestamp !== null) {
    const now = input.now ?? (() => new Date());
    const maxSkewMs = input.maxSkewMs ?? 60_000;

    if (Math.abs(now().getTime() - input.webhookTimestamp) > maxSkewMs) {
      return {
        ok: false,
        reason: "stale_timestamp",
        message: "Linear webhook timestamp is outside the accepted replay window.",
      };
    }
  }

  return { ok: true };
}

function decodeSignature(signature: string): Buffer | null {
  const normalized = signature.trim().toLowerCase();

  if (!/^[0-9a-f]+$/.test(normalized) || normalized.length % 2 !== 0) {
    return null;
  }

  try {
    return Buffer.from(normalized, "hex");
  } catch {
    return null;
  }
}
