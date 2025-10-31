#!/usr/bin/env python3
"""Extract warp metadata for polishedcrystal maps.

The script walks the polishedcrystal map scripts, parses warp definitions,
resolves their destinations, and emits a JSON payload that can be consumed by
frontend tooling. The payload is designed to be extensible so additional map
annotations (NPC positions, items, etc.) can be added in the future.
"""

from __future__ import annotations

import argparse
import base64
import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple, Set

import render_map

import atlas_common

from generate_map_connections import AttributesParser

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
    parser = argparse.ArgumentParser(description="Generate map metadata payload containing warp information.")
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=atlas_common.DEFAULT_POLISHED_PATH,
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
        default=atlas_common.DEFAULT_MAPS_DIR / "warp_metadata.json",
        help="Destination for the generated metadata payload (defaults to maps/warp_metadata.json).",
    )
    parser.add_argument(
        "--overworld-exclude",
        action="append",
        default=[],
        help=(
            "Map label to treat as indoor (exclude from overworld classification). "
            "May be specified multiple times."
        ),
    )
    parser.add_argument(
        "--overworld-exclude-file",
        type=Path,
        default=None,
        help=(
            "Optional JSON or text file listing map labels to exclude from overworld classification. "
            "JSON may be an array of strings or an object with 'exclude_labels'/'labels'."
        ),
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


def _parse_collision_permissions(polished_path: Path) -> List[int]:
    path = polished_path / "data/collision/collision_permissions.asm"
    permissions: List[int] = []
    if not path.exists():
        return permissions
    token_map = {
        "LAND_TILE": 0,
        "WATER_TILE": 1,
        "WALL_TILE": 2,
    }
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        code = raw_line.split(";", 1)[0].strip()
        if not code:
            continue
        if code.startswith(("CollisionPermissionTable::", "table_width", "assert_table_length")):
            continue
        if not code.startswith("db"):
            continue
        payload = code[len("db") :].strip()
        if not payload:
            continue
        parts = [part.strip() for part in payload.split(",") if part.strip()]
        for part in parts:
            key = part.upper()
            if key in token_map:
                permissions.append(token_map[key])
                continue
            value = _parse_numeric_token(part)
            if value is None:
                continue
            permissions.append(value & 0xF)
    if len(permissions) >= 0x100:
        return permissions[:0x100]
    return permissions


def _parse_collision_constants(polished_path: Path) -> Dict[str, int]:
    path = polished_path / "constants/collision_constants.asm"
    constants: Dict[str, int] = {}
    if not path.exists():
        return constants
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        code = raw_line.split(";", 1)[0].strip()
        if not code or not code.startswith("DEF "):
            continue
        parts = code.split(None, 3)
        if len(parts) < 4:
            continue
        _, name, equ, value_expr = parts
        if equ != "EQU":
            continue
        value = _parse_numeric_token(value_expr)
        if value is None:
            continue
        constants[name] = value
    return constants


def _load_tileset_collision_table(
    polished_path: Path,
    relative_path: str,
    constants: Dict[str, int],
) -> List[Tuple[int, int, int, int]]:
    source = polished_path / relative_path
    if source.suffix == ".asm":
        return _parse_collision_asm(source, constants)
    try:
        data = render_map._read_asset_bytes(source)
    except FileNotFoundError:
        asm_path = polished_path / Path(relative_path)
        if not asm_path.suffix:
            asm_path = asm_path.with_suffix(".asm")
        return _parse_collision_asm(asm_path, constants)
    if len(data) % 4 != 0:
        raise ValueError(f"Collision data has unexpected length ({len(data)}) for {relative_path}")
    table: List[Tuple[int, int, int, int]] = []
    for index in range(0, len(data), 4):
        table.append(tuple(data[index + offset] for offset in range(4)))
    return table


def _parse_collision_asm(path: Path, constants: Dict[str, int]) -> List[Tuple[int, int, int, int]]:
    if not path.exists():
        return []
    entries: List[Tuple[int, int, int, int]] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        code = raw_line.split(";", 1)[0].strip()
        if not code or not code.startswith("tilecoll"):
            continue
        payload = code[len("tilecoll") :].strip()
        if not payload:
            continue
        parts = [part.strip() for part in payload.split(",") if part.strip()]
        if len(parts) != 4:
            continue
        values: List[int] = []
        for part in parts:
            value = _parse_numeric_token(part)
            if value is None:
                lookup_keys = [part, f"COLL_{part}"]
                for key in lookup_keys:
                    if key in constants:
                        value = constants[key]
                        break
            if value is None:
                values = []
                break
            values.append(value & 0xFF)
        if values:
            entries.append(tuple(values))
    return entries


def _load_block_indices(
    polished_path: Path,
    repo_index: render_map.RepositoryIndex,
    info: render_map.MapInfo,
) -> Optional[List[int]]:
    block_asset = repo_index.block_asset(info.block_label)
    if block_asset:
        candidate = polished_path / Path(block_asset)
    else:
        candidate = polished_path / "maps" / f"{info.label}.ablk"
    try:
        block_bytes = render_map._read_block_bytes(candidate)
    except FileNotFoundError:
        return None
    if info.width is None or info.height is None:
        return None
    try:
        return render_map._map_block_indices(block_bytes, info.width, info.height)
    except ValueError:
        return None


def _build_collision_cells(
    block_indices: Sequence[int],
    width_blocks: int,
    height_blocks: int,
    cells_per_block: int,
    collision_table: Sequence[Sequence[int]],
) -> Optional[bytes]:
    if width_blocks <= 0 or height_blocks <= 0 or cells_per_block <= 0:
        return None
    expected_blocks = width_blocks * height_blocks
    if len(block_indices) != expected_blocks:
        return None
    if cells_per_block != 2:
        # Currently only support 2x2 collision cells per block.
        return None
    width_cells = width_blocks * cells_per_block
    height_cells = height_blocks * cells_per_block
    grid = bytearray(width_cells * height_cells)
    for block_row in range(height_blocks):
        for block_col in range(width_blocks):
            block_index = block_indices[block_row * width_blocks + block_col]
            if 0 <= block_index < len(collision_table):
                collisions = collision_table[block_index]
            else:
                collisions = (0, 0, 0, 0)
            base_row = block_row * cells_per_block
            base_col = block_col * cells_per_block
            top_offset = base_row * width_cells + base_col
            bottom_offset = (base_row + 1) * width_cells + base_col
            grid[top_offset] = collisions[0]
            grid[top_offset + 1] = collisions[1]
            grid[bottom_offset] = collisions[2]
            grid[bottom_offset + 1] = collisions[3]
    return bytes(grid)


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
    return atlas_common.block_pixel_size()


def _load_excluded_labels(config_path: Optional[Path], extras: Sequence[str]) -> Set[str]:
    labels: Set[str] = set(l for l in (extras or []) if isinstance(l, str) and l.strip())
    if config_path is None:
        return labels
    path = config_path.resolve()
    if not path.exists():
        return labels
    text = path.read_text(encoding="utf-8")
    data: Optional[object] = None
    try:
        data = json.loads(text)
    except Exception:
        data = None
    if isinstance(data, list):
        for item in data:
            if isinstance(item, str) and item.strip():
                labels.add(item.strip())
        return labels
    if isinstance(data, dict):
        for key in ("exclude_labels", "labels"):
            raw = data.get(key)
            if isinstance(raw, list):
                for item in raw:
                    if isinstance(item, str) and item.strip():
                        labels.add(item.strip())
        return labels
    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if line:
            labels.add(line)
    return labels


def build_metadata(
    polished_path: Path,
    attributes_path: Optional[Path],
    excluded_overworld: Set[str],
) -> Tuple[Dict[str, dict], Dict[str, str], Dict[str, object]]:
    repo_index = atlas_common.repository(polished_path)
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
    metadata: Dict[str, dict] = {}
    collision_tables: Dict[str, List[Tuple[int, int, int, int]]] = {}
    collision_permissions = _parse_collision_permissions(polished_path)
    collision_constants = _parse_collision_constants(polished_path)

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
        is_overworld = (map_type in TARGET_OVERWORLD_TYPES) if map_type else False
        if label in excluded_overworld:
            is_overworld = False
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
                        "is_overworld": (
                            (target_info.map_type in TARGET_OVERWORLD_TYPES) if target_info else False
                        )
                        and (target_label not in excluded_overworld if target_label else False),
                        "x_cells": destination_warp.x_cell if destination_warp else None,
                        "y_cells": destination_warp.y_cell if destination_warp else None,
                    },
                }
            )
        collision_payload: Optional[Dict[str, object]] = None
        if info is not None and width_blocks is not None and height_blocks is not None:
            try:
                tileset_resources = repo_index.tileset_resources(info.tileset)
            except KeyError:
                tileset_resources = None
            block_indices = _load_block_indices(polished_path, repo_index, info)
            if tileset_resources and block_indices is not None:
                table = collision_tables.get(info.tileset)
                if table is None:
                    try:
                        table = _load_tileset_collision_table(
                            polished_path,
                            tileset_resources.collision_path,
                            collision_constants,
                        )
                    except (FileNotFoundError, ValueError):
                        table = []
                    collision_tables[info.tileset] = table
                if table:
                    cells = _build_collision_cells(
                        block_indices,
                        width_blocks,
                        height_blocks,
                        COLLISION_CELLS_PER_BLOCK,
                        table,
                    )
                    if cells:
                        width_cells = width_blocks * COLLISION_CELLS_PER_BLOCK
                        height_cells = height_blocks * COLLISION_CELLS_PER_BLOCK
                        collision_payload = {
                            "encoding": "base64",
                            "width_cells": width_cells,
                            "height_cells": height_cells,
                            "tileset_constant": info.tileset,
                            "tileset_label": repo_index.tileset_label(info.tileset),
                            "tileset_index": info.tileset_index,
                            "cells": base64.b64encode(cells).decode("ascii"),
                        }
        metadata[label] = {
            "label": label,
            "map_constant": map_constant,
            "map_type": map_type,
            "width_blocks": width_blocks,
            "height_blocks": height_blocks,
            "is_overworld": is_overworld,
            "warps": warp_entries,
        }
        if collision_payload is not None:
            metadata[label]["collision"] = collision_payload
    aux_data = {
        "collision_permissions": collision_permissions,
        "collision_constants": collision_constants,
    }
    return metadata, constant_to_label, aux_data


def main() -> None:
    args = parse_args()
    polished_path = args.polishedcrystal.resolve()
    if not polished_path.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {polished_path}")
    attributes_path = args.attributes.resolve() if args.attributes else None
    if attributes_path and not attributes_path.exists():
        raise FileNotFoundError(f"attributes.asm not found at {attributes_path}")

    # Try default exclusion file alongside this script when not explicitly provided.
    default_exclude_path = (Path(__file__).parent / "overworld_exclude.json").resolve()
    exclude_source = args.overworld_exclude_file or (default_exclude_path if default_exclude_path.exists() else None)
    excluded = _load_excluded_labels(exclude_source, args.overworld_exclude)
    metadata, constant_lookup, aux_data = build_metadata(polished_path, attributes_path, excluded)
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
    if aux_data.get("collision_permissions") is not None:
        payload["collision_permissions"] = aux_data.get("collision_permissions")
    if aux_data.get("collision_constants") is not None:
        payload["collision_constants"] = aux_data.get("collision_constants")
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"Wrote warp metadata for {len(metadata)} map(s) to {output_path}")


if __name__ == "__main__":  # pragma: no cover - script entry point
    main()
