#!/usr/bin/env python3
"""Build the daily meta-trend snapshots that /meta/ reads.

This is the no-Node path. `tools/generate-manifest.mjs` writes exactly the same
files as part of the normal pipeline (see writeMetaTrends there) -- keep the two
in sync when the snapshot shape changes.

Output:
  data/meta/index.json                        seasons, dates and Pokemon lookup
  data/meta/<season>/<date>/<Format>.json     one snapshot per ranked day

A snapshot row always ends with the rank it was captured at, and any category
whose captured ranks are not 1..N is listed under "partial". About one in six
daily move lists is missing its opening ranks, so /meta/ needs that flag to
tell "this entry left the top 10" apart from "this day never captured it".

Run from the site root:
  python tools/build_meta_trends.py
"""

import csv
import json
import os
import re
from datetime import datetime, timezone

ASSET_ROOT = "pokemon_champions_assets"
BATTLE_DIR = os.path.join(ASSET_ROOT, "battle_data")
OUT_DIR = os.path.join("data", "meta")
MANIFEST = os.path.join("data", "pokemon-index.json")
VALID_FORMATS = ("Doubles", "Singles")
DATE_RE = re.compile(r"^\d{2}_\d{2}_\d{4}$")
STAT_COLUMNS = ["hp_points", "attack_points", "defense_points", "sp_atk_points", "sp_def_points", "speed_points"]
REGIONAL_FORM_RE = re.compile(r"\b(hisuian|alolan|galarian|paldean)\b", re.I)


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


def snapshot_from_folder(folder):
    """One ranked day of one format, keyed by the name used in the battle CSVs."""
    pokemon = {}
    for filename in sorted(os.listdir(folder)):
        if not filename.endswith(".csv"):
            continue
        with open(os.path.join(folder, filename), newline="", encoding="utf-8") as handle:
            rows = [row for row in csv.DictReader(handle) if (row.get("category") or "").strip()]
        if not rows:
            continue
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
                cells = [row.get("name") or ""]
            else:
                cells = [row.get("name") or "", percentage]
            entry.setdefault(category, []).append(cells + [rank])
        partial = [
            category for category, captured in sorted(ranks.items())
            if sorted(value for value in captured if value is not None) != list(range(1, len(captured) + 1))
        ]
        if partial:
            entry["partial"] = partial
        pokemon[rows[0].get("pokemon") or os.path.splitext(filename)[0]] = entry
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
    if not os.path.exists(MANIFEST):
        return {}
    with open(MANIFEST, encoding="utf-8") as handle:
        manifest = json.load(handle)
    lookup = {}
    for record in manifest.get("pokemon") or []:
        battle_name = record.get("battleName") or record.get("name") or ""
        summary = record.get("summary") or {}
        primary = summary.get("primary") or {}
        lookup[battle_name] = {
            "name": battle_name,
            "baseName": base_display_name(battle_name, primary),
            "slug": record.get("slug") or "",
            "sprite": summary.get("sprite") or primary.get("image_path") or "",
            "types": summary.get("types") or primary.get("types") or [],
        }
    return lookup


def write_json(path, payload):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as handle:
        handle.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")


def main():
    if not os.path.isdir(BATTLE_DIR):
        raise SystemExit(f"Expected {BATTLE_DIR}/ to exist. Run this from the site root.")

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
                pokemon = snapshot_from_folder(folder)
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

    write_json(os.path.join(OUT_DIR, "index.json"), {
        "generatedAt": generated_at,
        "dataVersion": data_version,
        "assetRoot": ASSET_ROOT,
        "seasons": seasons,
        "pokemon": pokemon_lookup(),
    })
    print(f"Wrote {written} meta snapshot(s) across {len(seasons)} season(s) to {OUT_DIR}/.")


if __name__ == "__main__":
    main()
