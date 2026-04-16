export const proofStrip = ['Linear', 'Notion', 'Codex', 'Claude Code', 'Playwright', 'GitHub'];

export const coordinationPillars = [
  {
    index: '01',
    title: 'Planning',
    body: 'Pull work from the systems teams already use and keep ticket state connected to real execution.',
  },
  {
    index: '02',
    title: 'Context',
    body: 'Assemble durable memory from docs, code, and prior decisions instead of relying on one fragile chat window.',
  },
  {
    index: '03',
    title: 'Execution',
    body: 'Launch isolated worktree-backed runs so multiple agents can collaborate without clobbering each other.',
  },
  {
    index: '04',
    title: 'Validation',
    body: 'Close the loop with tests and browser-driven checks so outcomes come back with evidence, not just optimism.',
  },
];

export const workflowSteps = [
  {
    step: '01',
    title: 'Work enters from planning systems',
    body: 'Issues, dependencies, and phase signals stay grounded in the project systems the team already trusts.',
  },
  {
    step: '02',
    title: 'Context is assembled deliberately',
    body: 'Notion pages, repo docs, code, and prior decisions are gathered into a useful execution bundle.',
  },
  {
    step: '03',
    title: 'Agents run in isolation',
    body: 'Each task gets its own prepared environment so parallel runs are safe and reproducible.',
  },
  {
    step: '04',
    title: 'Validation sends evidence back',
    body: 'Checks, browser flows, and human review close the loop before outcomes move forward.',
  },
];

export const validationSignals = [
  {
    title: 'Tests still matter',
    body: 'Builds and automated checks are the baseline, not the finish line. Orqestrate expects them to run as part of normal execution.',
  },
  {
    title: 'Browser flows catch what compile steps miss',
    body: 'The harness is designed for real user-path verification, especially when the highest-risk failures only show up in the interface.',
  },
  {
    title: 'Humans stay in the loop where approval matters',
    body: 'Ticket phases, reviews, and artifact updates keep execution legible instead of disappearing into opaque agent churn.',
  },
];

export const docsLinks = [
  {
    index: '01',
    title: 'Overview',
    href: '/docs/',
    body: 'Meet the product thesis and understand what Orqestrate coordinates across planning, context, and execution.',
  },
  {
    index: '02',
    title: 'Getting Started',
    href: '/docs/getting-started/',
    body: 'Run the local-first quickstart and see the first commands needed to stand the system up.',
  },
  {
    index: '03',
    title: 'Architecture',
    href: '/docs/architecture/',
    body: 'See how the planning, context, execution, and validation layers fit together in the current MVP.',
  },
];
