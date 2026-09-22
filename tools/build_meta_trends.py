#!/usr/bin/env python3
"""Build the daily meta-trend snapshots that /meta/ reads.

This is the no-Node path. `tools/generate-manifest.mjs` writes exactly the same
files as part of the normal pipeline (see writeMetaTrends there) -- keep the two
in sync when the snapshot shape or the name handling changes.  Run the Node
generator at least once first: the Pokemon lookup in index.json is read from
the data/pokemon-index.json it writes.

Output:
  data/meta/index.json                        seasons, dates, Pokemon lookup, old-name aliases
  data/meta/<season>/<date>/<Format>.json     one snapshot per ranked day

A snapshot row always ends with the rank it was captured at, and any category
whose captured ranks are not 1..N is listed under "partial". About one in six
daily move lists is missing its opening ranks, so /meta/ needs that flag to
tell "this entry left the top 10" apart from "this day never captured it".

Every Pokemon name -- the snapshot key and each teammate -- is written as its
Pokemon Showdown name, resolved the same way as generate-manifest.mjs does
(tools/showdown-species.json plus the dated old labels in
tools/legacy-pokemon-names.json).  The M6 days captured before 2026-09-14 still
say "Basculegion Male" in their teammate column, and 11_09 files Floette-Eternal
and Maushold-Four as plain "Floette" and "Maushold"; left raw, /meta/ would list
that as a Pokemon that dropped out and its current name as a new one.

Run from the site root:
  python tools/build_meta_trends.py
"""

import csv
import json
import os
import re
import unicodedata
from datetime import datetime, timezone

ASSET_ROOT = "pokemon_champions_assets"
BATTLE_DIR = os.path.join(ASSET_ROOT, "battle_data")
LEARNABLE_MOVES_DIR = os.path.join(ASSET_ROOT, "learnable_moves")
OUT_DIR = os.path.join("data", "meta")
MANIFEST = os.path.join("data", "pokemon-index.json")
SHOWDOWN_SPECIES = os.path.join("tools", "showdown-species.json")
LEGACY_NAMES = os.path.join("tools", "legacy-pokemon-names.json")
VALID_FORMATS = ("Doubles", "Singles")
DATE_RE = re.compile(r"^\d{2}_\d{2}_\d{4}$")
STAT_COLUMNS = ["hp_points", "attack_points", "defense_points", "sp_atk_points", "sp_def_points", "speed_points"]
REGIONAL_FORM_RE = re.compile(r"\b(hisuian|alolan|galarian|paldean)\b", re.I)
SHOWDOWN_REGION_NAMES = {"alolan": "Alola", "galarian": "Galar", "hisuian": "Hisui", "paldean": "Paldea"}
COMBINING_MARKS = re.compile(r"[\u0300-\u036f]")


def number(value):
    """Match JSON.stringify(Number(x)): integral floats serialize without a decimal."""
    if value is None or value == "":
        return None
    try:
        parsed = float(str(value).replace("%", "").strip())
    except ValueError:
        return None
    return int(parsed) if parsed == int(parsed) else parsed


def parse_date(value):
    match = DATE_RE.match(value or "")
    if not match:
        return None
    day, month, year = value.split("_")
    return datetime(int(year), int(month), int(day), tzinfo=timezone.utc)


def season_number(value):
    match = re.search(r"\bM-?(\d+)\b", value or "", re.I)
    return int(match.group(1)) if match else None


def season_sort_key(season):
    number_part = season_number(season)
    return (0, -number_part) if number_part is not None else (1, season)


def unique(values):
    seen = []
    for value in values:
        if value is None or value == "" or value in seen:
            continue
        seen.append(value)
    return seen


# ---------------------------------------------------------------------------
# Pokemon names -- a port of the resolver in tools/generate-manifest.mjs
# ---------------------------------------------------------------------------


