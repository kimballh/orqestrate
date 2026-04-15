import type {
  GitHubPullRequestReadResult,
  GitHubPullRequestThread,
  GitHubPullRequestThreadComment,
} from "./client.js";

const REVIEW_LOOP_MARKER_PREFIX = "orqestrate:review-loop";
const REVIEW_LOOP_MARKER_PATTERN =
  /<!--\s*orqestrate:review-loop\s+({[\s\S]*?})\s*-->/g;

export type PullRequestReviewLoopRole = "implement" | "review";

export type PullRequestReviewLoopMarker = {
  runId: string;
  phase: "implement" | "review";
  role: PullRequestReviewLoopRole;
  threadId?: string | null;
};

export type PullRequestReviewLoopThreadAction =
  | "implementer_action_required"
  | "reviewer_action_required"
  | "ambiguous";

export type PullRequestReviewLoopThreadSummary = {
  threadId: string;
  action: PullRequestReviewLoopThreadAction;
  path: string | null;
  line: number | null;
  isOutdated: boolean;
  summary: string;
};

export type PullRequestReviewLoopSnapshot = {
  pullRequestUrl: string;
  reviewDecision: string | null;
  unresolvedThreadCount: number;
  implementerActionThreadIds: string[];
  reviewerActionThreadIds: string[];
  ambiguousThreadIds: string[];
  hasOpenReviewDecision: boolean;
  threads: PullRequestReviewLoopThreadSummary[];
};

export function appendPullRequestReviewLoopMarker(
  body: string,
  marker: PullRequestReviewLoopMarker,
): string {
  const normalizedBody = body.trimEnd();
  const payload = JSON.stringify({
    runId: marker.runId,
    phase: marker.phase,
    role: marker.role,
    ...(marker.threadId === undefined || marker.threadId === null
      ? {}
      : { threadId: marker.threadId }),
  });
  const suffix = `<!-- ${REVIEW_LOOP_MARKER_PREFIX} ${payload} -->`;

  return normalizedBody.length === 0
    ? suffix
    : `${normalizedBody}\n\n${suffix}`;
}

export function parsePullRequestReviewLoopMarker(
  body: string,
): PullRequestReviewLoopMarker | null {
  const matches = [...body.matchAll(REVIEW_LOOP_MARKER_PATTERN)];
  const rawPayload = matches.at(-1)?.[1];

  if (rawPayload === undefined) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPayload);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  const runId = typeof candidate.runId === "string" ? candidate.runId.trim() : "";
  const phase =
    candidate.phase === "implement" || candidate.phase === "review"
      ? candidate.phase
      : null;
  const role =
    candidate.role === "implement" || candidate.role === "review"
      ? candidate.role
      : null;
  const threadId =
    typeof candidate.threadId === "string" && candidate.threadId.trim().length > 0
      ? candidate.threadId.trim()
      : null;

  if (runId.length === 0 || phase === null || role === null) {
    return null;
  }

  return {
    runId,
    phase,
    role,
    threadId,
  };
}

export function stripPullRequestReviewLoopMarkers(body: string): string {
  return body.replaceAll(REVIEW_LOOP_MARKER_PATTERN, "").trim();
}

export function classifyPullRequestReviewLoop(
  input: GitHubPullRequestReadResult,
): PullRequestReviewLoopSnapshot {
  const summaries: PullRequestReviewLoopThreadSummary[] = [];
  const implementerActionThreadIds: string[] = [];
  const reviewerActionThreadIds: string[] = [];
  const ambiguousThreadIds: string[] = [];

  for (const thread of input.threads) {
    if (thread.isResolved) {
      continue;
    }

    const action = classifyReviewThreadAction(
      thread,
      input.pullRequest.authorLogin,
    );
    const summary = buildThreadSummary(thread);
    const threadSummary: PullRequestReviewLoopThreadSummary = {
      threadId: thread.id,
      action,
      path: thread.path,
      line: thread.line,
      isOutdated: thread.isOutdated,
      summary,
    };

    summaries.push(threadSummary);

    switch (action) {
      case "implementer_action_required":
        implementerActionThreadIds.push(thread.id);
        break;
      case "reviewer_action_required":
        reviewerActionThreadIds.push(thread.id);
        break;
      case "ambiguous":
        ambiguousThreadIds.push(thread.id);
        break;
    }
  }

  return {
    pullRequestUrl: input.pullRequest.url,
    reviewDecision: input.pullRequest.reviewDecision,
    unresolvedThreadCount: summaries.length,
    implementerActionThreadIds,
    reviewerActionThreadIds,
    ambiguousThreadIds,
    hasOpenReviewDecision:
      input.pullRequest.reviewDecision !== null &&
      input.pullRequest.reviewDecision !== "APPROVED",
    threads: summaries,
  };
}

