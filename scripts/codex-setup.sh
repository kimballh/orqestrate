#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
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

echo
echo "Orqestrate worktree bootstrap complete."
echo "Useful next steps:"
echo "  npm run typecheck"
echo "  npm run build"
