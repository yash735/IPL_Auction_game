#!/usr/bin/env python3
"""Merge precomputed IPL player stats + curator metadata into a static auction pool.

This is the first half of the data pipeline. The heavy aggregation step will later
produce `players.json` from the IPL dataset CSV/JSON source. This script only
merges the aggregated stats with human-curated metadata and exports the final
static bundle consumed by the web app.

Expected inputs:
- players.json: keyed by normalized player name, containing career + season stats
- player_meta.json: keyed by normalized player name, containing role/nationality/
  base price/photo/form/overseas/capped flags

Output:
- auction_pool.json: the merged array used by the game
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List

DEFAULT_OUT = Path("public/data/auction_pool.json")


def slugify(name: str) -> str:
    name = name.strip().lower()
    name = re.sub(r"[^a-z0-9]+", "-", name)
    return name.strip("-")


def read_json(path: Path) -> Dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def merge_records(players: Dict[str, Any], meta: Dict[str, Any]) -> List[Dict[str, Any]]:
    merged: List[Dict[str, Any]] = []
    for key, stats in players.items():
        details = meta.get(key, {})
        record = {
            "id": details.get("id") or slugify(details.get("name", key)),
            "name": details.get("name", key),
            "role": details.get("role", "Batter"),
            "nationality": details.get("nationality", "India"),
            "isOverseas": bool(details.get("isOverseas", False)),
            "isCapped": bool(details.get("isCapped", True)),
            "basePrice": float(details.get("basePrice", 1.0)),
            "form": int(details.get("form", 50)),
            "previousTeam": details.get("previousTeam"),
            "photoUrl": details.get("photoUrl", ""),
            "seasons": stats.get("seasons", []),
            "career": stats.get("career", {}),
        }
        merged.append(record)
    merged.sort(key=lambda item: (-item["form"], item["name"]))
    return merged


def main() -> int:
    parser = argparse.ArgumentParser(description="Merge IPL aggregate stats + player metadata into auction_pool.json")
    parser.add_argument("--players", type=Path, default=Path("data/derived/players.json"), help="Aggregated stats JSON")
    parser.add_argument("--meta", type=Path, default=Path("data/derived/player_meta.json"), help="Curated player metadata JSON")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output auction pool JSON")
    args = parser.parse_args()

    if not args.players.exists():
      raise SystemExit(f"Missing aggregated stats file: {args.players}")
    if not args.meta.exists():
      raise SystemExit(f"Missing player metadata file: {args.meta}")

    players = read_json(args.players)
    meta = read_json(args.meta)
    merged = merge_records(players, meta)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(merged, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Wrote {len(merged)} players to {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
