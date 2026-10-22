# CLAUDE.md

Guidance for coding agents working in this repository.

## What this is

**WordLink** (product name on the site: *Lexiverse*) is an English vocabulary learning app built around a
**word-relation graph**: every word links to its synonyms, near-synonyms, antonyms, derivatives, inflections and
look-alike spellings, and learners explore vocabulary as a network instead of a flat list. Around the graph sit
quizzes driven by an FSRS-6 memory model, graded reading, an ambient "screensaver" mode, AI tutoring and a
learning passport.

## Stack

- Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4
- PostgreSQL + Prisma (all tables live in the `LPT_english` schema)
- Supabase Auth (`src/lib/supabase/*`); `DEMO_MODE=true` maps every session to the built-in demo account
- LLM calls go through one OpenAI-compatible gateway, `src/lib/ai/gateway.ts` (SiliconFlow by default,
  `LLM_BASE_URL` / `LLM_MODEL`); prompts live in `data/ai_prompts/`, results are cached on disk in `data/generated/`
- next-intl: `messages/<locale>.json` plus per-area shards in `messages/<locale>/*.json`, locale from the
  `NEXT_LOCALE` cookie, English by default
- Graph rendering: `react-force-graph-2d` + `d3-force`
- Payments: Alipay page pay (`src/lib/pay/`), free-tier daily quotas (`src/lib/quota.ts`)

## Commands

```bash
docker compose up -d     # local PostgreSQL on :5432
npm run dev              # http://localhost:3000
npm run typecheck        # tsc --noEmit
npm run lint
npm run build
npx prisma generate      # after editing prisma/schema.prisma
npx prisma migrate dev
npm run import-edges     # load data/word_relation_edges.csv into word_relation
npm run demo-data        # 180 days of learning data for demo@wordlink.test
```

`dev` and `build` pass `--webpack` on purpose: Turbopack panics when the project path contains non-ASCII
characters. Do not switch them back unless the checkout lives under an ASCII-only path.

`.env.local` overrides `.env` — when changing `DATABASE_URL`, change both. See `.env.example` for every variable.

## Layout

- `src/app/` — pages and `api/` route handlers
  - `/` landing · `/study` main workspace (word list | word detail | graph) · `/home` daily dashboard
  - `/quiz/*` select / spelling / recall · `/read` graded reading · `/ambient` screensaver mode
  - `/immersive` full-screen graph · `/passport` learning report · `/navigator` graph path-finding toward a target word
  - `/my-libraries` custom word books · `/pricing`, `/pay/return` payments · `/model` model tech report
- `src/components/` — UI. Workspace: `ThreeColumnLayout`, `WordList`, `WordDetail`, `PanelFissionGraph`
  (graph inside the workspace) and `FissionGraph` (full-screen graph). `word-modules/` are the collapsible
  blocks of the word detail pane; `mobile/` holds the phone layouts.
- `src/lib/data.ts` — word data access: libraries, word details, Chinese data, `getFissionData()` (graph)
- `src/lib/graph-shared.ts` — graph types and relation colors, safe to import from client components
- `src/lib/reader-engine/` — FSRS-6 scheduler, tokenizer, article recommender
- `prisma/schema.prisma` — data model; `word_relation` holds the typed graph edges
- `data/` — lexical data (ECDICT extract, word markdown, Chinese explanations, relation edges, word lists)
- `model_training/` — SFT / DPO / benchmark scripts for the WordLink-Edge 1.5B model; results in `outputs/eval/`
- `scripts/` — data import and demo/recording tools; `scripts/local/` is git-ignored scratch space

## Conventions

- UI copy goes through next-intl; add keys to both `messages/en*` and `messages/zh*`.
- Server-only modules (`fs`, Prisma) must not be imported from client components; shared graph types belong
  in `graph-shared.ts`.
- Never commit `.env*`, server addresses or credentials. Ops scripts that need them stay in `scripts/local/`.
- Numbers quoted in docs or UI about the model must come from `outputs/eval/`.
