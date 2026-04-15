# Orqestrate

Orqestrate is a provider-driven orchestration harness for software delivery work.

The initial MVP target is autonomous Orqestrate with:

- Linear as the planning surface
- Notion as the durable artifact surface
- Codex or Claude as scoped execution agents
- a local runtime daemon that owns run execution, persistence, and operator controls

## Install

Install Orqestrate globally:

```bash
npm install -g orqestrate
```

If you are working from a local checkout before publication, install it globally from the repo path instead:

```bash
npm install -g /path/to/orqestrate
```

Verify the CLI:

```bash
orq --help
```

## Start Here

- Install guide: [docs/guides/install.md](./docs/guides/install.md)
- Project setup guide: [docs/guides/setup-your-project.md](./docs/guides/setup-your-project.md)
- Day-to-day usage guide: [docs/guides/use-orqestrate.md](./docs/guides/use-orqestrate.md)
- Full docs index: [docs/README.md](./docs/README.md)

## Quickstart

From the root of the project where you want to use Orqestrate:

```bash
orq init
orq bootstrap
orq runtime start
```

That flow:

- creates `./config.toml` from the packaged example config
- validates and prepares the selected profile
- starts the runtime daemon for that project

## What Orqestrate Owns

Orqestrate is designed so:

- Linear owns planning and dispatch state
- Notion owns durable artifacts and run history
- the orchestrator claims and advances one active phase at a time
- the runtime daemon executes and supervises agent runs locally

## Current Packaging Notes

The installed CLI currently exposes:

- `orq init`
- `orq bootstrap`
- `orq runtime start`
- `orq run ...`
- `orq prompt ...`
- `orq github ...`

The runtime daemon is already packaged behind the global CLI.

The orchestrator service is implemented in this repository, and the user guides call out the current packaging boundary while its top-level installed CLI entrypoint is finalized.

## Contributing

If you want to work on Orqestrate itself rather than use it as a tool:

- Contributor docs: [docs/contributors/README.md](./docs/contributors/README.md)
