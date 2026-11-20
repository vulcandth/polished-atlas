#!/usr/bin/env python3
"""Export per-map background palettes (slots 0-7) for polishedcrystal.

The output is used by the web atlas to render objects that use PAL_OW_COPY_BG_*
by deriving their colors from the map's current background palettes.

This script mirrors palette selection logic used for map rendering in
render_map._build_renderer:
- Select special background palettes where applicable
- Otherwise select environment palettes for the map's type and time of day
- Apply roof color overrides for eligible maps
- Return 8 background palettes (slots 0-7) of 4 RGB tuples each

Unlike the map renderer (which only needs 7 slots for tiles), this export
includes all 8 slots, where slot 7 corresponds to the text palette.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import atlas_common
import render_map
from map_palette import palette_time

RGB = Tuple[int, int, int]
TIME_OF_DAY_SLOTS = ("morn", "day", "nite", "eve")


@dataclass
class Options:
    polishedcrystal: Path
    output: Path
    weekday: int


def parse_args() -> Options:
    parser = argparse.ArgumentParser(description="Generate per-map background palette metadata for polished-atlas.")
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=atlas_common.DEFAULT_POLISHED_PATH,
        help="Path to the polishedcrystal repository clone.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=atlas_common.DEFAULT_MAPS_DIR / "bg_palette_metadata.json",
        help="Destination for the generated metadata payload.",
    )
    parser.add_argument(
        "--weekday",
        type=int,
        default=1,
        help="Weekday index (0=Sunday..6=Saturday) used for overcast/special palettes.",
    )
    ns = parser.parse_args()
    return Options(
        polishedcrystal=ns.polishedcrystal.resolve(),
        output=ns.output.resolve(),
        weekday=max(0, min(6, int(ns.weekday) if isinstance(ns.weekday, int) else 1)),
    )


def _ensure_palette_rows(palette: List[List[RGB]], target: int = 8) -> List[List[RGB]]:
    out: List[List[RGB]] = [list(row) for row in palette]
    if not out:
        out = [[(0, 0, 0)] * 4 for _ in range(target)]
    while len(out) < target:
        out.append(list(out[-1]))
    for idx, row in enumerate(out):
        if len(row) < 4:
            filler = row[-1] if row else (0, 0, 0)
            out[idx] = list(row) + [filler] * (4 - len(row))
    return out[:target]


def _compute_env_palettes_full8(
    repo: render_map.RepositoryIndex,
    map_info: render_map.MapInfo,
    time_of_day: int,
) -> List[List[RGB]]:
    # Reconstruct environment palette selection but keep all 8 indices
    env_key = (map_info.map_type or "INDOOR").upper()
    indices_by_time = getattr(repo, "_environment_palette_indices", {}).get(env_key)
    if indices_by_time is None:
        indices_by_time = getattr(repo, "_environment_palette_indices", {}).get("INDOOR")
    selected: List[List[RGB]] = []
    bg_source: Sequence[Sequence[RGB]] = getattr(repo, "_bg_tile_palettes", [])
    if indices_by_time:
        time_index = time_of_day & 0x03
        if time_index >= len(indices_by_time):
            time_index = 0
        raw_indices = list(indices_by_time[time_index][:8])
        for palette_index in raw_indices:
            if 0 <= palette_index < len(bg_source):
                selected.append(list(bg_source[palette_index]))
    if not selected and bg_source:
        # Fallback: take first 8 palettes from bg tileset
        selected = [list(p) for p in bg_source[:8]]
    return _ensure_palette_rows(selected, 8)


def _apply_roof_override_if_applicable(
    repo: render_map.RepositoryIndex,
    map_info: render_map.MapInfo,
    base: List[List[RGB]],
    *,
    time_of_day: int,
    weekday: int,
    events: Optional[Sequence[str]],
) -> List[List[RGB]]:
    if not repo.uses_roof_palette(map_info):
        return _ensure_palette_rows(base, 8)
    overcast_index = repo.get_overcast_index(map_info, weekday=weekday, events=set(events or []))
    if overcast_index is not None:
        roof_override = repo.overcast_roof_palette(overcast_index, time_of_day=time_of_day, group=map_info.group)
    else:
        roof_override = repo.roof_palette(map_info.group, time_of_day=time_of_day)
    out = _ensure_palette_rows(base, 8)
    if roof_override is None:
        return out
    # Slot 6 is the roof palette; replace color1/color2
    if len(out) > 6:
        row = list(out[6])
        while len(row) < 4:
            row.append(row[-1] if row else (0, 0, 0))
        row[1] = roof_override[0]
        row[2] = roof_override[1]
        out[6] = row
    return out


def compute_map_palettes(
    repo: render_map.RepositoryIndex,
    map_info: render_map.MapInfo,
    *,
    weekday: int,
    events: Optional[Sequence[str]] = None,
    entrance_map: Optional[str] = None,
) -> Dict[str, List[List[RGB]]]:
    result: Dict[str, List[List[RGB]]] = {}
    for time_index, time_slug in enumerate(TIME_OF_DAY_SLOTS):
        time_index = palette_time(map_info.palette_flags, time_index)
        # Prefer special palettes if present
        special = repo.special_background_palette(
            map_info,
            time_index,
            weekday=weekday,
            events=set(events or []),
            entrance_map=entrance_map,
        )
        if special is not None:
            # Special palettes usually provide 7 rows; derive slot 7 (text) from environment
            env8 = _compute_env_palettes_full8(repo, map_info, time_index)
            base = _ensure_palette_rows([list(row) for row in special[:7]], 7) + [env8[7]]
        else:
            base = _compute_env_palettes_full8(repo, map_info, time_index)
        with_roof = _apply_roof_override_if_applicable(
            repo,
            map_info,
            base,
            time_of_day=time_index,
            weekday=weekday,
            events=events,
        )
        result[time_slug] = _ensure_palette_rows(with_roof, 8)
    return result


def build_payload(opts: Options) -> Dict[str, object]:
    polished_root = opts.polishedcrystal
    if not polished_root.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {polished_root}")

    repo = atlas_common.repository(polished_root)

    initial_flags = repo.initial_event_flags
    maps_payload: Dict[str, object] = {}
    for label, info in sorted(repo.maps.items()):
        palettes_by_time = compute_map_palettes(repo, info, weekday=opts.weekday, events=initial_flags)
        maps_payload[label] = {
            "label": label,
            "map_constant": info.constant,
            "map_type": info.map_type,
            "palettes": palettes_by_time,
            "palette_times": {name: TIME_OF_DAY_SLOTS[palette_time(info.palette_flags, i)]
                              for i, name in enumerate(TIME_OF_DAY_SLOTS)},
            "darkness": "IN_DARKNESS" in info.palette_flags,
            "palette_swaps": repo.palette_swaps.metadata(label),
            "overcast": repo.get_overcast_index(info, weekday=opts.weekday, events=initial_flags) is not None,
        }
        if "IN_DARKNESS" in info.palette_flags:
            lit = info.with_flash()
            maps_payload[label]["flash"] = {
                "asset_label": f"{label}--Flash",
                "palettes": compute_map_palettes(repo, lit, weekday=opts.weekday, events=initial_flags),
                "palette_times": {name: TIME_OF_DAY_SLOTS[palette_time(lit.palette_flags, i)]
                                  for i, name in enumerate(TIME_OF_DAY_SLOTS)},
            }
        origins = repo.entrance_assets(info)
        if origins:
            maps_payload[label]["entrance_variants"] = {
                origin: {
                    "asset_label": asset_label,
                    "palettes": compute_map_palettes(repo, info, weekday=opts.weekday,
                                                     events=initial_flags, entrance_map=origin),
                }
                for origin, asset_label in origins.items()
            }

    return {
        "version": 2,
        "palette_swap_palettes": repo.palette_swaps.palettes,
        "generated_at": datetime.utcnow().replace(tzinfo=None).isoformat() + "Z",
        "weekday": int(opts.weekday),
        "maps": maps_payload,
    }


def main() -> None:
    opts = parse_args()
    payload = build_payload(opts)
    opts.output.parent.mkdir(parents=True, exist_ok=True)
    with opts.output.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"Wrote background palette metadata for {len(payload.get('maps', {}))} map(s) to {opts.output}")


if __name__ == "__main__":  # pragma: no cover - script entry point
    main()
