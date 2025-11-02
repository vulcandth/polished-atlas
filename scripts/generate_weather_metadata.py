#!/usr/bin/env python3
"""Extract weather particle graphics and palettes from polishedcrystal.

Outputs a compact JSON at maps/weather_metadata.json with:
- graphics: 2bpp tiles for rain, splash, snow, sand (base64), plus tile counts
- palettes: PAL_OW_RAIN overcast time-of-day variants, PAL_OW_SAND time variants,
  and a static white palette for snow (3 colors + transparent index 0)

This mirrors the NPC object pipeline enough for the web app to render
weather using the same 2bpp -> RGBA mapping (index 0 = transparent).
"""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
from typing import Dict, List

import atlas_common

# We intentionally import helper functions from the object metadata generator
# to stay consistent with tiles/palette parsing.
import generate_object_metadata as obj


def ensure_repo(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {resolved}")
    return resolved


def tiles_base64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def slice_tile_bytes(data: bytes, start_tiles: int, tile_count: int) -> bytes:
    start = start_tiles * 16
    end = start + tile_count * 16
    return data[start:end]


def build_payload(root: Path) -> Dict[str, object]:
    # Palettes
    constants = obj.gather_constants(root)
    time_names, individual_names, copy_names = obj.parse_palette_definitions(root)

    tod_palettes = obj.parse_time_of_day_palettes(root, time_names)
    overcast_palettes = obj.parse_special_overcast_palettes(root, time_names)

    pal_payload: Dict[str, object] = {}

    # PAL_OW_RAIN: prefer overcast variants (time-of-day)
    if "PAL_OW_RAIN" in time_names:
        rain_overcast = overcast_palettes.get("PAL_OW_RAIN", {})
        # Fallback to time-of-day if special overcast missing
        if not rain_overcast:
            rain_overcast = tod_palettes.get("PAL_OW_RAIN", {})
        pal_payload["PAL_OW_RAIN"] = {"overcast": rain_overcast}

    # PAL_OW_SAND: use time-variants
    if "PAL_OW_SAND" in time_names:
        pal_payload["PAL_OW_SAND"] = {"time_variants": tod_palettes.get("PAL_OW_SAND", {})}

    # Snow: static white palette (index 0 transparent, 1..3 visible)
    pal_payload["PAL_OW_SNOW"] = {
        "static": [
            [255, 255, 255],
            [255, 255, 255],
            [255, 255, 255],
            [0, 0, 0],
        ]
    }

    # Graphics: read rain_splash, snow, sand; convert to 2bpp (generate_object_metadata handles PNG fallback)
    rain_path = "gfx/overworld/rain_splash.2bpp.lz"
    snow_path = "gfx/overworld/snow.2bpp.lz"
    sand_path = "gfx/overworld/sand.2bpp.lz"

    # If .2bpp.lz not present, read_sprite_graphics() falls back to .png and encodes tiles
    rain_bytes = obj.read_sprite_graphics(root, rain_path)
    snow_bytes = obj.read_sprite_graphics(root, snow_path)
    sand_bytes = obj.read_sprite_graphics(root, sand_path)

    # If rain_splash is empty at this path, try the PNG directly
    if not rain_bytes:
        rain_bytes = obj.read_sprite_graphics(root, "gfx/overworld/rain_splash.png")
    if not snow_bytes:
        snow_bytes = obj.read_sprite_graphics(root, "gfx/overworld/snow.png")
    if not sand_bytes:
        sand_bytes = obj.read_sprite_graphics(root, "gfx/overworld/sand.png")

    # Derive tiles
    rain_tile_count = len(rain_bytes) // 16 if rain_bytes else 0
    snow_tile_count = len(snow_bytes) // 16 if snow_bytes else 0
    sand_tile_count = len(sand_bytes) // 16 if sand_bytes else 0

    # Split rain_splash into two equal halves whenever possible
    rain_tiles_b64 = ""
    splash_tiles_b64 = ""
    if rain_tile_count >= 2:
        half = rain_tile_count // 2
        rain_tiles_b64 = tiles_base64(slice_tile_bytes(rain_bytes, 0, half))
        splash_tiles_b64 = tiles_base64(slice_tile_bytes(rain_bytes, half, rain_tile_count - half))
    elif rain_tile_count == 1:
        rain_tiles_b64 = tiles_base64(rain_bytes)
        splash_tiles_b64 = tiles_base64(rain_bytes)  # fallback duplicate

    gfx_payload: Dict[str, object] = {
        "rain": {
            "tiles_2bpp_base64": rain_tiles_b64,
            "tile_count": len(base64.b64decode(rain_tiles_b64)) // 16 if rain_tiles_b64 else 0,
            "width": 8,
            "height": 8,
        },
        "splash": {
            "tiles_2bpp_base64": splash_tiles_b64,
            "tile_count": len(base64.b64decode(splash_tiles_b64)) // 16 if splash_tiles_b64 else 0,
            "width": 8,
            "height": 8,
        },
        "snow": {
            "tiles_2bpp_base64": tiles_base64(snow_bytes) if snow_bytes else "",
            "tile_count": snow_tile_count,
            "width": 8,
            "height": 8,
        },
        "sand": {
            "tiles_2bpp_base64": tiles_base64(sand_bytes) if sand_bytes else "",
            "tile_count": sand_tile_count,
            "width": 8,
            "height": 8,
        },
    }

    return {
        "graphics": gfx_payload,
        "palettes": pal_payload,
        "schema_version": 1,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate weather graphics + palettes metadata for polished-atlas.")
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=atlas_common.DEFAULT_POLISHED_PATH,
        help="Path to the polishedcrystal repository clone.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=atlas_common.DEFAULT_MAPS_DIR / "weather_metadata.json",
        help="Destination for the generated metadata payload.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    root = ensure_repo(args.polishedcrystal)
    payload = build_payload(root)
    out_path = args.output.resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"Wrote weather metadata to {out_path}")


if __name__ == "__main__":
    main()