def title_case(value):
    """JS titleCase: word starts are ASCII word boundaries, as in a JS regex."""
    text = re.sub(r"[_-]+", " ", str(value or "")).lower()
    return re.sub(r"\b\w", lambda match: match.group(0).upper(), text, flags=re.ASCII)


def api_name_key(value):
    text = COMBINING_MARKS.sub("", unicodedata.normalize("NFKD", str(value or ""))).lower()
    return re.sub(r"[^a-z0-9]+", "", text)


def record_key(value):
    text = COMBINING_MARKS.sub("", unicodedata.normalize("NFKD", str(value or ""))).lower()
    text = re.sub(r"[_-]+", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def load_json(path, fallback):
    if not os.path.exists(path):
        return fallback
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


SHOWDOWN_BY_KEY = {}
for _species_id, _species in (load_json(SHOWDOWN_SPECIES, {}) or {}).items():
    _entry = {
        "id": _species_id,
        "name": (_species or {}).get("name") or _species_id,
        "baseSpecies": (_species or {}).get("baseSpecies") or "",
        "formeOrder": (_species or {}).get("formeOrder") or [],
    }
    for _alias in (_species_id, _entry["name"]):
        _key = api_name_key(_alias)
        if _key and _key not in SHOWDOWN_BY_KEY:
            SHOWDOWN_BY_KEY[_key] = _entry

_LEGACY = load_json(LEGACY_NAMES, {}) or {}
LEGACY_TEAMMATE_SCOPE = (_LEGACY.get("teammateNames") or {})
LEGACY_TEAMMATE_NAMES = LEGACY_TEAMMATE_SCOPE.get("names") or {}


def showdown_suffix(value):
    text = title_case(value)
    for word in (r"\bForme?\b", r"\bMode\b", r"\bPattern\b", r"\bFlower\b", r"\bBreed\b",
                 r"\bVariety\b", r"\bPlumage\b", r"\bOf\b"):
        text = re.sub(word, "", text, flags=re.I | re.ASCII)
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+", "-", text)
    return re.sub(r"Poke-Ball", "Pokeball", text, flags=re.I)


def showdown_name_candidates(name):
    raw = str(name or "").strip()
    if not raw:
        return []
    candidates = [raw, re.sub(r"\s+", "-", raw)]
    add = candidates.append

    match = re.match(r"^(.+?)\s+Form\s+(\d+)$", raw, re.I)
    if match:
        base = SHOWDOWN_BY_KEY.get(api_name_key(match.group(1)))
        order = base["formeOrder"] if base and not base["baseSpecies"] else []
        index = int(match.group(2))
        forme = order[index] if index < len(order) else ""
        if forme and order.count(forme) == 1:
            add(forme)

    match = re.match(r"^Mega\s+(.+?)(?:\s+([XYZ]))?$", raw, re.I)
    if match:
        suffix = f"-{match.group(2).upper()}" if match.group(2) else ""
        add(f"{title_case(match.group(1))}-Mega{suffix}")
        if not match.group(2):
            add(f"{title_case(match.group(1))}-M-Mega")

    match = re.match(r"^(Alolan|Galarian|Hisuian|Paldean)\s+(.+)$", raw, re.I)
    if match:
        region = SHOWDOWN_REGION_NAMES.get(match.group(1).lower()) or title_case(match.group(1))
        add(f"{title_case(match.group(2))}-{region}")

    match = re.match(r"^Paldean\s+Tauros\s+(.+?)\s+Breed$", raw, re.I)
    if match:
        add(f"Tauros-Paldea-{showdown_suffix(match.group(1))}")

    match = re.match(r"^(.+?)\s+(Male|Female)$", raw, re.I)
    if match:
        add(f"{title_case(match.group(1))}-F" if match.group(2).lower() == "female" else title_case(match.group(1)))

    match = re.match(r"^(Fan|Frost|Heat|Mow|Wash)\s+Rotom$", raw, re.I)
    if match:
        add(f"Rotom-{title_case(match.group(1))}")

    match = re.match(r"^(.+?)\s+(Rainy|Snowy|Sunny)\s+Form$", raw, re.I)
    if match:
        add(f"{title_case(match.group(1))}-{title_case(match.group(2))}")

    match = re.match(r"^Aegislash\s+(Blade|Shield)\s+Forme$", raw, re.I)
    if match:
        add("Aegislash-Blade" if match.group(1).lower() == "blade" else "Aegislash")

    match = re.match(r"^(.+?)\s+Busted\s+Form$", raw, re.I)
    if match:
        add(f"{title_case(match.group(1))}-Busted")

    match = re.match(r"^(.+?)\s+Hangry\s+Mode$", raw, re.I)
    if match:
        add(f"{title_case(match.group(1))}-Hangry")

    match = re.match(r"^Palafin\s+(Hero|Zero)\s+Form$", raw, re.I)
    if match:
        add("Palafin-Hero" if match.group(1).lower() == "hero" else "Palafin")

    match = re.match(r"^(Polteageist|Sinistcha)\s+(.+?)\s+Form$", raw, re.I)
    if match:
        add(f"{title_case(match.group(1))}-{showdown_suffix(match.group(2))}")

    match = re.match(r"^Gourgeist\s+(.+?)\s+Variety$", raw, re.I)
    if match:
        add("Gourgeist-" + re.sub(r"^Jumbo$", "Super", showdown_suffix(match.group(1)), flags=re.I))

    match = re.match(r"^Lycanroc\s+(.+?)\s+Form$", raw, re.I)
    if match:
        add(f"Lycanroc-{showdown_suffix(match.group(1))}")

    match = re.match(r"^Vivillon\s+(.+?)\s+Pattern$", raw, re.I)
    if match:
        add(f"Vivillon-{showdown_suffix(match.group(1))}")

    match = re.match(r"^Florges\s+(.+?)\s+Flower$", raw, re.I)
    if match:
        add("Florges" if match.group(1).lower() == "red" else f"Florges-{showdown_suffix(match.group(1))}")

    if re.match(r"^Furfrou\s+Natural\s+Form$", raw, re.I):
        add("Furfrou")

    match = re.match(r"^Maushold\s+Family\s+Of\s+(Three|Four)$", raw, re.I)
    if match:
        add("Maushold-Four" if match.group(1).lower() == "four" else "Maushold")

    match = re.match(r"^Alcremie\s+(.+)$", raw, re.I)
    if match and raw.lower() != "alcremie":
        add(f"Alcremie-{showdown_suffix(match.group(1))}")

    match = re.match(r"^(.+?)\s+(Antique|Masterpiece)\s+Form$", raw, re.I)
    if match:
        add(f"{title_case(match.group(1))}-{showdown_suffix(match.group(2))}")

    add(showdown_suffix(raw))
    return unique(candidates)


_RESOLVE_CACHE = {}


def resolve_showdown_name(name):
    raw = str(name or "").strip()
    if not raw:
        return None
    if raw not in _RESOLVE_CACHE:
        found = None
        for candidate in showdown_name_candidates(raw):
            found = SHOWDOWN_BY_KEY.get(api_name_key(candidate))
            if found:
                break
        _RESOLVE_CACHE[raw] = found
    return _RESOLVE_CACHE[raw]


def legacy_teammate_names_apply(season, date):
    scope_season = LEGACY_TEAMMATE_SCOPE.get("season") or ""
    if not scope_season or season != scope_season:
        return False
    day = parse_date(date)
    last = parse_date(LEGACY_TEAMMATE_SCOPE.get("lastDate") or "")
    return day is not None and last is not None and day <= last


def canonical_pokemon_name(name, season="", date=""):
    """generate-manifest.mjs canonicalPokemonName: the dated old label first
    (only inside its M6 window), otherwise the Showdown resolver.  Used for
    the snapshot key as well as every teammate cell."""
    raw = str(name or "").strip()
    if not raw:
        return raw
    if legacy_teammate_names_apply(season, date) and raw in LEGACY_TEAMMATE_NAMES:
        return LEGACY_TEAMMATE_NAMES[raw]
    found = resolve_showdown_name(raw)
    return found["name"] if found else raw


def registration_keys(name, key_fn):
    keys = [key_fn(name)]
    species = resolve_showdown_name(name)
    if species:
        keys.append(key_fn(species["name"]))
    return unique(keys)


def lookup_keys(name, key_fn):
    keys = [key_fn(name)]
    species = resolve_showdown_name(name)
    if species:
        keys.append(key_fn(species["name"]))
        if species["baseSpecies"]:
            keys.append(key_fn(species["baseSpecies"]))
    return unique(keys)


def learnset_index():
    """Learnable-move file stems by key, as generate-manifest.mjs indexes them."""
    stems = []
    if os.path.isdir(LEARNABLE_MOVES_DIR):
        for root, _dirs, files in os.walk(LEARNABLE_MOVES_DIR):
            stems.extend(os.path.splitext(name)[0] for name in files if name.lower().endswith(".csv"))
    stems.sort()
    by_key = {}
    for stem in stems:
        by_key[record_key(stem)] = stem
    for stem in stems:
        for key in registration_keys(stem, record_key)[1:]:
            if key and key not in by_key:
                by_key[key] = stem
    return by_key


# ---------------------------------------------------------------------------
# snapshots
# ---------------------------------------------------------------------------


def snapshot_from_folder(folder, season, date):
    """One ranked day of one format, keyed by the Showdown name."""
    pokemon = {}
    for filename in sorted(os.listdir(folder)):
        if not filename.endswith(".csv"):
            continue
        with open(os.path.join(folder, filename), newline="", encoding="utf-8") as handle:
            rows = [row for row in csv.DictReader(handle) if (row.get("category") or "").strip()]
        if not rows:
            continue
        raw_name = rows[0].get("pokemon") or os.path.splitext(filename)[0]
        rows.sort(key=lambda row: number(row.get("rank")) or 0)
        entry = {"position": number(rows[0].get("column_position"))}
        ranks = {}
        for row in rows:
            category = row["category"]
            percentage = number(row.get("percentage"))
            rank = number(row.get("rank"))
            ranks.setdefault(category, []).append(rank)
            if category == "stat_points":
                cells = [percentage] + [number(row.get(key)) for key in STAT_COLUMNS]
            elif category == "stat_alignment":
                cells = [row.get("name") or "", percentage, row.get("stat_up") or "", row.get("stat_down") or ""]
            elif category == "teammate":
                cells = [canonical_pokemon_name(row.get("name") or "", season, date)]
            else:
                cells = [row.get("name") or "", percentage]
            entry.setdefault(category, []).append(cells + [rank])
        partial = [
            category for category, captured in sorted(ranks.items())
            if sorted(value for value in captured if value is not None) != list(range(1, len(captured) + 1))
        ]
        if partial:
            entry["partial"] = partial
        # The snapshot key goes through the same dated labels as the teammates:
        # M6 11_09 filed Floette-Eternal as plain "Floette".
        canonical = canonical_pokemon_name(raw_name, season, date)
        pokemon[raw_name if canonical in pokemon else canonical] = entry
    return pokemon


def base_display_name(battle_name, primary):
    """Mirror app.js displayNameForBattleName -- the label the explorer shows.

    Kept only as a secondary label: it collapses forms (four Rotom entries all
    become "Rotom"), which a ranking table cannot afford, so /meta/ labels rows
    with the battle name instead.
    """
    base_name = (primary.get("pokemon_name") or primary.get("base_name") or "").strip()
    if base_name and not REGIONAL_FORM_RE.search(battle_name or ""):
        return base_name
    return battle_name


def pokemon_lookup():
    """The index.json "pokemon" lookup and "aliases" map, from the manifest."""
    if not os.path.exists(MANIFEST):
        return {}, {}
    with open(MANIFEST, encoding="utf-8") as handle:
        manifest = json.load(handle)
    learnsets = learnset_index()
    records = manifest.get("pokemon") or []
    lookup = {}
    for record in records:
        battle_name = record.get("battleName") or record.get("name") or ""
        summary = record.get("summary") or {}
        primary = summary.get("primary") or {}
        learnset = next((learnsets[key] for key in lookup_keys(battle_name, record_key) if key in learnsets), "")
        info = {
            "name": battle_name,
            "baseName": base_display_name(battle_name, primary),
            "slug": record.get("slug") or "",
            "sprite": summary.get("sprite") or primary.get("image_path") or "",
            "types": summary.get("types") or primary.get("types") or [],
            "learnset": learnset,
        }
        lookup[battle_name] = info
        showdown_name = record.get("showdownName")
        if showdown_name and showdown_name not in lookup:
            lookup[showdown_name] = info

    targets = {}

    def add_alias(source, target):
        if not source or not target or source == target:
            return
        targets.setdefault(source, [])
        if target not in targets[source]:
            targets[source].append(target)

    for source, target in LEGACY_TEAMMATE_NAMES.items():
        add_alias(source, target)
    for record in records:
        for form in (record.get("summary") or {}).get("forms") or []:
            add_alias(form.get("saved_name"), form.get("showdown_name"))
    aliases = {source: found[0] for source, found in sorted(targets.items()) if len(found) == 1}
    return lookup, aliases


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")


def main():
    if not os.path.isdir(BATTLE_DIR):
        raise SystemExit(f"Expected {BATTLE_DIR}/ to exist. Run this from the site root.")
    if not SHOWDOWN_BY_KEY:
        raise SystemExit(f"Could not read {SHOWDOWN_SPECIES}; without it Pokemon names cannot be "
                         "brought to their Showdown spelling. Run `node tools/generate-manifest.mjs` instead.")

    generated_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    data_version = re.sub(r"\D", "", generated_at)

    seasons = []
    written = 0
    for season in sorted(os.listdir(BATTLE_DIR), key=season_sort_key):
        season_dir = os.path.join(BATTLE_DIR, season)
        if not os.path.isdir(season_dir) or season in VALID_FORMATS:
            continue
        dates = sorted(
            (name for name in os.listdir(season_dir) if DATE_RE.match(name) and os.path.isdir(os.path.join(season_dir, name))),
            key=lambda name: parse_date(name),
            reverse=True,
        )
        formats = []
        for date in dates:
            for battle_format in VALID_FORMATS:
                folder = os.path.join(season_dir, date, battle_format)
                if not os.path.isdir(folder):
                    continue
                pokemon = snapshot_from_folder(folder, season, date)
                if not pokemon:
                    continue
                write_json(os.path.join(OUT_DIR, season, date, f"{battle_format}.json"), {
                    "season": season,
                    "date": date,
                    "format": battle_format,
                    "generatedAt": generated_at,
                    "pokemon": pokemon,
                })
                written += 1
                if battle_format not in formats:
                    formats.append(battle_format)
        if dates and formats:
            seasons.append({"season": season, "dates": dates, "formats": formats})

    lookup, aliases = pokemon_lookup()
    write_json(os.path.join(OUT_DIR, "index.json"), {
        "generatedAt": generated_at,
        "dataVersion": data_version,
        "assetRoot": ASSET_ROOT,
        "seasons": seasons,
        "pokemon": lookup,
        "aliases": aliases,
    })
    print(f"Wrote {written} meta snapshot(s) across {len(seasons)} season(s) to {OUT_DIR}/.")


if __name__ == "__main__":
    main()
