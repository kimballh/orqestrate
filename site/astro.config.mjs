// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://orqestrate.dev',
  integrations: [
    starlight({
      title: 'Orqestrate',
      description: 'The orchestration layer for coding agents.',
      disable404Route: true,
      editLink: {
        baseUrl: 'https://github.com/kimballh/orqestrate/edit/main/site/',
      },
      sidebar: [
        { label: 'Back to site', link: '/' },
        {
          label: 'Docs',
          items: [
            { label: 'Overview', link: '/docs/' },
            { label: 'Getting Started', link: '/docs/getting-started/' },
            { label: 'Architecture', link: '/docs/architecture/' },
          ],
        },
      ],
      tagline: 'The harness layer for AI engineering.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/kimballh/orqestrate' }],
      customCss: ['./src/styles/global.css'],
    }),
  ],
});
