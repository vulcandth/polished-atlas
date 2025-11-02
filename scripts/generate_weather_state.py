#!/usr/bin/env python3
"""Compute per-map weather state to mirror SetCurrentWeather and GetOvercastIndex.

Outputs a JSON at maps/weather_state.json with, for each map:
- constant name
- overcast index (null if not overcast)
- weather type (none | rain | thunderstorm | snow | sandstorm)

Weather selection rules mirror engine/events/weather.asm:
- If GetOvercastIndex > 0, choose rain vs thunderstorm (~25% thunder) deterministically
- Else snow on SNOWTOP_MOUNTAIN_[OUTSIDE|INSIDE]
- Else sandstorm on RUGGED_ROAD_[NORTH|SOUTH]
- Else none

Deterministic thunderstorm selection uses a hash of (map label, weekday, time_of_day).
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, Optional, Set

import atlas_common
import render_map


SNOW_MAPS = {"SNOWTOP_MOUNTAIN_OUTSIDE", "SNOWTOP_MOUNTAIN_INSIDE"}
SAND_MAPS = {"RUGGED_ROAD_NORTH", "RUGGED_ROAD_SOUTH"}


def _load_event_overrides(path: Optional[Path]) -> Dict[str, Set[str]]:
    result = {"set": set(), "clear": set()}
    if not path:
        return result
    resolved = path.resolve()
    if not resolved.exists():
        return result
    try:
        payload = json.loads(resolved.read_text(encoding="utf-8"))
        to_set = payload.get("set", []) or []
        to_clear = payload.get("clear", []) or []
        result["set"] = {str(x) for x in to_set if isinstance(x, str)}
        result["clear"] = {str(x) for x in to_clear if isinstance(x, str)}
    except Exception:
        # Ignore bad overrides silently
        pass
    return result


def _stable_ratio(*parts: str) -> float:
    """Return a stable pseudo-random ratio in [0,1) based on the input strings."""
    h = hashlib.sha256()
    for part in parts:
        h.update(part.encode("utf-8"))
        h.update(b"\x00")
    value = int.from_bytes(h.digest()[:8], "big")
    return (value % 1_000_000) / 1_000_000.0


def _determine_weather_for_map(
    repo: render_map.RepositoryIndex,
    info: render_map.MapInfo,
    *,
    weekday: int,
    time_of_day: int,
    events: Set[str],
) -> Dict[str, object]:
    overcast_index = repo.get_overcast_index(info, weekday=weekday, events=events)
    constant = info.constant
    weather: str
    if overcast_index is not None:
        # 25% thunderstorm, 75% rain; deterministic by label+weekday+time
        r = _stable_ratio(info.label, str(weekday), str(time_of_day))
        weather = "thunderstorm" if r < 0.25 else "rain"
    elif constant in SNOW_MAPS:
        weather = "snow"
    elif constant in SAND_MAPS:
        weather = "sandstorm"
    else:
        weather = "none"
    return {
        "constant": constant,
        "overcast_index": overcast_index,
        "weather": weather,
    }


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate per-map weather state JSON.")
    p.add_argument("--polishedcrystal", type=Path, default=atlas_common.DEFAULT_POLISHED_PATH)
    p.add_argument("--weekday", type=render_map.parse_weekday, default=1)
    p.add_argument("--time-of-day", dest="time_of_day", type=render_map.parse_time_of_day, default=1)
    p.add_argument("--event-overrides", type=Path, default=None, help="Optional JSON with {set, clear} event flags.")
    p.add_argument("--output", type=Path, default=atlas_common.DEFAULT_MAPS_DIR / "weather_state.json")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    polished_root = args.polishedcrystal.resolve()
    repo = atlas_common.repository(polished_root)

    overrides = _load_event_overrides(args.event_overrides)
    events = set(repo.initial_event_flags)
    events.difference_update(overrides.get("clear", set()))
    events.update(overrides.get("set", set()))

    maps: Dict[str, Dict[str, object]] = {}
    for info in repo.maps.values():
        maps[info.label] = _determine_weather_for_map(
            repo,
            info,
            weekday=args.weekday,
            time_of_day=args.time_of_day,
            events=events,
        )

    payload = {
        "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "weekday": int(args.weekday),
        "time_of_day": int(args.time_of_day),
        "maps": maps,
    }
    out_path = args.output.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote weather state to {out_path}")


if __name__ == "__main__":
    main()
