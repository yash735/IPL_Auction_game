#!/usr/bin/env python3
"""Build IPL player stats and merged auction data from public cricket sources.

Phase 1 of the pipeline:
- Parse IPL match JSON files and aggregate batting / bowling stats.
- Emit a unified `players.json` keyed by normalized player name.
- Optionally merge a curated `player_meta.json` into `auction_pool.json`.

This script is intentionally offline-friendly and uses only the Python stdlib.
"""

from __future__ import annotations

import argparse
import json
import re
import unicodedata
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, DefaultDict, Dict, Iterable, List, Optional

DEFAULT_PLAYERS_OUT = Path("public/data/players.json")
DEFAULT_AUCTION_OUT = Path("public/data/auction_pool.json")
DEFAULT_META_OUT = Path("public/data/player_meta.json")
CREDITED_WICKET_KINDS = {
    "bowled",
    "caught",
    "caught and bowled",
    "lbw",
    "stumped",
    "hit wicket",
}

BASE_PRICE_SLABS = [
    (90, 2.0),
    (80, 1.5),
    (70, 1.0),
    (60, 0.75),
    (50, 0.5),
    (40, 0.3),
    (0, 0.2),
]


@dataclass
class BattingAccumulator:
    match_ids: set[str] = field(default_factory=set)
    innings: int = 0
    runs: int = 0
    balls: int = 0
    dismissals: int = 0
    fifties: int = 0
    hundreds: int = 0
    highest_score: int = 0
    boundaries: int = 0

    def add_innings(self, match_id: str, runs: int, balls: int, dismissals: int, boundaries: int) -> None:
        self.match_ids.add(match_id)
        self.innings += 1
        self.runs += runs
        self.balls += balls
        self.dismissals += dismissals
        self.boundaries += boundaries
        self.highest_score = max(self.highest_score, runs)
        if runs >= 50:
            self.fifties += 1
        if runs >= 100:
            self.hundreds += 1


@dataclass
class BowlingAccumulator:
    match_ids: set[str] = field(default_factory=set)
    innings: int = 0
    wickets: int = 0
    balls: int = 0
    runs_conceded: int = 0
    best_wickets: int = -1
    best_runs: int = 0

    def add_innings(self, match_id: str, wickets: int, balls: int, runs_conceded: int) -> None:
        self.match_ids.add(match_id)
        self.innings += 1
        self.wickets += wickets
        self.balls += balls
        self.runs_conceded += runs_conceded
        if self.best_wickets < 0 or wickets > self.best_wickets or (wickets == self.best_wickets and runs_conceded < self.best_runs):
            self.best_wickets = wickets
            self.best_runs = runs_conceded


@dataclass
class SeasonAccumulator:
    played: bool = False
    batting: BattingAccumulator | None = None
    bowling: BowlingAccumulator | None = None


@dataclass
class PlayerAccumulator:
    key: str
    name: str = ""
    cricsheet_id: str | None = None
    aliases: set[str] = field(default_factory=set)
    match_ids: set[str] = field(default_factory=set)
    seasons: dict[int, SeasonAccumulator] = field(default_factory=dict)
    career_batting: BattingAccumulator = field(default_factory=BattingAccumulator)
    career_bowling: BowlingAccumulator = field(default_factory=BowlingAccumulator)

    def prefer_name(self, candidate: str) -> None:
        candidate = candidate.strip()
        if not candidate:
            return
        self.aliases.add(candidate)
        if not self.name:
            self.name = candidate
            return
        if _display_score(candidate) > _display_score(self.name):
            self.name = candidate

    def season(self, season: int) -> SeasonAccumulator:
        if season not in self.seasons:
            self.seasons[season] = SeasonAccumulator()
        return self.seasons[season]


# ---------------------------------------------------------------------------
# Normalization / utilities


