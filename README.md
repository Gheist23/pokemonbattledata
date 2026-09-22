# Pokemon Champions Battle Data

A static, responsive website and public API for exploring Pokemon Champions battle data.

## Folder structure

```text
pokemon_champions_assets/
  battle_data/
    Doubles/
      garchomp.csv
    Singles/
      garchomp.csv
  metadata/
    Garchomp.csv
  pokemon/
    Garchomp.png
  types/
    Dragon.png
    Ground.png
```

Current metadata CSV format:

```text
title,base_name,saved_name,types,abilities,image_path,form,hp,atk,def,spa,spd,spe,total
```

Current battle CSV format:

```text
pokemon,position,category,rank,name,percentage,stat_up,stat_down,hp_points,attack_points,defense_points,sp_atk_points,sp_def_points,speed_points
```

## Local preview

```powershell
node tools/generate-manifest.mjs
python -m http.server 5500 --bind 127.0.0.1
```

Open:

```text
http://127.0.0.1:5500
```

## Deployment

The generator produces a lightweight browser index and static API records:

- `data/pokemon-index.json` is the lightweight browser/search index.
- `data/api/index.json` is the complete API dataset streamed by `/api`.
- `data/api/lookup.json` and `data/api/pokemon/*.json` keep individual API requests small.
- `data/meta/index.json` and `data/meta/<season>/<date>/<Doubles|Singles>.json` are the daily
  ranked-usage snapshots the `/meta/` page diffs to show rank and usage-percentage changes. They
  only cover season folders with dated subfolders (e.g. `M5/03_09_2026/`) -- an undated season
  has no history to diff. If Node isn't available, `python tools/build_meta_trends.py` produces
  the same files from the same `pokemon_champions_assets/battle_data/` layout.

Commit the generated files and public assets:

```powershell
node tools/generate-manifest.mjs
git add .
git commit -m "Update battle data"
git push
```

Cloudflare Pages should use:

```text
Build command: node tools/generate-manifest.mjs
Deploy command: node tools/deploy.mjs
Build output directory: .
Root directory: /
```

Do not use `npx wrangler deploy` for this project. This site uses Cloudflare Pages
with a `functions` directory, so the deploy command must use `wrangler pages deploy`.

Deploy through `node tools/deploy.mjs` rather than calling `wrangler pages deploy`
directly. Pages rejects any deployment holding more than 20,000 files, and the raw
dated CSVs of every past season together cross that line. The wrapper moves the
seasons listed in `tools/archived-seasons.mjs` into `.wrangler/` for the duration
of the upload and moves them straight back afterwards, so local builds still read
them; it also prints the file count and refuses to upload when the tree is still
over the limit. An archived season's rows stay fully available through the JSON
API, which reads them from `data/api/pokemon/<slug>.json`, and its sources are
marked `"archived": true`. When the count creeps back up, add the next finished
season to `tools/archived-seasons.mjs`.

## Public API

Static files work on any static host:

```text
GET /data/pokemon-index.json
GET /pokemon_champions_assets/battle_data/Doubles/Garchomp.csv
GET /pokemon_champions_assets/metadata/Garchomp.csv
```

Cloudflare Pages Functions add JSON endpoints. The user-facing guide is available at `/api_guide`; `/api` is the JSON manifest endpoint:

```text
GET /api
GET /api/index
GET /api/pokemon/garchomp?format=Doubles
GET /api/battle/Doubles/garchomp
GET /api/battle/Doubles/garchomp?season=M4&days=7
GET /api/metadata/garchomp
```

The `_headers` file enables CORS for static JSON, CSV, and image assets.


## Team Builder and Damage Calculator

`/team-builder/` and `/damage-calculator/` run the Companion app's damage engine and team
analysis in the browser. They are plain ES modules in `builder/`, with no build step:

