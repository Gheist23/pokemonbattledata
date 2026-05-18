# Pokemon Champions Battle Data

Static, responsive website for `pokemonbattledata.com` that loads a fast public JSON index first, then lazy-loads individual CSV files only when a Pokemon profile is opened.

## Local preview

```powershell
node tools/generate-manifest.mjs
python -m http.server 5500 --bind 127.0.0.1
```

Open `http://127.0.0.1:5500`.

## Required asset layout

```text
pokemon_champions_assets/
  battle_data/
    Doubles/
      corviknight.csv
      garchomp.csv
    Singles/
      corviknight.csv
      garchomp.csv
  metadata/
    Corviknight.csv
    Garchomp.csv
  pokemon/
    Corviknight.png
    Garchomp.png
  types/
    Flying.png
    Steel.png
```

Battle CSV filenames may be lowercase, titlecase, or mixed case. The manifest generator pairs files by the Pokemon name inside the CSV first, then falls back to the filename.

## Generate the public data index

Regenerate the manifest after adding or replacing CSV files:

```powershell
node tools/generate-manifest.mjs
```

This updates:

```text
data/pokemon-index.json
```

The manifest includes lightweight metadata, sprites, type data, base stats, and indexed battle rows so the main page search loads almost instantly. Full CSV tables are fetched on demand when a Pokemon profile is opened.

## Advanced search

Plain text searches only Pokemon names. Field filters can be chained with commas or spaces, and chained filters use AND logic.

```text
Hatter, spe<100
spe>=120
atk>100
stats>=600
type=Ground
item=Choice Scarf
move:Earthquake
move<=5=Earthquake
item<=3=Choice Scarf
ability=Rough Skin
teammate:Sneasler
nature=Jolly
dex=445
```

## API page

Open `api.html` for the public static API documentation and endpoint examples.

## Deployment

Deploy the whole folder as static files. No build step is required after generating the manifest.
