# Install Orqestrate

## Global install

Once the package is published, install Orqestrate globally with:

```bash
npm install -g orqestrate
```

Today, while working from a checkout or local package tarball, you can install it globally with:

```bash
npm install -g /path/to/orqestrate
```

Or from a packed tarball:

```bash
npm pack
npm install -g ./orqestrate-0.1.0.tgz
```

## Verify the install

Confirm the CLI is available:

```bash
orq --help
orq runtime --help
orq prompt --help
```

## What the global CLI currently provides

The installed CLI currently exposes:

- `orq init`
- `orq bootstrap`
- `orq runtime start`
- `orq run ...`
- `orq prompt ...`
- `orq github ...`

That is enough to initialize config, bootstrap profiles, start the runtime, inspect runs, and work with prompt tooling.

## Next step

Continue with [Set Up Orqestrate In Your Project](./setup-your-project.md).
