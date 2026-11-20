"""Work out what moved in the meta this week and hand it to the watch list.

    python tools/meta_digest.py --dry-run          # print the diff, send nothing
    python tools/meta_digest.py --key <DIGEST_KEY> # compute and POST

WHY THE DIFF IS COMPUTED HERE AND NOT IN THE WORKER.  The snapshots are
`data/meta/<season>/<date>/<Format>.json` and each is about 340 KB of nested
arrays.  Parsing two of them would spend a free-tier Worker's whole CPU budget
before a single mail was rendered, so the endpoint
(functions/api/watch/digest.js) is a renderer and a sender only, and this -- the
process that already has the tree on disk and an interpreter running -- does the
arithmetic and posts a few hundred bytes.

WHAT COUNTS AS NEWS.  `position` is the 1-based usage rank, so a SMALLER number
is more used and a riser's rank goes DOWN.  Two filters keep the mail honest:

  * it has to involve the top RELEVANT_RANK, because a Pokemon going from 238th
    to 221st is true, uninteresting, and crowds out the thing that matters; and
  * it has to clear a threshold that SCALES WITH THE BAND, which is the part
    that is easy to get wrong.  Ranks compress at the top: #5 to #1 is an
    enormous shift in usage and only four places, while #95 to #74 is twenty-one
    places and barely a change in how often anybody meets it.  A flat "five
    ranks" therefore mails the deep noise and misses every real move at the top
    -- measured on 19 Nov 2026 it reported five Doubles movers, all between #41
    and #103, and nothing from the top forty, which is the only part of the
    table a team is actually built against.  So the bar is
    `max(MIN_MOVE_TOP, BAND_SHARE * min(from, to))`: two places at #10, three at
    #25, six at #50, twelve at #100.

The comparison day is the nearest snapshot at least COMPARE_DAYS old, found by
walking the dates the index actually lists rather than by subtracting seven days
from today -- the capture misses days, and asking for a date that was never
recorded is how this silently produces nothing.  If the season is younger than
that, the oldest day in it is used and the window is reported as it really is.

It never raises on a network or configuration problem: the daily publisher calls
it and a mail that did not go out is not a reason to fail a deploy.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

FORMATS = ("Doubles", "Singles")
META_DIR = os.path.join("data", "meta")
INDEX = os.path.join(META_DIR, "index.json")

COMPARE_DAYS = 7
MIN_MOVE_TOP = 2      # ranks; the floor, which only the very top of the table uses
BAND_SHARE = 0.12     # a move must be this share of the rank it happened at
RELEVANT_RANK = 80    # a move must touch the part of the table anybody plays
MAX_MOVERS = 12       # per direction, which is far more than a mail shows

DEFAULT_ENDPOINT = "https://championsbattledata.com/api/watch/digest"

# CLOUDFLARE BLOCKS THE DEFAULT urllib USER-AGENT. Verified against the live site on 20 Nov 2026:
# a POST sent as "Python-urllib/3.11" is refused with 403 and Cloudflare error code 1010 ("banned
# based on your browser's signature") before it ever reaches the Pages Function, while the same
# request with any ordinary User-Agent answers 200. Nothing in the project's own config does this
# -- it is the zone's default bot handling, so it would also have applied to any other urllib
# caller added later.
#
# This is the exact shape of failure the whole design is meant to avoid: the publisher would have
# printed one "failed (HTTP Error 403)" line into a log nobody reads, every morning, and the list
# would simply never have been mailed. It is named here so the next person does not spend an hour
# on the key.
#
# A plain client name and a version. NOT an email address or anything identifying the operator.
USER_AGENT = "championsbattledata-meta-digest/1"


def load(path):
    with io.open(path, "r", encoding="utf-8") as handle:
        return json.load(handle)


def parse_date(name):
    """'19_11_2026' -> date, or None for anything that is not one."""
    try:
        return _dt.datetime.strptime(name, "%d_%m_%Y").date()
    except ValueError:
        return None


def pick_days(dates):
    """(latest, comparison) from the dates the index lists, newest first.

    Returns (None, None) when there is not enough history to say anything.
    """
    ordered = sorted(
        (parsed for parsed in (parse_date(name) for name in dates) if parsed),
        reverse=True,
    )
    if len(ordered) < 2:
        return None, None
    latest = ordered[0]
    wanted = latest - _dt.timedelta(days=COMPARE_DAYS)
    # The newest day that is at least COMPARE_DAYS old; failing that, the oldest
    # we have, so a young season still produces a real window.
    older = [day for day in ordered[1:] if day <= wanted]
    return latest, (older[0] if older else ordered[-1])


def stamp(day):
    """The folder name a snapshot lives under."""
    return day.strftime("%d_%m_%Y")


def label(day):
    """The same day as a person reads it. `asOf` and `since` are DISPLAY values:
    the endpoint only ever prints them, so sending "12 Nov" rather than
    "12_11_2026" saves it having to guess at a date format it was not given."""
    return day.strftime("%d %b").lstrip("0")


def ranks(root, season, day, battle_format):
    path = os.path.join(root, META_DIR, season, stamp(day), "%s.json" % battle_format)
    if not os.path.exists(path):
        return {}
    try:
        payload = load(path)
    except (ValueError, OSError):
        return {}
    out = {}
    for name, entry in (payload.get("pokemon") or {}).items():
        position = entry.get("position")
        if isinstance(position, int) and position > 0:
            out[name] = position
    return out


def threshold(from_rank, to_rank):
    """How many places a move at this part of the table has to cover to be news."""
    return max(MIN_MOVE_TOP, BAND_SHARE * min(from_rank, to_rank))


def significance(from_rank, to_rank):
    """A move's size relative to where it happened, so movers from different
    parts of the table can be ranked against each other and the mail leads with
    the one that changes most games."""
    return abs(from_rank - to_rank) / float(min(from_rank, to_rank))


def diff(now, before):
    """([risers], [fallers]) as [name, from_rank, to_rank], biggest move first."""
    risers, fallers = [], []
    for name, to_rank in now.items():
        from_rank = before.get(name)
        if not from_rank:
            continue
        if min(from_rank, to_rank) > RELEVANT_RANK:
            continue
        if abs(from_rank - to_rank) < threshold(from_rank, to_rank):
            continue
        (risers if from_rank > to_rank else fallers).append([name, from_rank, to_rank])
    # Sorted by relative size, not by places moved: a flat sort would put every
    # deep-table shuffle above a four-place climb into the top five.
    risers.sort(key=lambda row: significance(row[1], row[2]), reverse=True)
    fallers.sort(key=lambda row: significance(row[1], row[2]), reverse=True)
    return risers[:MAX_MOVERS], fallers[:MAX_MOVERS]


def build(root):
    """One payload per format, for whatever history exists. [] if there is none."""
    index_path = os.path.join(root, INDEX)
    if not os.path.exists(index_path):
        print("meta_digest: no %s -- run the generator first" % INDEX)
        return []
    try:
        index = load(index_path)
    except (ValueError, OSError) as error:
        print("meta_digest: %s is unreadable (%s)" % (INDEX, error))
        return []

    seasons = index.get("seasons") or []
    if not seasons:
        print("meta_digest: the index lists no seasons")
        return []
    season = seasons[0]
    name = season.get("season")
    latest, compare = pick_days(season.get("dates") or [])
    if not latest or not compare or latest == compare:
        print("meta_digest: season %s has too little history to diff" % name)
        return []

    payloads = []
    for battle_format in FORMATS:
        if battle_format not in (season.get("formats") or FORMATS):
            continue
        now = ranks(root, name, latest, battle_format)
        before = ranks(root, name, compare, battle_format)
        if not now or not before:
            print("meta_digest: %s has no snapshot pair in %s" % (battle_format, name))
            continue
        risers, fallers = diff(now, before)
        payloads.append({
            "format": battle_format,
            "asOf": label(latest),
            "since": label(compare),
            "risers": risers,
            "fallers": fallers,
        })
    return payloads


def post(endpoint, key, payload, dry_run):
    url = "%s?key=%s" % (endpoint, urllib.parse.quote(key))
    if dry_run:
        url += "&dryRun=1"
    body = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url, data=body, method="POST",
        headers={"content-type": "application/json", "User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".", help="the website root (default: here)")
    parser.add_argument("--key", default=os.environ.get("CBD_DIGEST_KEY", ""),
                        help="DIGEST_KEY; defaults to $CBD_DIGEST_KEY")
    parser.add_argument("--endpoint", default=os.environ.get("CBD_DIGEST_URL", DEFAULT_ENDPOINT))
    parser.add_argument("--dry-run", action="store_true",
                        help="print the diff and ask the endpoint to count without sending")
    parser.add_argument("--offline", action="store_true", help="print the diff and post nothing")
    args = parser.parse_args(argv)

    payloads = build(args.root)
    if not payloads:
        return 0

    for payload in payloads:
        print("meta_digest: %s %s vs %s -- %d up, %d down"
              % (payload["format"], payload["asOf"], payload["since"],
                 len(payload["risers"]), len(payload["fallers"])))
        for name, old, new in payload["risers"][:5]:
            print("    up    %-22s #%-3d -> #%d" % (name, old, new))
        for name, old, new in payload["fallers"][:5]:
            print("    down  %-22s #%-3d -> #%d" % (name, old, new))

    if args.offline:
        return 0
    if not args.key:
        # Not an error: the publisher runs this on a machine that may not hold
        # the key, and the rest of the publish is none of its business.
        print("meta_digest: no key, so nothing was posted (set CBD_DIGEST_KEY)")
        return 0

    for payload in payloads:
        try:
            answer = post(args.endpoint, args.key, payload, args.dry_run)
            print("meta_digest: %s -> %s" % (payload["format"], json.dumps(answer)))
        except (urllib.error.URLError, urllib.error.HTTPError, ValueError, OSError) as error:
            # A digest that did not send is never a reason to fail a deploy.
            print("meta_digest: %s failed (%s)" % (payload["format"], error))
    return 0


if __name__ == "__main__":
    sys.exit(main())