| File | Role |
| --- | --- |
| `builder/engine.js` | port of the app's damage calculation, with the app's exact integer and rounding behaviour |
| `builder/calc-model.js`, `builder/calc-page.js` | the calculator panel: field, KO odds, the no-move matchup verdict |
| `builder/analysis-worker.js` | runs every analysis below in a Web Worker |
| `builder/team-eval.js`, `builder/team-payload.js` | Team Evaluation: threat calcs, critical threats, Offense/Defense scores (the app's V36-V494 stack) |
| `builder/team-checks.js`, `builder/team-synergy.js`, `builder/team-speed.js` | Team Building Checks and archetype, Synergy, Speed Control |
| `builder/team-suggest.js`, `builder/known-teams.js` | Suggested Pokémon, including the "Found in similar team" bonus |
| `builder/suggest-view.js` | the Suggestions list and each suggestion's breakdown |
| `builder/team-autobuild.js`, `builder/team-optimize.js` | Auto Build, and the app's shallow Stat Point optimiser its finish uses (memoised; checked by `run-optimize-vectors.mjs`) |
| `builder/optimize-deep.js`, `builder/optimize-objective.js`, `builder/optimize-core.js`, `builder/move-traits.js` | Team Evaluation > Optimize: a budgeted, stoppable search over Natures, Stat Points and learnable attacks, scored by a speed-aware matchup value (see the file headers); checked by `tests/run-optimize-deep.mjs` |
| `builder/optimize-view.js`, `builder/optimize.css` | the Optimize tab: options, progress, Previously / Now table, what changes in battle, Speed lists, moves tested |
| `builder/autobuild-search.js` | Auto Build's search: the greedy path as the anchor, a beam over partial teams, the Team Evaluation comparison, one repair swap |
| `builder/autobuild-archetype.js` | Auto Build's Preferred archetype and Prioritize Meta Pokémon |
| `builder/tournament-test.js`, `builder/tournament-view.js` | Test against Tournament Teams and its Result Analysis |
| `builder/speed-tiers.js`, `builder/team-overview.js` | the ranked Speed list and the Team Overview charts |
| `builder/evaluation-view.js` | the Team Evaluation screens and the Settings dialog |
| `builder/analysis.js` | the pre-port analysis; only its archetype list is still used (team library filter) |
| `builder/store.js` | teams, boxes and settings in `localStorage`, in the Companion's own shapes |
| `builder/sync.js`, `functions/api/sync/` | Box and team sync with the Companion (see below) |
| `builder/pro.js` | the Pro key, and the free tries of Team Evaluation and Auto Build |

Data comes from two places:

- `data/builder/app-data.json` is exported from the Companion app: species, forms, Mega
  Stones, moves with their effect flags, abilities, items and the type chart. Regenerate it from
  `pct_tool94` whenever the app's engine or data changes:

  ```powershell
  python tools/export_web_builder_data.py --vectors 4000
  ```

  This also writes `tests/calc-vectors.json` (gitignored): about 4,000 calculations recorded
  from the app's own engine. Check the web engine against them:

  ```powershell
  node tests/run-calc-vectors.mjs
  ```

  It must report 0 mismatches, and it skips nothing.

  The same export writes `data/builder/known-teams.json`, the tournament teams the
  Companion ships (`--teams-only` writes just that file).

  Everything past the damage formula is checked the same way, against recordings of the
  running app made with the scratchpad harness (these files are gitignored and never
  shipped): `run-eval-vectors.mjs all` (Team Evaluation, checks, synergy, speed, payload),
  `run-suggest-vectors.mjs`, `run-autobuild-vectors.mjs`, `run-optimize-vectors.mjs` and
  `run-overview-vectors.mjs` (Speed list and Team Overview charts). Each must report 0
  mismatches after an app change is recorded again. `run-autobuild-vectors.mjs` also reads
  `autobuild-vectors-options.json`, builds recorded with a Preferred archetype or Prioritize
  Meta Pokemon.

  Auto Build departs from the app on purpose in three places, each a fix for an app bug the
  recordings exposed (the test replays the app's own behaviour where they apply):
  - Prioritize Meta Pokemon ranks the Top-X meta ahead once the red/yellow checks, the Speed
    plan and the chosen archetype are settled. In the app that tier sits under a later sort
    that overwrites it, so the option never changes a pick there. Its Top X is the Team
    Evaluation's, up to every ranked Pokemon (`topMetaSize`; the app capped it at 100, its
    own Settings maximum).
  - On the last slot, the finished-team rules (at most two attacking types without a
    switch-in, no Trick Room the team cannot use, no terrain that misses half of it) pick the
    candidate that breaks the fewest instead of rejecting all of them. The app stops with "did
    not find a structurally fitting Pokemon" whenever its own forced archetype picks made the
    rules impossible (Trick Room, Tailwind and Rain on Garchomp/Rillaboom/Sylveon all did).
  - A chosen Trick Room or Tailwind archetype decides the speed mode, so the finish passes no
    longer swap the team's Trick Room out again, and a Trick Room team is not rejected for
    carrying Trick Room.

  The page goes further than the app's Auto Build, which is greedy (every slot commits its
  first pick; its own deeper stages, V459 finalist sets and Phase-2 "Adjust against Meta",
  are switched off by V467 and V469). `TeamAutoBuild.run(sets, {search})` runs the app's
  path unchanged when `search` is `"companion"` (the default, which
  `run-autobuild-vectors.mjs` checks); the worker passes the chosen depth instead, and
  `builder/autobuild-search.js` runs:
  - the anchor: the app's greedy path at that depth, built from `buildSlots`' pieces
    (`prepareSlot`, `screenCandidate`, `finishFilter`, `pickFromRanked`, `applyPick`). It is
    always one of the compared teams and the result when nothing beats it.
  - a beam over partial teams (Fast 2 teams, Medium 3, Deep 4, the anchor's line always
    kept): each keeps its greedy pick plus the next best candidates; side branches screen a
    shortlist (the best of the slot before and of the anchor's screening of the same slot,
    plus the Megas and archetype specialists the pool would reserve); alternative picks try
    up to 2 (Medium) or 3 (Deep) V449 sets ranked by the app's `_v459_structural_key`; at
    most half the beam may share its first pick, or the greedy line's siblings crowd out
    every other first pick.
  - a comparison of every complete team through the same finish chain and the full Team
    Evaluation. `beats()` compares tier by tier and the first tier that differs decides:
    fewer red Team Building Checks failed, then fewer yellow ones, then (with a chosen
    archetype) fewer unmet critical requirements of it, then (with Prioritize Meta) fewer
    added members from outside the Top X, and only when all of those tie a score at least
    `margin` (1.0) higher on T = mean(Synergy, Offense, Defense, Speed) - 1.0 x threats
    scoring 70+ (`SEARCH_OBJECTIVE`, `OBJECTIVE_TIERS`). The page's "Compared teams" note and
    the log sentence (`replacedBecause`) name that rule and the tier that decided.
  - Medium/Deep: one repair swap of a member Auto Build added (kept members never), judged
    by the same rule; with Prioritize Meta the Top X alternatives are tried first.

  The work is bounded by counts (`SEARCH_PROFILES`: beam, children, shortlist sizes,
  finalist sets, repair targets, candidates and pool), not by the clock, so the same input
  gives the same team on a fast or a slow machine. The clock is only a safety cap on the
  whole run (`capMs`: 24 / 44 / 66 s, about twice the old deadlines); when it cuts a step,
  `search.capped` and `search.cut` say which, and the page says the search hit its time
  limit. Deep's shortlist (45) and repair (2 targets, 5 of 80 candidates) were cut after a
  cold Deep build of an empty team took 45-54 s. Measured in Node on 2026-09-22 since: Deep
  cold 40-45 s (empty team, about 25 s of it the anchor) and 31-32 s (three kept), warm 8-9 s
  and 5-7 s; Medium cold 18-21 s, warm 5-6 s; Fast cold 10 s, warm 1-3 s; a warm run on a clock
  1.5x slower picked the same team. The run yields every ~0.1 s; the evaluator's per-move mode (V458) is set
  only inside those synchronous chunks, so other worker requests never see it. Stop (a
  `cancel` message) returns the best team so far: instantly once the first team is
  finished, and within ~0.3 s before that (the rest filled from a dozen candidates per
  slot, the calc-heavy finish passes and the evaluation skipped, which the result says).
  `node tests/run-autobuild-search.mjs` (`full` for every start x archetype x Prioritize
  Meta x depth, `TOUR=N` to also play every compared team against N tournament teams)
  checks that the result is never worse than the anchor, the log names the tier that
  decided, Prioritize Meta is not overridden by the score, kept members stay, Item Clause,
  Mega and switch-in rules hold, runs repeat (also on a 1.5x slower clock), the cold timings
  and Stop, and reports how often and by how much the search beats the anchor under other
  weights. On 2026-09-22 the quick matrix (17 builds, Doubles and Singles) kept another team
  than the anchor in 15: on average 0.7 fewer failing checks, +2.2 mean score and 1.9 fewer
  threats at 70+. An earlier run with `TOUR=300` (before the Deep cut) found those teams
  averaging +0.7 in the tournament test, and the objective ordering 73% of team pairs the
  way the tournament average does (weight 0.5 scored +0.8, within noise, so 1.0 / 1.0 stayed).

  Different Auto Build and Suggestions results from the Companion mostly come from the data,
  not the search: the Companion 1.0.17 ships the 14 Sep battle data, the site regenerates
  `meta-*.json` daily. On the same data the greedy anchor and the Suggestions list are the
  app's (the parity suites).

  Suggestions keep their order and scores (`run-suggest-vectors.mjs`); what the breakdown
  shows is extra: every layer's share of the score (`score_ledger`, `score_uncapped`; the
  score is capped at 100, so ties there fall back to meta rank), the calcs behind each
  type-fit answer (`answer_calcs_v494`, including the ones the calc strikes), and, after the
  list is sent, a check of each shown row against the full Team Evaluation of the team it
  would make (`TeamSuggestions.projectedDetail`: the four scores, the critical threats whose
  scores fall or rise, and the threats the newcomer really answers). "Only Box" tries the Box
  (`boxCandidates`, shared with Auto Build's Only Box).
- `data/builder/meta-doubles.json` and `meta-singles.json` are written by
  `tools/generate-manifest.mjs` (via `tools/builder-meta.mjs`) from the battle-data CSVs: the
  ranked Pokemon with their usage (moves, items, Abilities, and Natures and Stat Points as
  deep as the app reads them), used by every analysis and the calculator's "Top meta" picks.

Team Evaluation (Suggestions live inside an evaluation), Auto Build and Test against
Tournament Teams each run free three times per browser, then ask for Pro (`FREE_RUNS` in
`builder/pro.js`). The count is deliberately never shown for Team Evaluation and Auto Build;
the tournament test shows its free tries. Once they are used, pressing "Run again", "Evaluate
changes" or "Build again" keeps the result on screen and explains the limit in a dialog. With a
Pro key (the same key as the Companion, activated through `/api/license/activate`) they are
unlimited.

### Sync with the Companion

A sync code (`CBD-XXXX-XXXX-XXXX-XXXX`) names one document holding the teams and boxes.
`POST /api/sync` creates a code; `GET` and `PUT /api/sync/<code>` read and write it, with a
revision number so two writers cannot overwrite each other (`409` returns the current
document to merge onto). Both clients merge by id, keep the newest version of each team or
box, remember deletions for 90 days, and fold together identical teams or boxes created on
both sides. They write only when the merge changed something.

The document is stored in KV under a SHA-256 of the code, in the `SYNC` binding if one exists
and otherwise in `LICENSES` (keys are prefixed `sync:`). On the Workers free plan KV allows
1,000 writes a day across the account; if sync becomes popular, move it to a dedicated
namespace or a paid plan.

The app side is `pokemon_champions_tool/web_sync.py` and `web_sync_ui.py` in `pct_tool94`
(the Sync button next to Settings in the Team Builder).

### Testing locally

`python -m http.server` serves the pages but not the sync endpoint. `tests/dev-server.mjs`
serves the folder and routes `/api/sync*` to the real Functions with an in-memory KV:

```powershell
node tests/dev-server.mjs
```

Then open `http://127.0.0.1:8790/team-builder/`. Point the Companion at it with
`PCT_SYNC_API=http://127.0.0.1:8790/api/sync`. `tests/` is never deployed.

## API guide route

`/api_guide` is served by `functions/api_guide.js`, which returns the static `api_guide.html` page without redirecting to it. This avoids redirect loops on Cloudflare Pages while keeping `/api` reserved for the JSON API manifest.

If the browser still shows “redirected too many times” after deploying this version, clear the browser cache for the site or open the URL in a private window, because the old permanent redirect may have been cached.
