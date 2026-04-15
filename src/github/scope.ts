export type GitHubRepoRef = {
  owner: string;
  repo: string;
};

export type PullRequestRef = GitHubRepoRef & {
  number: number;
  url: string;
};

export class GitHubScopeError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | null;

  constructor(
    message: string,
    input: {
      code: string;
      details?: Record<string, unknown> | null;
    },
  ) {
    super(message);
    this.name = "GitHubScopeError";
    this.code = input.code;
    this.details = input.details ?? null;
  }
}

export function parsePullRequestUrl(url: string): PullRequestRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new GitHubScopeError(`Pull request URL '${url}' is not a valid URL.`, {
      code: "invalid_pull_request_url",
      details: {
        url,
        cause: error instanceof Error ? error.message : String(error),
      },
    });
  }

  if (parsed.hostname !== "github.com") {
    throw new GitHubScopeError(
      `Pull request URL '${url}' must target github.com.`,
      {
        code: "invalid_pull_request_url",
        details: {
          url,
        },
      },
    );
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[2] !== "pull") {
    throw new GitHubScopeError(
      `Pull request URL '${url}' does not match the expected GitHub pull request shape.`,
      {
        code: "invalid_pull_request_url",
        details: {
          url,
        },
      },
    );
  }

  const number = Number.parseInt(segments[3] ?? "", 10);
  if (Number.isInteger(number) === false || number <= 0) {
    throw new GitHubScopeError(
      `Pull request URL '${url}' is missing a valid pull request number.`,
      {
        code: "invalid_pull_request_url",
        details: {
          url,
        },
      },
    );
  }

  return {
    owner: segments[0] ?? "",
    repo: segments[1] ?? "",
    number,
    url,
  };
}

export function parseGitRemoteUrl(remoteUrl: string): GitHubRepoRef {
  const normalized = remoteUrl.trim();
  const httpsMatch = normalized.match(
    /^https:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
  );
  if (httpsMatch?.groups !== undefined) {
    return {
      owner: httpsMatch.groups.owner,
      repo: httpsMatch.groups.repo,
    };
  }

  const sshMatch = normalized.match(
    /^(?:git@github\.com:|ssh:\/\/git@github\.com\/)(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/,
  );
  if (sshMatch?.groups !== undefined) {
    return {
      owner: sshMatch.groups.owner,
      repo: sshMatch.groups.repo,
    };
  }

  throw new GitHubScopeError(
    `Git remote '${remoteUrl}' is not a supported GitHub origin URL.`,
    {
      code: "invalid_git_remote",
      details: {
        remoteUrl,
      },
    },
  );
}

export function normalizeBranchName(branchName: string): string {
  const normalized = branchName.trim();
  if (normalized.startsWith("refs/heads/")) {
    return normalized.slice("refs/heads/".length);
  }

  return normalized;
}

export function pullRequestRefsEqual(
  left: PullRequestRef,
  right: PullRequestRef,
): boolean {
  return (
    left.owner === right.owner &&
    left.repo === right.repo &&
    left.number === right.number
  );
}
