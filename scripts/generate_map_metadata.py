#!/usr/bin/env python3
"""Extract warp metadata for polishedcrystal maps.

The script walks the polishedcrystal map scripts, parses warp definitions,
resolves their destinations, and emits a JSON payload that can be consumed by
frontend tooling. The payload is designed to be extensible so additional map
annotations (NPC positions, items, etc.) can be added in the future.
"""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import render_map

from generate_map_connections import AttributesParser, _default_repo_root

TARGET_OVERWORLD_TYPES = {"TOWN", "ROUTE", "ISOLATED"}
COLLISION_CELLS_PER_BLOCK = 2


@dataclass(frozen=True)
class WarpEvent:
    index: int
    x_cell: Optional[int]
    y_cell: Optional[int]
    target_constant: str
    target_warp_index: Optional[int]


def parse_args() -> argparse.Namespace:
    repo_root = _default_repo_root()
    parser = argparse.ArgumentParser(description="Generate map metadata payload containing warp information.")
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=repo_root / "external/polishedcrystal",
        help="Path to the polishedcrystal repository clone.",
    )
    parser.add_argument(
        "--attributes",
        type=Path,
        default=None,
        help="Path to data/maps/attributes.asm (defaults to the polishedcrystal checkout).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repo_root / "maps" / "warp_metadata.json",
        help="Destination for the generated metadata payload (defaults to maps/warp_metadata.json).",
    )
    return parser.parse_args()


def _iter_map_scripts(root: Path) -> Iterable[Path]:
    if not root.exists():
        return []
    return sorted(root.rglob("*.asm"))


def _strip_comment(line: str) -> str:
    return line.split(";", 1)[0].strip()


def _parse_numeric_token(token: str) -> Optional[int]:
    text = token.strip()
    if not text:
        return None
    negative = False
    if text.startswith("-"):
        negative = True
        text = text[1:]
    elif text.startswith("+"):
        text = text[1:]
    base = 10
    if text.startswith("$"):
        base = 16
        text = text[1:]
    elif text.startswith("%"):
        base = 2
        text = text[1:]
    text = text.strip()
    if not text:
        return None
    try:
        value = int(text, base)
    except ValueError:
        return None
    return -value if negative else value


def parse_map_warps(map_path: Path) -> List[WarpEvent]:
    warps: List[WarpEvent] = []
    inside_section = False
    index = 0
    try:
        raw_lines = map_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return warps
    for raw_line in raw_lines:
        line = _strip_comment(raw_line)
        if not line:
            continue
        if line.startswith("def_warp_events"):
            inside_section = True
            continue
        if not inside_section:
            continue
        if line.startswith("def_"):
            # End of the warp section.
            break
        if not line.startswith("warp_event"):
            continue
        payload = line[len("warp_event") :].strip()
        if not payload:
            continue
        parts = [part.strip() for part in payload.split(",")]
        if len(parts) < 4:
            continue
        x_cell = _parse_numeric_token(parts[0])
        y_cell = _parse_numeric_token(parts[1])
        target_constant = parts[2]
        target_warp = _parse_numeric_token(parts[3])
        index += 1
        warps.append(
            WarpEvent(
                index=index,
                x_cell=x_cell,
                y_cell=y_cell,
                target_constant=target_constant,
                target_warp_index=target_warp,
            )
        )
    return warps


def _block_pixel_size() -> int:
    return render_map.MetatileSet.METATILE_DIM * render_map.Tileset.TILE_SIZE


def build_metadata(
    polished_path: Path,
    attributes_path: Optional[Path],
) -> Tuple[Dict[str, dict], Dict[str, str]]:
    repo_index = render_map.RepositoryIndex(polished_path)
    attributes_source = attributes_path or polished_path / "data/maps/attributes.asm"
    parser = AttributesParser(attributes_source)
    attribute_graph = parser.parse()
    constant_to_label: Dict[str, str] = {}
    for label, data in attribute_graph.items():
        if data.constant:
            constant_to_label[data.constant] = label
    map_info = repo_index.maps
    map_scripts_dir = polished_path / "maps"
    script_warps: Dict[str, List[WarpEvent]] = {}
    for script_path in _iter_map_scripts(map_scripts_dir):
        label = script_path.stem
        script_warps[label] = parse_map_warps(script_path)

    all_labels = set(script_warps.keys()) | set(map_info.keys()) | set(attribute_graph.keys())
    block_pixels = _block_pixel_size()
    metadata: Dict[str, dict] = {}

    for label in sorted(all_labels):
        info = map_info.get(label)
        attr = attribute_graph.get(label)
        warps = script_warps.get(label, [])
        map_constant = None
        map_type = None
        width_blocks: Optional[int] = None
        height_blocks: Optional[int] = None
        if info is not None:
            map_constant = info.constant
            map_type = info.map_type
            width_blocks = info.width
            height_blocks = info.height
        elif attr is not None:
            map_constant = attr.constant
        is_overworld = map_type in TARGET_OVERWORLD_TYPES if map_type else False
        warp_entries: List[dict] = []
        for warp in warps:
            target_constant = warp.target_constant
            target_label = constant_to_label.get(target_constant)
            target_info = map_info.get(target_label) if target_label else None
            destination_warp: Optional[WarpEvent] = None
            if target_label and warp.target_warp_index:
                for candidate in script_warps.get(target_label, []):
                    if candidate.index == warp.target_warp_index:
                        destination_warp = candidate
                        break
            warp_entries.append(
                {
                    "index": warp.index,
                    "x_cells": warp.x_cell,
                    "y_cells": warp.y_cell,
                    "target": {
                        "map_constant": target_constant or None,
                        "map_label": target_label,
                        "warp_index": warp.target_warp_index,
                        "map_type": target_info.map_type if target_info else None,
                        "is_overworld": (target_info.map_type in TARGET_OVERWORLD_TYPES) if target_info else False,
                        "x_cells": destination_warp.x_cell if destination_warp else None,
                        "y_cells": destination_warp.y_cell if destination_warp else None,
                    },
                }
            )
        metadata[label] = {
            "label": label,
            "map_constant": map_constant,
            "map_type": map_type,
            "width_blocks": width_blocks,
            "height_blocks": height_blocks,
            "is_overworld": is_overworld,
            "warps": warp_entries,
        }
    return metadata, constant_to_label


def main() -> None:
    args = parse_args()
    polished_path = args.polishedcrystal.resolve()
    if not polished_path.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {polished_path}")
    attributes_path = args.attributes.resolve() if args.attributes else None
    if attributes_path and not attributes_path.exists():
        raise FileNotFoundError(f"attributes.asm not found at {attributes_path}")

    metadata, constant_lookup = build_metadata(polished_path, attributes_path)
    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "version": 1,
        "generated_at": datetime.utcnow().replace(tzinfo=None).isoformat() + "Z",
        "cells_per_block": COLLISION_CELLS_PER_BLOCK,
        "cell_pixel_size": _block_pixel_size() // COLLISION_CELLS_PER_BLOCK,
        "maps": metadata,
        "constant_lookup": constant_lookup,
    }
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"Wrote warp metadata for {len(metadata)} map(s) to {output_path}")


if __name__ == "__main__":  # pragma: no cover - script entry point
    main()