def normalize_key(name: str) -> str:
    """Return a stable player key from display text.

    Examples:
    - "A.B. de Villiers" -> "ab-de-villiers"
    - "S. R. Watson" -> "s-r-watson"
    """

    normalized = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode("ascii")
    normalized = normalized.lower().strip()
    parts = []
    for token in normalized.split():
        token = re.sub(r"[^a-z0-9]+", "", token)
        if token:
            parts.append(token)
    return "-".join(parts)


slugify = normalize_key


def _display_score(value: str) -> int:
    letters = sum(ch.isalpha() for ch in value)
    spaces = value.count(" ")
    punctuation = sum(ch in ".,;:'\"" for ch in value)
    return letters + (spaces * 2) - punctuation


def _choose_display_name(current: str, candidate: str) -> str:
    if not current:
        return candidate
    if _display_score(candidate) > _display_score(current):
        return candidate
    return current


def _safe_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except Exception:
        return default


def _safe_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except Exception:
        return default


def _legal_delivery(delivery: dict[str, Any]) -> bool:
    extras = delivery.get("extras") or {}
    return "wides" not in extras and "noballs" not in extras and "no_balls" not in extras


def _runs_conceded(delivery: dict[str, Any]) -> int:
    runs = delivery.get("runs") or {}
    extras = delivery.get("extras") or {}
    charge = _safe_int(runs.get("batter"), 0)
    charge += _safe_int(extras.get("wides"), 0)
    charge += _safe_int(extras.get("noballs", extras.get("no_balls")), 0)
    charge += _safe_int(extras.get("penalty"), 0)
    return charge


def _credits_bowler(kind: str | None) -> bool:
    return bool(kind) and kind.strip().lower() in CREDITED_WICKET_KINDS


def _extract_match_id(match: dict[str, Any], fallback: str) -> str:
    meta = match.get("meta") or {}
    for key in ("match_id", "id", "uuid"):
        value = meta.get(key)
        if value:
            return str(value)
    return fallback


def extract_season(match: dict[str, Any]) -> int:
    info = match.get("info") or {}
    season = info.get("season")
    if season is not None:
        return _safe_int(season, 0)
    dates = info.get("dates") or []
    if dates:
        return _safe_int(str(dates[0])[:4], 0)
    meta = match.get("meta") or {}
    created = meta.get("created")
    if created:
        return _safe_int(str(created)[:4], 0)
    return 0


# ---------------------------------------------------------------------------
# Aggregation


def _ensure_player(state: dict[str, PlayerAccumulator], name: str, cricsheet_id: str | None = None) -> PlayerAccumulator:
    key = normalize_key(name)
    player = state.get(key)
    if player is None:
        player = PlayerAccumulator(key=key, name=name.strip())
        state[key] = player
    player.prefer_name(name)
    if cricsheet_id and not player.cricsheet_id:
        player.cricsheet_id = cricsheet_id
    return player


def _finalize_batting(acc: BattingAccumulator) -> dict[str, Any]:
    strike_rate = round((acc.runs / acc.balls) * 100, 2) if acc.balls else 0.0
    average = round(acc.runs / acc.dismissals, 2) if acc.dismissals else 0.0
    boundary_pct = round((acc.boundaries / acc.balls) * 100, 2) if acc.balls else 0.0
    return {
        "matches": len(acc.match_ids),
        "innings": acc.innings,
        "runs": acc.runs,
        "balls": acc.balls,
        "strikeRate": strike_rate,
        "average": average,
        "fifties": acc.fifties,
        "hundreds": acc.hundreds,
        "highestScore": acc.highest_score,
        "boundaryPct": boundary_pct,
    }


def _finalize_bowling(acc: BowlingAccumulator) -> dict[str, Any]:
    economy = round(acc.runs_conceded / (acc.balls / 6), 2) if acc.balls else 0.0
    average = round(acc.runs_conceded / acc.wickets, 2) if acc.wickets else 0.0
    best_figures = "-"
    if acc.best_wickets >= 0:
        best_figures = f"{acc.best_wickets}/{acc.best_runs}"
    return {
        "matches": len(acc.match_ids),
        "wickets": acc.wickets,
        "balls": acc.balls,
        "runsConceded": acc.runs_conceded,
        "economy": economy,
        "average": average,
        "bestFigures": best_figures,
    }