export function renderPullRequestReviewLoopContext(input: {
  phase: "implement" | "review";
  snapshot: PullRequestReviewLoopSnapshot;
}): string | null {
  if (input.snapshot.unresolvedThreadCount === 0) {
    return [
      `Pull request: ${input.snapshot.pullRequestUrl}`,
      `Review decision: ${input.snapshot.reviewDecision ?? "(none)"}`,
      "No unresolved review threads are currently open.",
    ].join("\n");
  }

  const relevantAction =
    input.phase === "implement"
      ? "implementer_action_required"
      : "reviewer_action_required";
  const relevantLabel =
    input.phase === "implement"
      ? "Threads requiring implementation action"
      : "Threads requiring review action";
  const relevantThreads = input.snapshot.threads.filter(
    (thread) => thread.action === relevantAction,
  );
  const ambiguousThreads = input.snapshot.threads.filter(
    (thread) => thread.action === "ambiguous",
  );
  const counterpartThreads = input.snapshot.threads.filter(
    (thread) =>
      thread.action !== relevantAction && thread.action !== "ambiguous",
  );

  const lines = [
    `Pull request: ${input.snapshot.pullRequestUrl}`,
    `Review decision: ${input.snapshot.reviewDecision ?? "(none)"}`,
    `Unresolved threads: ${input.snapshot.unresolvedThreadCount}`,
    "",
    `${relevantLabel}: ${relevantThreads.length}`,
  ];

  if (relevantThreads.length > 0) {
    lines.push(...relevantThreads.map((thread) => `- ${thread.summary}`));
  } else {
    lines.push("- none");
  }

  lines.push(
    "",
    `Threads requiring ${
      input.phase === "implement" ? "review" : "implementation"
    } action: ${counterpartThreads.length}`,
  );
  if (counterpartThreads.length > 0) {
    lines.push(...counterpartThreads.map((thread) => `- ${thread.summary}`));
  } else {
    lines.push("- none");
  }

  lines.push("", `Ambiguous unresolved threads: ${ambiguousThreads.length}`);
  if (ambiguousThreads.length > 0) {
    lines.push(...ambiguousThreads.map((thread) => `- ${thread.summary}`));
  } else {
    lines.push("- none");
  }

  return lines.join("\n");
}

export function computePullRequestReviewLoopFingerprint(
  threadIds: readonly string[],
): string {
  return [...threadIds].sort().join(",");
}

function classifyReviewThreadAction(
  thread: GitHubPullRequestThread,
  pullRequestAuthorLogin: string | null,
): PullRequestReviewLoopThreadAction {
  const latestComment = thread.comments.at(-1);

  if (latestComment === undefined) {
    return "ambiguous";
  }

  const latestRole = classifyCommentRole(latestComment, pullRequestAuthorLogin);

  switch (latestRole) {
    case "review":
      return "implementer_action_required";
    case "implement":
      return "reviewer_action_required";
    default:
      return "ambiguous";
  }
}

function classifyCommentRole(
  comment: GitHubPullRequestThreadComment,
  pullRequestAuthorLogin: string | null,
): PullRequestReviewLoopRole | "ambiguous" {
  const marker = parsePullRequestReviewLoopMarker(comment.body);
  if (marker !== null) {
    return marker.role;
  }

  const authorLogin = comment.authorLogin?.trim() ?? null;
  if (authorLogin === null || authorLogin.length === 0) {
    return "ambiguous";
  }

  if (pullRequestAuthorLogin !== null && authorLogin !== pullRequestAuthorLogin) {
    return "review";
  }

  return "ambiguous";
}

function buildThreadSummary(thread: GitHubPullRequestThread): string {
  const latestComment = thread.comments.at(-1);
  const location = [thread.path, thread.line === null ? null : `:${thread.line}`]
    .filter((value): value is string => value !== null)
    .join("");
  const cleanedBody = stripPullRequestReviewLoopMarkers(latestComment?.body ?? "");
  const normalizedBody =
    cleanedBody.replace(/\s+/g, " ").trim() || "No comment text provided.";
  const summaryBody =
    normalizedBody.length > 140
      ? `${normalizedBody.slice(0, 137).trimEnd()}...`
      : normalizedBody;
  const outdatedPrefix = thread.isOutdated ? "[outdated] " : "";

  return location.length > 0
    ? `${outdatedPrefix}${location} - ${summaryBody}`
    : `${outdatedPrefix}${summaryBody}`;
}
