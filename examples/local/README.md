# Local Bootstrap Example

This directory is the canonical local-first seed pack for Orqestrate.

It is used by:

- `npm run bootstrap:local`
- `npm run orq:bootstrap`
- `npm run setup`
- local bootstrap tests that validate the file-backed planning and context providers

## Contents

- `seed/planning/issues/*.json` are the authoritative local planning records.
- `seed/planning/index.json` is the checked-in snapshot that must stay in sync with those issue files.
- `context/templates/artifact.md` and `context/templates/evidence.md` are the local context templates wired into `config.example.toml`.

## Usage

Run:

```bash
npm run orq:init -- --profile local
npm run orq:bootstrap
```

That creates `config.toml`, materializes the planning seed into `.harness/local/planning`, and prepares the writable local context root at `.harness/local/context`.

If you want the full contributor bootstrap in one step, run:

```bash
npm run setup
```

Then start the runtime with:

```bash
npm run dev
```

The shipped `config.example.toml` defaults to the `local` profile, so no Linear or Notion credentials are required for this bootstrap path.
