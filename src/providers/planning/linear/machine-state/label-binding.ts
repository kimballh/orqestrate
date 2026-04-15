import type {
  OrchestrationState,
  ReviewOutcome,
  WorkPhaseOrNone,
} from "../../../../domain-model.js";

export type LinearMachineStateLabels = {
  phase: WorkPhaseOrNone | null;
  state: OrchestrationState | null;
  reviewOutcome: ReviewOutcome | null;
};

const PHASE_PREFIX = "orq:phase:";
const STATE_PREFIX = "orq:state:";
const REVIEW_PREFIX = "orq:review:";

const PHASE_VALUES = new Set<WorkPhaseOrNone>([
  "none",
  "design",
  "plan",
  "implement",
  "review",
  "merge",
]);

const STATE_VALUES = new Set<OrchestrationState>([
  "idle",
  "queued",
  "claimed",
  "running",
  "waiting_human",
  "failed",
  "completed",
]);

const REVIEW_VALUES = new Set<ReviewOutcome>([
  "none",
  "changes_requested",
  "approved",
]);

export function normalizeLinearLabelName(label: string): string {
  return label.trim().toLowerCase();
}

export function readLinearMachineStateLabels(
  labels: string[],
): LinearMachineStateLabels {
  return {
    phase: readSinglePrefixedLabel(labels, PHASE_PREFIX, PHASE_VALUES),
    state: readSinglePrefixedLabel(labels, STATE_PREFIX, STATE_VALUES),
    reviewOutcome: readSinglePrefixedLabel(labels, REVIEW_PREFIX, REVIEW_VALUES),
  };
}

export function isLinearProviderOwnedLabel(label: string): boolean {
  const normalized = normalizeLinearLabelName(label);

  return (
    normalized.startsWith(PHASE_PREFIX) ||
    normalized.startsWith(STATE_PREFIX) ||
    normalized.startsWith(REVIEW_PREFIX)
  );
}

export function buildLinearMachineStateLabelNames(input: {
  phase: WorkPhaseOrNone;
  state: OrchestrationState;
  reviewOutcome: ReviewOutcome;
}): string[] {
  return [
    `${PHASE_PREFIX}${input.phase}`,
    `${STATE_PREFIX}${input.state}`,
    `${REVIEW_PREFIX}${input.reviewOutcome}`,
  ];
}

function readSinglePrefixedLabel<TValue extends string>(
  labels: string[],
  prefix: string,
  allowedValues: Set<TValue>,
): TValue | null {
  const values = new Set<TValue>();

  for (const label of labels) {
    const normalized = normalizeLinearLabelName(label);

    if (!normalized.startsWith(prefix)) {
      continue;
    }

    const value = normalized.slice(prefix.length);

    if (!allowedValues.has(value as TValue)) {
      throw new Error(
        `Linear issue contains unsupported provider-owned label '${label}'.`,
      );
    }

    values.add(value as TValue);
  }

  if (values.size > 1) {
    throw new Error(
      `Linear issue contains conflicting provider-owned labels for '${prefix.slice(0, -1)}'.`,
    );
  }

  return values.values().next().value ?? null;
}
