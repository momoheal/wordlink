<div align="center">

# WordLink

**See every English word together with its neighbours.**

An open-source vocabulary workspace built on a graph of **326k typed word links**: synonyms, near-synonyms,
word families and look-alike spellings, all mined from open dictionaries. Quizzes, graded reading and an AI tutor
sit on top of the graph. The repo also contains the complete SFT + DPO pipeline and benchmark for
**WordLink-Edge**, a 1.5B model fine-tuned to write your review words into graded stories.

[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org)
[![React 19](https://img.shields.io/badge/React-19-61dafb)](https://react.dev)
[![Weights on ModelScope](https://img.shields.io/badge/weights-ModelScope-624aff)](https://modelscope.cn/models/OrionSheep/wordlink-lexiconstrain)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen)](CONTRIBUTING.md)

[Live demo](https://wordlink.lifeplayertribe.com) · [Features](#features) · [Quick start](#quick-start) · [How it works](#how-it-works) · [Model](#the-model-wordlink-edge) · [Roadmap](#roadmap) · [中文](README.zh-CN.md)

</div>

![WordLink workspace: word list, word detail and the word graph](public/images/showcase/study.jpg)

## Why

Most vocabulary apps drill words one at a time. But you remember *abandon* better when you also see
*desert*, *forsake* and *give up* next to it, and *abandonment*, *abandoned* around it. WordLink puts that
neighbourhood next to every word you study, so each review also revisits the words around it.

## Features

### Word graph
The right-hand panel of the workspace is a map of the selected word.

- **Colour = relation type.** Toggle synonyms, near-synonyms, antonyms and look-alikes from the toolbar.
- **Word family as a bubble.** Derivatives and inflections (*reach → reached, reaching, reachable*) sit inside a
  dashed bubble around the centre word instead of adding more lines.
- **One sector per relation.** Each group fans out in its own direction with a label such as *Synonyms 10/12 +*;
  click it to show the rest.
- **Your progress on the map.** A ring around each word shows how well you know it: a quarter once you have seen
  it, two thirds while learning, closed when mastered, red when it is weak.
- **Second-degree links on demand** (press <kbd>H</kbd>), dashed outlines for words without an entry yet, and
  short Chinese glosses when you zoom in.

<p align="center">
  <img src="public/images/showcase/graph-light.jpg" width="40%" alt="Word graph, light theme">
  <img src="public/images/showcase/graph-dark.jpg" width="40%" alt="Word graph, dark theme">
</p>

### Around the graph
- **Quizzes**: multiple choice, spelling and recall. Every answer updates a per-word memory state that decides
  when the word comes back.
- **Graded reading**: articles with click-to-define on every word and the graph in a side drawer.
- **Ambient mode**: a full-screen word stream with four seasonal soundscapes, synthesized live with Web Audio.
- **Also**: learning passport (a report of what you have studied), custom word books from CSV, AI tutor chat,
  English/Chinese interface, light and dark themes.

<p align="center">
  <img src="public/images/showcase/workspace-light.jpg" width="80%" alt="Light theme">
</p>

## Quick start

Requirements: Node.js 20+, Docker.

```bash
git clone https://github.com/orionsheep/wordlink.git
cd wordlink
npm install

docker compose up -d                 # PostgreSQL on localhost:5432
cp .env.example .env.local           # then edit, see below
npx prisma migrate deploy            # create the tables
npm run migrate                      # load the dictionaries in data/ (takes a while)
npm run import-edges                 # load the 326k typed word links used by the graph

npm run dev                          # http://localhost:3000
```

Minimal `.env.local`:

```bash
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/english_word_fission_dev?schema=LPT_english"
DEMO_MODE=true          # no auth server needed: every visitor uses the built-in demo account
```

- **Accounts**: real sign-up and login use [Supabase Auth](https://supabase.com/docs/guides/cli) (`supabase start`
  locally) — set the three `SUPABASE` variables and turn `DEMO_MODE` off.
- **AI features** (tutor chat, story generation, passport report) call any OpenAI-compatible endpoint:
  set `LLM_BASE_URL`, `LLM_MODEL` and an API key (`SILICONFLOW_APIKEY`). Everything else works without one.
- **Demo data**: `npm run demo-data` gives `demo@wordlink.test` six months of study history.

Full guide (in Chinese): [docs/部署与运行指南.md](docs/部署与运行指南.md).

## How it works

| Layer | What it is |
|---|---|
| App | Next.js 16 App Router, React 19, Tailwind CSS 4, next-intl |
| Data | PostgreSQL via Prisma; word data loaded from `data/` |
| Graph | `GET /api/fission?word=…` returns the word's neighbours and their neighbours from the `word_relation` table; rendered with `react-force-graph-2d` in `src/components/PanelFissionGraph.tsx` |
| Memory | each quiz answer moves a word through UNFAMILIAR → FAMILIAR → LEARNED → MASTERED and sets its next review date (`src/lib/memory.ts`) |
| AI | one OpenAI-compatible gateway (`src/lib/ai/gateway.ts`), prompts in `data/ai_prompts/`, responses cached on disk |
| Auth | Supabase Auth, or `DEMO_MODE` for a single built-in account |

The word links come from open data plus a few mining scripts in [`scripts/`](scripts/README.md):

| Relation | Links | Source |
|---|---:|---|
| Inflections | 125,612 | ECDICT word-form codes |
| Look-alike spellings | 120,946 | longest-common-subsequence score ≥ 0.75, same-family pairs excluded |
| Synonyms | 87,971 | synonym table in `data/word_fission_data.csv` |
| Near-synonyms (with usage notes) | 74,008 | "commonly confused" notes in `data/word_chinese/` |
| Derivatives | 6,221 | derivative links in the dictionary entries |
| Antonyms | 0 | not collected yet — see the roadmap |

## The model: WordLink-Edge

WordLink-Edge is **Qwen2.5-1.5B-Instruct fine-tuned with SFT + DPO** for one job: write a short story at a given
CEFR level that uses a given list of target words, returned as JSON. The pipeline in
[`model_training/`](model_training/) covers data generation with a teacher model and five filters, SFT, DPO on
real failure cases, and the benchmark.

Measured on a 90-question benchmark with greedy decoding ([full report](outputs/eval/BENCHMARK_RESULTS.md)):

| Model | Target-word hit ↑ | CEFR violations ↓ | Valid JSON ↑ |
|---|---:|---:|---:|
| Qwen2.5-1.5B-Instruct, before fine-tuning | 63.06% | 0.17% | 82.22% |
| **+ SFT** (2,045 stories) | **88.06%** | **0.01%** | **100%** |
| **+ DPO** (real failure negatives) | 87.78% | **0.01%** | **100%** |
| Qwen2.5-7B-Instruct, zero-shot | 39.72% | 0.07% | 0% |
| DeepSeek-V3, zero-shot (teacher) | 97.78% | 0.01% | 100% |

Fine-tuning adds 25 points on the same 1.5B model, while a 7B model without fine-tuning fails the format entirely.

Weights: [OrionSheep/wordlink-lexiconstrain](https://modelscope.cn/models/OrionSheep/wordlink-lexiconstrain)
(SFT + DPO merged) and [OrionSheep/wordlink-edge](https://modelscope.cn/models/OrionSheep/wordlink-edge) (SFT).

> **Status.** The model is trained and benchmarked, but the web app does not run it yet: its AI features call
> an OpenAI-compatible API. Running WordLink-Edge in the browser with WebGPU is on the roadmap.

## Roadmap

- [ ] Antonym links (Open English WordNet)
- [ ] Run WordLink-Edge in the browser (WebGPU, 4-bit)
- [ ] Schedule reviews with the FSRS-6 implementation already in `src/lib/reader-engine/fsrs.ts`
- [ ] Sense-level links: which meaning of a word a synonym belongs to
- [ ] Tabs and split view in the workspace
- [ ] Clear the remaining ESLint errors

Ideas and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Repository map

```
src/app/            pages and API routes
src/components/     UI (workspace, graph, word modules, ambient mode, …)
src/lib/            data access, memory model, AI gateway, reader engine
prisma/             schema and migrations
data/               dictionaries, word links, word lists, AI prompts, training corpora
model_training/     SFT / DPO / corpus / benchmark scripts
outputs/eval/       benchmark metrics and per-question predictions
scripts/            data import and maintenance tools
docs/               deployment guide, training report
```

## License and data

Code: [MIT](LICENSE). `data/` bundles lexical resources from other projects, including
[ECDICT](https://github.com/skywind3000/ECDICT) (MIT); check each source's terms before reusing the data on its
own. Model weights follow the [Qwen2.5 license](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct).

## Acknowledgements

- [ECDICT](https://github.com/skywind3000/ECDICT) for phonetics, translations and word forms
- [Qwen2.5](https://github.com/QwenLM/Qwen2.5) as the base model
- The graph's relation chips, word-family bubbles and familiarity marks were inspired by
  词汇星图 in [HytidelLegend/ai-aug-edu](https://github.com/HytidelLegend/ai-aug-edu)

Built for [UNU Macau · AI for SDGs 2026](https://unu.edu/macau), AI for Education (SDG 4).
