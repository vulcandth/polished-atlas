#!/usr/bin/env python3
"""Build a connection graph for polishedcrystal overworld maps.

The script parses ``external/polishedcrystal/data/maps/attributes.asm`` and
walks the overworld connection graph starting from a user-supplied root map
label. The resulting graph is written to disk as JSON so other tooling (such as
map renderers) can stitch maps together.
"""

from __future__ import annotations

import argparse
import json
import re
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import render_map

_MAP_ATTRIBUTES_RE = re.compile(
    r"map_attributes\s+([A-Za-z0-9_]+),\s*([A-Z0-9_]+),\s*([^,]+),\s*(.+)"
)
_CONNECTION_RE = re.compile(
    r"connection\s+([a-z]+),\s*([A-Za-z0-9_]+),\s*([A-Z0-9_]+),\s*([-+]?[0-9]+)"
)


@dataclass
class MapConnection:
    direction: str
    label: str
    constant: str
    offset: int


@dataclass
class MapAttributes:
    label: str
    constant: str
    border_block: str
    connection_flags: List[str]
    connections: List[MapConnection] = field(default_factory=list)
    width: Optional[int] = None
    height: Optional[int] = None
    map_type: Optional[str] = None
    group: Optional[int] = None
    tileset: Optional[str] = None
    roof_constant: Optional[str] = None


class AttributesParser:
    """Parser for ``data/maps/attributes.asm``."""

    def __init__(self, attributes_path: Path):
        self.attributes_path = attributes_path

    def parse(self) -> Dict[str, MapAttributes]:
        maps: Dict[str, MapAttributes] = {}
        current: Optional[MapAttributes] = None
        for raw_line in self._iter_lines():
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            attr_match = _MAP_ATTRIBUTES_RE.match(line)
            if attr_match:
                label, constant, border_block, flag_expr = attr_match.groups()
                flags = [part.strip() for part in flag_expr.split("|")]
                current = MapAttributes(
                    label=label,
                    constant=constant,
                    border_block=border_block.strip(),
                    connection_flags=[flag for flag in flags if flag],
                )
                maps[label] = current
                continue
            if line.startswith("connection") and current is not None:
                conn_match = _CONNECTION_RE.match(line)
                if not conn_match:
                    raise ValueError(f"Unable to parse connection line: {line}")
                direction, target_label, target_constant, offset = conn_match.groups()
                current.connections.append(
                    MapConnection(
                        direction=direction,
                        label=target_label,
                        constant=target_constant,
                        offset=int(offset),
                    )
                )
        return maps

    def _iter_lines(self) -> Iterable[str]:
        with self.attributes_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                yield line.rstrip("\n")


def _collect_reachable(graph: Dict[str, MapAttributes], root: str) -> Dict[str, MapAttributes]:
    if root not in graph:
        available = ", ".join(sorted(graph))
        raise KeyError(f"Unknown root map '{root}'. Known maps: {available}")
    visited: Dict[str, MapAttributes] = {}
    queue: deque[str] = deque([root])
    while queue:
        label = queue.popleft()
        if label in visited:
            continue
        source = graph[label]
        visited[label] = MapAttributes(
            label=source.label,
            constant=source.constant,
            border_block=source.border_block,
            connection_flags=list(source.connection_flags),
            connections=list(source.connections),
            width=source.width,
            height=source.height,
            map_type=source.map_type,
            group=source.group,
            tileset=source.tileset,
            roof_constant=source.roof_constant,
        )
        for connection in source.connections:
            if connection.label in graph and connection.label not in visited:
                queue.append(connection.label)
    return dict(sorted(visited.items()))


def _augment_with_repo(
    attributes: Dict[str, MapAttributes],
    repo_index: Optional[render_map.RepositoryIndex],
) -> None:
    if repo_index is None:
        return
    for data in attributes.values():
        try:
            info = repo_index.map_info(data.label)
        except KeyError:
            continue
        data.width = info.width
        data.height = info.height
        data.map_type = info.map_type
        data.group = info.group
        data.tileset = info.tileset
        data.roof_constant = info.roof_constant


def _serialise_connections(attributes: Dict[str, MapAttributes]) -> Dict[str, dict]:
    serialised: Dict[str, dict] = {}
    for label, data in attributes.items():
        serialised[label] = {
            "label": data.label,
            "map_constant": data.constant,
            "border_block": data.border_block,
            "connection_flags": data.connection_flags,
            "width": data.width,
            "height": data.height,
            "width_px": _to_pixels(data.width),
            "height_px": _to_pixels(data.height),
            "map_type": data.map_type,
            "group": data.group,
            "tileset": data.tileset,
            "roof_constant": data.roof_constant,
            "asset": _default_asset_path(data.label),
            "connections": [
                {
                    "direction": conn.direction,
                    "label": conn.label,
                    "map_constant": conn.constant,
                    "offset": conn.offset,
                    "target_present": conn.label in attributes,
                }
                for conn in data.connections
            ],
        }
    return serialised


def _to_pixels(blocks: Optional[int]) -> Optional[int]:
    if blocks is None:
        return None
    return blocks * render_map.MetatileSet.METATILE_DIM * render_map.Tileset.TILE_SIZE


def _default_asset_path(label: str) -> str:
    return f"maps/day/animated/{label}.animation.json"


def _default_repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _default_output_path(root_label: str) -> Path:
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", root_label) or "root"
    return _default_repo_root() / "maps" / "day" / "animated" / f"{base}_connections.json"


def parse_args() -> argparse.Namespace:
    repo_root = _default_repo_root()
    parser = argparse.ArgumentParser(
        description="Generate a connection graph for maps starting from ROOT."
    )
    parser.add_argument(
        "root",
        help="Map label to use as the traversal root (e.g. NewBarkTown).",
    )
    parser.add_argument(
        "--attributes",
        type=Path,
        default=repo_root / "external/polishedcrystal/data/maps/attributes.asm",
        help="Path to attributes.asm (defaults to the polishedcrystal checkout).",
    )
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=repo_root / "external/polishedcrystal",
        help="Path to the polishedcrystal repository root (for additional metadata).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help="Destination JSON file (defaults to maps/day/animated/<root>_connections.json).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    attributes_path = args.attributes.resolve()
    if not attributes_path.exists():
        raise FileNotFoundError(f"attributes.asm not found at {attributes_path}")
    polished_path = args.polishedcrystal.resolve()
    repo_index: Optional[render_map.RepositoryIndex]
    if polished_path.exists():
        try:
            repo_index = render_map.RepositoryIndex(polished_path)
        except Exception as exc:  # pragma: no cover - defensive guard
            raise RuntimeError(f"Failed to initialise RepositoryIndex at {polished_path}: {exc}") from exc
    else:
        repo_index = None

    parser = AttributesParser(attributes_path)
    graph = parser.parse()
    reachable = _collect_reachable(graph, args.root)
    _augment_with_repo(reachable, repo_index)
    payload = {
        "root": args.root,
        "map_count": len(reachable),
        "maps": _serialise_connections(reachable),
        "block_pixel_size": _to_pixels(1),
    }

    output_path = (args.output or _default_output_path(args.root)).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")

    print(
        f"Wrote {len(reachable)} maps starting at {args.root} to {output_path}",
        flush=True,
    )


if __name__ == "__main__":
    main()