def _finalize_season_snapshot(season: int, acc: SeasonAccumulator | None) -> dict[str, Any]:
    snapshot: dict[str, Any] = {"season": season, "played": bool(acc and acc.played)}
    if acc and acc.batting and acc.batting.innings > 0:
        snapshot["batting"] = _finalize_batting(acc.batting)
    if acc and acc.bowling and acc.bowling.innings > 0:
        snapshot["bowling"] = _finalize_bowling(acc.bowling)
    return snapshot


def aggregate_matches(matches: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Aggregate IPL-style match JSON into player-centric stats."""

    players: dict[str, PlayerAccumulator] = {}
    seasons_seen: set[int] = set()

    for index, match in enumerate(matches):
        season = extract_season(match)
        seasons_seen.add(season)
        match_id = _extract_match_id(match, str(index))
        info = match.get("info") or {}
        registry_people = ((info.get("registry") or {}).get("people")) or {}
        roster_map = info.get("players") or {}

        roster_names = set()
        for squad_names in roster_map.values():
            roster_names.update(squad_names or [])

        for roster_name in roster_names:
            player = _ensure_player(players, roster_name, registry_people.get(roster_name))
            player.match_ids.add(match_id)
            season_acc = player.season(season)
            season_acc.played = True

        innings_list = match.get("innings") or []
        for innings in innings_list:
            batting_innings: DefaultDict[str, dict[str, int]] = defaultdict(lambda: {"runs": 0, "balls": 0, "boundaries": 0, "dismissals": 0})
            bowling_innings: DefaultDict[str, dict[str, int]] = defaultdict(lambda: {"runs": 0, "balls": 0, "wickets": 0})
            batters_seen: set[str] = set()
            bowlers_seen: set[str] = set()
            dismissed_players: set[str] = set()

            for over in innings.get("overs", []):
                for delivery in over.get("deliveries", []):
                    batter = delivery.get("batter") or delivery.get("batsman")
                    bowler = delivery.get("bowler")
                    if not batter or not bowler:
                        continue

                    batters_seen.add(batter)
                    bowlers_seen.add(bowler)
                    batter_player = _ensure_player(players, batter, registry_people.get(batter))
                    bowler_player = _ensure_player(players, bowler, registry_people.get(bowler))
                    batter_player.match_ids.add(match_id)
                    bowler_player.match_ids.add(match_id)

                    batter_row = batting_innings[batter]
                    bowler_row = bowling_innings[bowler]
                    runs = delivery.get("runs") or {}
                    runs_off_bat = _safe_int(runs.get("batter"), 0)
                    if _legal_delivery(delivery):
                        batter_row["balls"] += 1
                        bowler_row["balls"] += 1
                    batter_row["runs"] += runs_off_bat
                    if runs_off_bat in (4, 6):
                        batter_row["boundaries"] += 1
                    bowler_row["runs"] += _runs_conceded(delivery)

                    wickets = delivery.get("wickets") or []
                    for wicket in wickets:
                        out_name = wicket.get("player_out") or wicket.get("playerOut")
                        if not out_name:
                            continue
                        dismissed_players.add(out_name)
                        dismissed_player = _ensure_player(players, out_name, registry_people.get(out_name))
                        dismissed_player.match_ids.add(match_id)
                        bat_row = batting_innings[out_name]
                        bat_row["dismissals"] += 1
                        kind = str(wicket.get("kind") or "").strip().lower()
                        if _credits_bowler(kind):
                            bowler_row["wickets"] += 1

            innings_players = set(batters_seen) | set(dismissed_players)
            for player_name in innings_players:
                player = _ensure_player(players, player_name, registry_people.get(player_name))
                season_acc = player.season(season)
                season_acc.played = True
                bat_row = batting_innings[player_name]
                if bat_row["runs"] or bat_row["balls"] or bat_row["boundaries"] or bat_row["dismissals"]:
                    if season_acc.batting is None:
                        season_acc.batting = BattingAccumulator()
                    season_acc.batting.add_innings(
                        match_id=match_id,
                        runs=bat_row["runs"],
                        balls=bat_row["balls"],
                        dismissals=bat_row["dismissals"],
                        boundaries=bat_row["boundaries"],
                    )
                    player.career_batting.add_innings(
                        match_id=match_id,
                        runs=bat_row["runs"],
                        balls=bat_row["balls"],
                        dismissals=bat_row["dismissals"],
                        boundaries=bat_row["boundaries"],
                    )

            for player_name in bowlers_seen:
                player = _ensure_player(players, player_name, registry_people.get(player_name))
                season_acc = player.season(season)
                season_acc.played = True
                bowl_row = bowling_innings[player_name]
                if bowl_row["balls"] or bowl_row["runs"] or bowl_row["wickets"]:
                    if season_acc.bowling is None:
                        season_acc.bowling = BowlingAccumulator()
                    season_acc.bowling.add_innings(
                        match_id=match_id,
                        wickets=bowl_row["wickets"],
                        balls=bowl_row["balls"],
                        runs_conceded=bowl_row["runs"],
                    )
                    player.career_bowling.add_innings(
                        match_id=match_id,
                        wickets=bowl_row["wickets"],
                        balls=bowl_row["balls"],
                        runs_conceded=bowl_row["runs"],
                    )

    selected_seasons = sorted([season for season in seasons_seen if season > 0])[-10:]
    result: dict[str, dict[str, Any]] = {}

    for key, player in players.items():
        seasons = [_finalize_season_snapshot(season, player.seasons.get(season)) for season in selected_seasons]
        result[key] = {
            "id": player.key,
            "name": player.name,
            "cricsheetId": player.cricsheet_id,
            "aliases": sorted(player.aliases - {player.name}),
            "seasons": seasons,
            "career": {
                "batting": _finalize_batting(player.career_batting),
                "bowling": _finalize_bowling(player.career_bowling),
            },
        }

    return dict(sorted(result.items(), key=lambda item: item[0]))


# ---------------------------------------------------------------------------
# Merge / meta helpers


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def infer_role(player: dict[str, Any]) -> str:
    role = player.get("role")
    if role:
        return role
    batting = (player.get("career") or {}).get("batting") or {}
    bowling = (player.get("career") or {}).get("bowling") or {}
    batting_runs = _safe_int(batting.get("runs"), 0)
    bowling_wickets = _safe_int(bowling.get("wickets"), 0)
    bowling_balls = _safe_int(bowling.get("balls"), 0)
    if batting_runs >= 1000 and bowling_wickets < 5:
        return "Batter"
    if bowling_wickets >= 15 and batting_runs < 500:
        return "Bowler"
    if batting_runs >= 300 or bowling_balls >= 150:
        return "All-rounder"
    return "Batter"


def derive_form(player: dict[str, Any]) -> int:
    meta_form = player.get("form")
    if meta_form is not None:
        return int(meta_form)
    batting = (player.get("career") or {}).get("batting") or {}
    bowling = (player.get("career") or {}).get("bowling") or {}
    batting_score = _safe_int(batting.get("runs"), 0) / 18 + _safe_float(batting.get("strikeRate"), 0.0) / 3.5
    bowling_score = _safe_int(bowling.get("wickets"), 0) * 3.2 + max(0.0, 40.0 - _safe_float(bowling.get("economy"), 0.0) * 4.5)
    role = infer_role(player)
    if role == "Batter":
        score = batting_score + bowling_score * 0.25
    elif role == "Bowler":
        score = bowling_score + batting_score * 0.15
    else:
        score = batting_score * 0.6 + bowling_score * 0.6
    return int(max(18, min(99, round(score))))


def derive_base_price(form: int) -> float:
    for threshold, price in BASE_PRICE_SLABS:
        if form >= threshold:
            return price
    return 0.2


def merge_records(
    players: dict[str, dict[str, Any]],
    meta: dict[str, dict[str, Any]],
    *,
    include_unmatched: bool = True,
    limit: int | None = None,
) -> List[dict[str, Any]]:
    merged: List[dict[str, Any]] = []
    for key, stats in players.items():
        details = meta.get(key)
        if details is None and not include_unmatched:
            continue

        role = infer_role(details or stats)
        meta_form = (details or {}).get("form")
        form = _safe_int(meta_form, derive_form(stats)) if meta_form is not None else derive_form(stats)
        base_price = _safe_float((details or {}).get("basePrice"), derive_base_price(form)) if details else derive_base_price(form)
        nationality = (details or {}).get("nationality") or "India"
        is_overseas = bool((details or {}).get("isOverseas", nationality != "India"))
        is_capped = bool((details or {}).get("isCapped", True))

        record = {
            "id": (details or {}).get("id") or slugify((details or {}).get("name", stats.get("name", key))),
            "name": (details or {}).get("name", stats.get("name", key)),
            "role": role,
            "nationality": nationality,
            "isOverseas": is_overseas,
            "isCapped": is_capped,
            "basePrice": round(base_price, 2),
            "form": form,
            "previousTeam": (details or {}).get("previousTeam"),
            "photoUrl": (details or {}).get("photoUrl", ""),
            "seasons": stats.get("seasons", []),
            "career": stats.get("career", {}),
            "cricsheetId": stats.get("cricsheetId"),
            "aliases": stats.get("aliases", []),
        }
        merged.append(record)

    merged.sort(key=lambda item: (-item["form"], item["name"]))
    if limit is not None:
        merged = merged[:limit]
    return merged


# ---------------------------------------------------------------------------
# File loading helpers


def load_matches_from_dir(match_dir: Path) -> List[dict[str, Any]]:
    paths = sorted(match_dir.rglob("*.json"))
    matches: List[dict[str, Any]] = []
    for path in paths:
        if path.name.endswith("teams_info.json"):
            continue
        if path.name.startswith("."):
            continue
        try:
            matches.append(load_json(path))
        except Exception:
            continue
    return matches


# ---------------------------------------------------------------------------
# CLI


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Aggregate IPL match JSON into auction-ready player data")
    parser.add_argument("--match-dir", type=Path, required=True, help="Directory containing IPL match JSON files")
    parser.add_argument("--players-out", type=Path, default=DEFAULT_PLAYERS_OUT, help="Where to write players.json")
    parser.add_argument("--meta", type=Path, default=None, help="Optional curated player_meta.json")
    parser.add_argument("--auction-out", type=Path, default=DEFAULT_AUCTION_OUT, help="Where to write auction_pool.json")
    parser.add_argument("--limit", type=int, default=180, help="Limit the final auction pool size")
    parser.add_argument("--no-unmatched", action="store_true", help="Drop players that do not exist in the curated meta file")
    args = parser.parse_args(argv)

    matches = load_matches_from_dir(args.match_dir)
    if not matches:
        raise SystemExit(f"No match JSON files found under {args.match_dir}")

    players = aggregate_matches(matches)
    write_json(args.players_out, players)
    print(f"Wrote {len(players)} players to {args.players_out}")

    meta: dict[str, dict[str, Any]] = {}
    if args.meta and args.meta.exists():
        meta = load_json(args.meta)
    if meta or not args.no_unmatched:
        auction_pool = merge_records(players, meta, include_unmatched=not args.no_unmatched, limit=args.limit)
        write_json(args.auction_out, auction_pool)
        print(f"Wrote {len(auction_pool)} auction players to {args.auction_out}")
    else:
        print("No meta file provided; skipped auction pool merge.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
