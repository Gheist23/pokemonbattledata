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
Deploy command: npx wrangler pages deploy . --project-name pokemonbattledata
Build output directory: .
Root directory: /
```

Do not use `npx wrangler deploy` for this project. This site uses Cloudflare Pages
with a `functions` directory, so the deploy command must use `wrangler pages deploy`.

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
