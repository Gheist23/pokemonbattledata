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


## API guide route

`/api_guide` is served by `functions/api_guide.js`, which returns the static `api_guide.html` page without redirecting to it. This avoids redirect loops on Cloudflare Pages while keeping `/api` reserved for the JSON API manifest.

If the browser still shows “redirected too many times” after deploying this version, clear the browser cache for the site or open the URL in a private window, because the old permanent redirect may have been cached.
