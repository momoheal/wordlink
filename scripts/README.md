# scripts

Maintenance and data tools. Run them from the repository root with `npx tsx scripts/<name>.ts`
(or the npm aliases below). They read `DATABASE_URL` from `.env` / `.env.local`.

## Data

| Script | npm alias | What it does |
|---|---|---|
| `migrate-to-database.ts` | `npm run migrate` | Loads the word files in `data/` (word markdown, Chinese explanations, ECDICT extract, legacy synonym table) into PostgreSQL. Clears the target tables first. |
| `verify-migration.ts` | `npm run verify` | Checks the database against `data/` after a migration. |
| `build-word-edges.ts` | | Mines typed relations (derivative, inflection, near-synonym) from `data/` into `data/word_relation_edges.csv`. |
| `build-spelling-edges.ts` | | Adds look-alike spelling edges (Dice score `2·LCS/(a+b) ≥ 0.75`, skipping words of the same family) and writes `data/word_families.csv`. |
| `import-word-edges.ts` | `npm run import-edges` | Idempotently loads `data/word_relation_edges.csv` into the `word_relation` table used by the graph. |
| `inject-demo-data.ts` | `npm run demo-data` | Gives `demo@wordlink.test` 180 days of visits, quiz records and memory states. |

## Media

| Script | What it does |
|---|---|
| `record-tour.js` | Records the product tour video with Puppeteer (needs a running dev server and the demo account). |
| `capture-showcase.js` | Takes the screenshots used in the README and on the landing page. |
| `compress-videos.sh` | Re-encodes `public/videos/*.mp4` for the web. |

## Other

| Script | What it does |
|---|---|
| `gen-theme.mjs` | Regenerates `src/app/theme-palette.css` (the light-theme palette) from Tailwind's default colors. |
| `test-fsrs.ts` | Prints simulated FSRS-6 review schedules for a few learner profiles. |
| `test-rme.ts` | Prints article rankings from the reading recommender for a few mock users. |

`scripts/local/` is git-ignored: put one-off debugging or ops scripts there, never in the tracked folder.
