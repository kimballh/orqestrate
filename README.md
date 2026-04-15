# Orqestrate

Orqestrate is a provider-driven orchestration harness for software delivery work.

The initial MVP target is autonomous Orqestrate with Linear as planning:

- Linear is the planning surface
- Notion is the durable artifact surface
- Codex or Claude act as scoped execution agents
- a local runtime daemon owns run execution, persistence, and operator controls

The strongest supported path right now is the zero-credential `local` profile. SaaS-backed profiles are scaffolded, but they still require real provider credentials and workspace configuration.

## Quickstart

Clone the repo, then bootstrap the local profile:

```bash
npm run setup
```

That will:

- install dependencies
- create `./config.toml` from `config.example.toml`
- select the `local` profile
- materialize the local planning and context examples under `./.harness/local`

Start the runtime daemon:

```bash
npm run dev
```

## Cross-Project Package Smoke Test

To validate Orqestrate as an installed package from another workspace:

```bash
npm run build
npm pack

SHORT_TMP_DIR="$(mktemp -d /tmp/orq-package-smoke.XXXXXX)"
cp orqestrate-0.1.0.tgz "$SHORT_TMP_DIR/"
cd "$SHORT_TMP_DIR"
npm init -y
npm install ./orqestrate-0.1.0.tgz

./node_modules/.bin/orq init
./node_modules/.bin/orq bootstrap
./node_modules/.bin/orq runtime start
```

Use a short workspace path such as `/tmp/orq-package-smoke.*` for this smoke test on macOS so the runtime Unix socket path stays within platform limits.

That flow is the supported cross-project validation path for this ticket:

- `orq init` writes `./config.toml` from the packaged example config
- `orq bootstrap` seeds local planning and context state under `./.harness/local`
- `orq runtime start` starts the runtime daemon without depending on repo-local source paths

Inspect recent runs through the CLI-first diagnostics surface:

```bash
npx tsx src/index.ts run list
npx tsx src/index.ts run inspect <run-id>
```

On macOS or Linux, confirm the daemon is healthy:

```bash
ORQ_SOCKET="$PWD/.harness/state/sockets/runtime.sock"
curl --unix-socket "$ORQ_SOCKET" http://runtime.local/v1/health
curl --unix-socket "$ORQ_SOCKET" http://runtime.local/v1/capacity
```

On Windows, the runtime binds a named pipe instead of a Unix socket:

- `\\.\pipe\orqestrate-runtime-<active-profile>`

## Start Here

- Contributor workflow: [docs/contributor_workflow.md](./docs/contributor_workflow.md)
- Operator runbook: [docs/operator_runbook.md](./docs/operator_runbook.md)
- Docs index and architecture references: [docs/README.md](./docs/README.md)
- Quality bar for implementation and review: [docs/quality_policy.md](./docs/quality_policy.md)

## What Exists Today

- `npm run setup`, `npm run orq:init`, and `npm run orq:bootstrap` for local bootstrap
- `orq init`, `orq bootstrap`, and `orq runtime start` for installed-package testing
- `npm run dev` and `npm start` for the repo-local runtime daemon
- `npx tsx src/index.ts run list` and `npx tsx src/index.ts run inspect <run-id>` for operator-friendly run diagnostics
- a SQLite-backed runtime with health, capacity, run listing, event streaming, cancel, interrupt, and human-input APIs
- built-in planning backends for Linear and local files
- built-in context backends for Notion and local files
- prompt-pack scaffolding for `design`, `plan`, `implement`, `review`, and `merge`

## What To Expect

- The product target is autonomous orchestration driven from planning state, not a human dispatch loop.
- The strongest supported bootstrap path in the repo today is still the zero-credential `local` profile for local setup and testing.
- Task-oriented docs live in `docs/`, while deeper architecture and contract material stays there as reference.
- The default state, logs, and runtime database paths come from `config.toml` and resolve to `./.harness/*` with the shipped local config.

## Daily Commands

```bash
npm run typecheck
npm run build
npm run test
npm run check
npm run orq:init -- --help
npm run orq:bootstrap -- --help
```

## Local Layout

- `config.example.toml`: canonical example config
- `config.toml`: local working config created by `npm run setup` or `npm run orq:init`
- `examples/local/`: seed planning records and local context templates
- `.harness/state/runtime.sqlite`: runtime state database for the default local profile
- `.harness/logs/runtime/`: runtime log directory for the default local profile

## Contributing

Use the contributor guide before taking ticket work:

- [docs/contributor_workflow.md](./docs/contributor_workflow.md)

If you are operating or debugging the daemon, start with:

- [docs/operator_runbook.md](./docs/operator_runbook.md)
