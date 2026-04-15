#!/usr/bin/env bash
set -euo pipefail

resolve_repo_root() {
  if [[ -n "${ORQESTRATE_REPO_ROOT:-}" ]]; then
    printf '%s\n' "${ORQESTRATE_REPO_ROOT}"
    return 0
  fi

  if git_root="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    printf '%s\n' "${git_root}"
    return 0
  fi

  local script_root
  script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  if [[ -f "${script_root}/package.json" ]]; then
    printf '%s\n' "${script_root}"
    return 0
  fi

  echo "error: could not determine the Orqestrate repo root" >&2
  echo "hint: run from inside the git worktree or set ORQESTRATE_REPO_ROOT" >&2
  return 1
}

repo_root="$(resolve_repo_root)"
cd "${repo_root}"

if ! command -v node >/dev/null 2>&1; then
  echo "error: node is required to bootstrap this worktree" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm is required to bootstrap this worktree" >&2
  exit 1
fi

mkdir -p \
  .orqestrate/artifacts \
  .orqestrate/logs \
  .orqestrate/state \
  .orqestrate/tmp

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

npm run orq:init -- --force --profile local
npm run orq:bootstrap -- --force

echo
echo "Orqestrate worktree bootstrap complete."
echo "Useful next steps:"
echo "  npm run orq:bootstrap -- --force     # re-seed and re-validate the local profile"
echo "  npm run typecheck"
echo "  npm run build"
