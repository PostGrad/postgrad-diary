# PostGrad's Diary

An Astro-powered technical blog for learning notes and experience reports from realtime systems, backend integrations, AI tooling, and production software.

## Local Development

```bash
npm install
npm run dev
```

Useful scripts:

```bash
npm run build
npm run preview
npm run sync
npm run dev:network
```

## Content

Write posts in `src/content/blog`. Markdown and MDX are both supported.

Required frontmatter:

```yaml
title: "Post title"
description: "One-sentence summary."
pubDate: 2026-07-09
tags: ["astro", "github-pages"]
draft: false
```

## Deploying

1. Push this repository to GitHub.
2. In GitHub, open **Settings > Pages**.
3. Set **Build and deployment > Source** to **GitHub Actions**.
4. Push to `main` or run the workflow manually.

The workflow automatically uses `/` for a user or organization Pages repository named `<username>.github.io`, and `/<repo-name>` for ordinary project Pages repositories.
