import type { PromptSourceKind } from "../domain-model.js";

import type { PromptPreviewResult } from "./prompt-preview.js";

export type PromptSourceDelta = {
  ref: string;
  kind: PromptSourceKind | "mixed";
  change: "added" | "removed" | "changed" | "unchanged";
  leftDigest: string | null;
  rightDigest: string | null;
};

export type PromptTextDiff = {
  hasChanges: boolean;
  text: string;
};

export type PromptDiffResult = {
  left: PromptPreviewResult;
  right: PromptPreviewResult;
  sourceChanges: PromptSourceDelta[];
  systemPromptDiff: PromptTextDiff;
  userPromptDiff: PromptTextDiff;
};

type DiffOperation = {
  type: " " | "-" | "+";
  line: string;
};

type SourceSnapshot = {
  kind: PromptSourceKind;
  digest: string;
};

export function diffPromptPreviews(
  left: PromptPreviewResult,
  right: PromptPreviewResult,
): PromptDiffResult {
  return {
    left,
    right,
    sourceChanges: diffPromptSources(left, right),
    systemPromptDiff: renderUnifiedPromptDiff(
      "systemPrompt",
      left.prompt.systemPrompt ?? "",
      right.prompt.systemPrompt ?? "",
    ),
    userPromptDiff: renderUnifiedPromptDiff(
      "userPrompt",
      left.prompt.userPrompt,
      right.prompt.userPrompt,
    ),
  };
}

function diffPromptSources(
  left: PromptPreviewResult,
  right: PromptPreviewResult,
): PromptSourceDelta[] {
  const leftSources = new Map<string, SourceSnapshot>();
  const rightSources = new Map<string, SourceSnapshot>();
  const orderedRefs: string[] = [];

  for (const layer of left.resolvedLayers) {
    orderedRefs.push(layer.ref);
    leftSources.set(layer.ref, {
      kind: layer.kind,
      digest: layer.digest,
    });
  }

  for (const layer of right.resolvedLayers) {
    if (!leftSources.has(layer.ref)) {
      orderedRefs.push(layer.ref);
    }

    rightSources.set(layer.ref, {
      kind: layer.kind,
      digest: layer.digest,
    });
  }

  return orderedRefs.map((ref) => {
    const leftLayer = leftSources.get(ref) ?? null;
    const rightLayer = rightSources.get(ref) ?? null;

    if (leftLayer === null) {
      return {
        ref,
        kind: rightLayer?.kind ?? "mixed",
        change: "added",
        leftDigest: null,
        rightDigest: rightLayer?.digest ?? null,
      };
    }

    if (rightLayer === null) {
      return {
        ref,
        kind: leftLayer.kind,
        change: "removed",
        leftDigest: leftLayer.digest,
        rightDigest: null,
      };
    }

    return {
      ref,
      kind: leftLayer.kind === rightLayer.kind ? leftLayer.kind : "mixed",
      change: leftLayer.digest === rightLayer.digest ? "unchanged" : "changed",
      leftDigest: leftLayer.digest,
      rightDigest: rightLayer.digest,
    };
  });
}

function renderUnifiedPromptDiff(
  label: string,
  left: string,
  right: string,
): PromptTextDiff {
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);
  const operations = diffLines(leftLines, rightLines);
  const hasChanges = operations.some((operation) => operation.type !== " ");

  if (!hasChanges) {
    return {
      hasChanges: false,
      text: `No changes in ${label}.`,
    };
  }

  const output = [
    `--- left/${label}`,
    `+++ right/${label}`,
    `@@ -1,${leftLines.length} +1,${rightLines.length} @@`,
    ...operations.map((operation) => `${operation.type}${operation.line}`),
  ].join("\n");

  return {
    hasChanges: true,
    text: output,
  };
}

function splitLines(value: string): string[] {
  if (value.length === 0) {
    return [];
  }

  return value.replace(/\r\n/g, "\n").split("\n");
}

function diffLines(left: string[], right: string[]): DiffOperation[] {
  const heights = Array.from({ length: left.length + 1 }, () =>
    Array<number>(right.length + 1).fill(0),
  );

  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      heights[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? heights[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(
              heights[leftIndex + 1][rightIndex],
              heights[leftIndex][rightIndex + 1],
            );
    }
  }

  const operations: DiffOperation[] = [];
  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      operations.push({
        type: " ",
        line: left[leftIndex],
      });
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }

    if (heights[leftIndex + 1][rightIndex] >= heights[leftIndex][rightIndex + 1]) {
      operations.push({
        type: "-",
        line: left[leftIndex],
      });
      leftIndex += 1;
      continue;
    }

    operations.push({
      type: "+",
      line: right[rightIndex],
    });
    rightIndex += 1;
  }

  while (leftIndex < left.length) {
    operations.push({
      type: "-",
      line: left[leftIndex],
    });
    leftIndex += 1;
  }

  while (rightIndex < right.length) {
    operations.push({
      type: "+",
      line: right[rightIndex],
    });
    rightIndex += 1;
  }

  return operations;
}
