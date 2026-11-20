#!/usr/bin/env python3
"""Generate fixed scripted/scheduled weather using the shared build event state.

Random regional weather and random post-delivery cherry blossoms are omitted.
Time of day affects palettes, not the selected weather type.
"""
from __future__ import annotations

import argparse
import json
from datetime import datetime
from pathlib import Path
from typing import Dict, Set

import atlas_common
import render_map
from fixed_weather import fixed_weather


def _determine_weather_for_map(
    repo: render_map.RepositoryIndex,
    info: render_map.MapInfo,
    *,
    weekday: int,
    time_of_day: int,
    events: Set[str],
) -> Dict[str, object]:
    state = fixed_weather(info.constant, weekday, events)
    # Standalone rendering of the stable source retains its legacy overcast gate.
    if not repo.has_modern_weather:
        index = repo.get_overcast_index(info, weekday=weekday, events=events)
        weather = ('rain' if index is not None else
                   'snow' if info.constant in {'SNOWTOP_MOUNTAIN_OUTSIDE', 'SNOWTOP_MOUNTAIN_INSIDE'} else
                   'sandstorm' if info.constant in {'RUGGED_ROAD_NORTH', 'RUGGED_ROAD_SOUTH'} else 'none')
        return {'constant': info.constant, 'overcast_index': index, 'weather': weather}
    return {'constant': info.constant, 'overcast_index': state.overcast_index, 'weather': state.weather}


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Generate per-map weather state JSON.")
    p.add_argument("--polishedcrystal", type=Path, default=atlas_common.DEFAULT_POLISHED_PATH)
    p.add_argument("--weekday", type=render_map.parse_weekday, default=1)
    p.add_argument("--time-of-day", dest="time_of_day", type=render_map.parse_time_of_day, default=1)
    p.add_argument("--output", type=Path, default=atlas_common.DEFAULT_MAPS_DIR / "weather_state.json")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    polished_root = args.polishedcrystal.resolve()
    repo = atlas_common.repository(polished_root)

    events = repo.initial_event_flags

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
        "policy": "scripted-scheduled-only",
        "event_flags": sorted(events),
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
