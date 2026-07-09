import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'postgrad-diary';
const repositoryOwner =
  process.env.GITHUB_REPOSITORY_OWNER ?? process.env.GITHUB_ACTOR ?? 'your-github-username';
const isUserOrOrgSite = repoName === `${repositoryOwner}.github.io`;

const site = process.env.SITE_URL ?? `https://${repositoryOwner}.github.io`;
const base = process.env.BASE_PATH ?? (isUserOrOrgSite ? '/' : `/${repoName}`);

export default defineConfig({
  site,
  base,
  integrations: [mdx(), sitemap()],
  markdown: {
    shikiConfig: {
      theme: 'github-dark'
    }
  }
});

