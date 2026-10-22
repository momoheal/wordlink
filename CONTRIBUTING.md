# Contributing to WordLink

Thanks for helping! Issues and pull requests are welcome in English or Chinese.

## Getting set up

Follow [Quick start](README.md#quick-start). `DEMO_MODE=true` is enough for most UI work; you only need Supabase for
sign-up/login changes and an LLM key for the AI features.

## Before you open a pull request

```bash
npm run typecheck
npm run build
```

- Keep pull requests focused on one change and describe what you tested.
- UI text goes through next-intl: add keys to both `messages/en*` and `messages/zh*`.
- The app is written dark-first with Tailwind palette classes; the light theme remaps those palette variables
  (`src/app/theme-palette.css`). Prefer palette classes (`bg-neutral-900`, `text-white/60`) over hard-coded hex
  colours so both themes keep working.
- Never commit `.env*`, server addresses or credentials. One-off scripts go in the git-ignored `scripts/local/`.

## Good first issues

- Antonym links: extract them from [Open English WordNet](https://github.com/globalwordnet/english-wordnet) into
  `data/word_relation_edges.csv` (see `scripts/build-word-edges.ts`).
- ESLint: `npx eslint src` still reports existing errors; fixing a file at a time is a welcome PR.
- Translations and copy fixes in `messages/`.

## Reporting bugs

Include the page URL, what you expected, what happened, and the browser. Screenshots help, especially for the graph.
