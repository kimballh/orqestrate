# Set Up Orqestrate In Your Project

This guide assumes you have already installed the `orq` CLI globally.

## 1. Initialize config in your project

From the root of the project where you want to use Orqestrate:

```bash
orq init
```

That creates a starter `config.toml` from the packaged example config.

## 2. Choose your providers

Edit `config.toml` and select the profile you want to use.

The initial MVP target is:

- `planning.linear`
- `context.notion`

The repo also supports local-only profiles for bootstrap and testing.

## 3. Supply credentials

Populate the environment variables referenced by your `config.toml`.

For the initial SaaS-backed path, that usually means:

- Linear credentials
- Notion credentials

Keep secrets in environment variables, not checked-in config.

## 4. Bootstrap the selected profile

Run:

```bash
orq bootstrap
```

That validates the selected profile and prepares local state for the chosen providers.

## 5. Start the runtime daemon

Run:

```bash
orq runtime start
```

The runtime daemon owns:

- run admission
- workspace allocation
- provider process lifecycle
- event persistence
- operator actions like cancel, interrupt, and human input

## 6. Start the orchestrator service

When you are ready for Orqestrate to claim and advance work, run:

```bash
orq orchestrator start --repo-root "$PWD"
```

The orchestrator service owns:

- actionable ticket discovery
- wakeup and reconciliation loops
- work claiming and dispatch into the runtime
- optional webhook intake for supported planning providers

## 7. Understand the local state created by Orqestrate

With the shipped config defaults, Orqestrate resolves state under `./.harness/` in your project:

- `./.harness/state/`
- `./.harness/logs/`
- `./.harness/local/` for local example profiles

Your `config.toml` is authoritative if you customize those paths.

## Next step

Continue with [Use Orqestrate Day To Day](./use-orqestrate.md).
