#!/usr/bin/env python3
"""Extract weather particle graphics and palettes from polishedcrystal.

Outputs a compact JSON at maps/weather_metadata.json with:
- graphics: 2bpp tiles for rain, splash, snow, sand, cherry (base64), plus tile counts
- palettes: PAL_OW_RAIN overcast time-of-day variants, PAL_OW_SAND time variants,
  PAL_OW_PINK for cherry blossoms, and white for all snow colors

This mirrors the NPC object pipeline enough for the web app to render
weather using the same 2bpp -> RGBA mapping (index 0 = transparent).
"""

from __future__ import annotations

import argparse
import base64
import json
import re
from pathlib import Path
from typing import Dict

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


def build_payload(root: Path) -> Dict[str, object]:
    time_names, individual_names, _ = obj.parse_palette_definitions(root)
    tod = obj.parse_time_of_day_palettes(root, time_names)
    overcast = obj.parse_special_overcast_palettes(root, time_names)
    single = obj.parse_single_object_palettes(root, individual_names)
    palettes = {
        "PAL_OW_RAIN": {"overcast": overcast.get("PAL_OW_RAIN") or tod["PAL_OW_RAIN"]},
        "PAL_OW_SAND": {"time_variants": tod["PAL_OW_SAND"]},
        # LoadWeatherPal fills every snow color with $ffff; color zero is transparent.
        "PAL_OW_SNOW": {"static": [[255, 255, 255] for _ in range(4)]},
    }
    if "PAL_OW_PINK" in tod:
        palettes["PAL_OW_PINK"] = {"time_variants": tod["PAL_OW_PINK"]}
    elif "PAL_OW_PINK" in single:
        palettes["PAL_OW_PINK"] = {"static": single["PAL_OW_PINK"]}

    # Use declared raw graphics, falling back to checked-in PNG through the same
    # decoder as objects. Never treat a PNG file's compressed bytes as 2bpp.
    declarations = dict(re.findall(r'(\w+)::?\s*INCBIN\s+"([^"]+)"',
                                  (root / "gfx/misc.asm").read_text(encoding="utf-8")))
    graphics = {}
    for key, label, tiles in (("rain", "RainGFX", 2), ("snow", "SnowGFX", 1),
                              ("sand", "SandGFX", 1), ("cherry", "CherryBlossomGFX", 1)):
        if label not in declarations:
            if key == "cherry" and not (root / "gfx/overworld/cherry_blossom.png").exists():
                continue  # Stable source predates cherry weather.
            raise ValueError(f"Missing weather graphics declaration: {label}")
        data = obj.read_sprite_graphics(root, declarations[label])
        if len(data) < tiles * 16 or len(data) % 16:
            raise ValueError(f"Expected at least {tiles} weather tiles for {label}, got {len(data)} bytes")
        # WeatherGraphics loads the declared prefix; sand.png retains an extra
        # source tile that the engine does not copy into its weather slot.
        data = data[:tiles * 16]
        parts = (("rain", data[:16]), ("splash", data[16:])) if key == "rain" else ((key, data),)
        for name, pixels in parts:
            graphics[name] = {"tiles_2bpp_base64": tiles_base64(pixels), "tile_count": 1,
                              "width": 8, "height": 8}
    if "cherry" in graphics and "PAL_OW_PINK" not in palettes:
        raise ValueError("Cherry blossoms require PAL_OW_PINK")
    return {"graphics": graphics, "palettes": palettes, "schema_version": 2}


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
