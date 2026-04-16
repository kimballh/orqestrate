# Orqestrate Site

The public site lives inside the main repo so product, docs, and website structure can evolve in the same pull request.

Routes:

- `/` for the product landing page
- `/docs` for the Starlight documentation surface

## Local development

From the repository root:

```bash
npm install
npm run site:dev
```

Useful site-specific commands:

```bash
npm run site:check
npm run site:build
npm run site:preview
```

If you are already working inside `site/`, the equivalent commands are:

```bash
npm run dev
npm run check
npm run build
```

## Content sources

The current landing page copy is adapted from:

- `Orqestrate — Ideas, Content, and Roadmap`
- `Orqestrate — Marketing Content`
- repo-local docs in `docs/`

The site keeps that content in local source files so builds do not depend on live Notion access.

## Deployment

The site is configured for static output. A lightweight Netlify setup from the repository root is:

- Base directory: leave unset so Netlify installs from the repo root workspace
- Build command: `npm run site:build`
- Publish directory: `site/dist`

After the site is deployed, attach the custom domain `orqestrate.dev`. Docs already live under the same build at `/docs`, so no second host is required.
