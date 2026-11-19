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
from copy import deepcopy
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Set, Tuple

import render_map

import atlas_common

_MAP_ATTRIBUTES_RE = re.compile(
    r"map_attributes\s+([A-Za-z0-9_]+),\s*([A-Z0-9_]+),\s*([^,]+?)(?:,\s*([^,]+))?"
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
    layout_only: bool = False
    split_range: Optional[Tuple[Optional[int], Optional[int]]] = None
    overlap_blocks: int = 0


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


@dataclass
class Placement:
    label: str
    x: int
    y: int
    width: int
    height: int


def _project_neighbour(source: Placement, width: int, height: int, connection: MapConnection) -> Tuple[int, int]:
    offset = int(connection.offset)
    direction = connection.direction.lower()
    if direction == "north":
        return source.x + offset, source.y - height + connection.overlap_blocks
    if direction == "south":
        return source.x + offset, source.y + source.height - connection.overlap_blocks
    if direction == "west":
        return source.x - width, source.y + offset
    if direction == "east":
        return source.x + source.width, source.y + offset
    raise ValueError(f"Unsupported connection direction '{connection.direction}'")


class AttributesParser:
    """Parser for ``data/maps/attributes.asm``."""

    def __init__(self, attributes_path: Path):
        self.attributes_path = attributes_path

    def parse(self) -> Dict[str, MapAttributes]:
        maps: Dict[str, MapAttributes] = {}
        current: Optional[MapAttributes] = None
        definitions: Dict[str, str] = {}
        aliases: List[MapConnection] = []
        for raw_line in self._iter_lines():
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            definition = re.fullmatch(r"DEF\s+(\w+)\s+EQU\s+(.+)", line)
            if definition:
                definitions[definition[1]] = definition[2]
                continue
            if line.startswith("PURGE "):
                for symbol in line[6:].split(","):
                    definitions.pop(symbol.strip(), None)
                continue
            attr_match = _MAP_ATTRIBUTES_RE.fullmatch(line)
            if attr_match:
                label, constant, border_block, flag_expr = attr_match.groups()
                if label in maps:
                    raise ValueError(f"Duplicate map attributes: {label}")
                flags = [part.strip() for part in flag_expr.split("|")] if flag_expr else []
                current = MapAttributes(
                    label=label,
                    constant=constant,
                    border_block=border_block.strip(),
                    connection_flags=[flag for flag in flags if flag],
                )
                maps[label] = current
                continue
            if line.startswith("map_attributes "):
                raise ValueError(f"Unable to parse map attributes: {line}")
            if line.startswith("connection "):
                conn_match = _CONNECTION_RE.fullmatch(line)
                if not conn_match or current is None:
                    raise ValueError(f"Unable to parse connection line: {line}")
                direction, target_label, target_constant, offset = conn_match.groups()
                if direction not in {"north", "south", "west", "east"}:
                    raise ValueError(f"Unknown connection direction: {direction}")
                connection = MapConnection(direction, target_label, target_constant, int(offset))
                group = definitions.get(f"GROUP_{target_constant}")
                if group is not None:
                    # The north gatehouse uses Route 36's map ID and stride, but
                    # starts its border copy one row before the full map ends.
                    target = group.removeprefix("GROUP_")
                    height = definitions.get(f"{target_constant}_HEIGHT", "")
                    shortened = re.fullmatch(rf"{target}_HEIGHT\s*-\s*(\d+)", height)
                    if (direction != "north" or not shortened
                            or definitions.get(f"MAP_{target_constant}") != f"MAP_{target}"
                            or definitions.get(f"{target_constant}_WIDTH") != f"{target}_WIDTH"):
                        raise ValueError(f"Unsupported connection alias: {line}")
                    connection.constant = target
                    connection.overlap_blocks = int(shortened[1])
                    aliases.append(connection)
                current.connections.append(connection)
        if not maps:
            raise ValueError(f"No map attributes found in {self.attributes_path}")
        for alias in aliases:
            labels = [m.label for m in maps.values() if m.constant == alias.constant]
            if len(labels) != 1:
                raise ValueError(f"Ambiguous or missing connection alias target: {alias.constant}")
            alias.label = labels[0]
        # Modern upstream derives the flags from each connection macro instead
        # of repeating a fourth argument on map_attributes.
        for data in maps.values():
            if not data.connection_flags:
                data.connection_flags = [connection.direction.upper() for connection in data.connections] or ["0"]
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


def _layout_graph(graph: Dict[str, MapAttributes], root: Path) -> Tuple[Dict[str, MapAttributes], Set[str]]:
    """Expand runtime dual destinations and derive reverse placement constraints.

    Reverse edges locate maps in the static atlas; they are not player exits.
    Keep the parsed game graph unchanged for callers that need actual exits.
    """
    result = deepcopy(graph)
    by_constant = {data.constant: data for data in result.values()}
    path = root / "data/maps/dual_connections.asm"
    replaced: Set[str] = set()
    seen: Set[Tuple[str, str]] = set()
    if path.exists():
        pending = ""
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.split(";", 1)[0].strip()
            if not line:
                continue
            pending += line.removesuffix("\\").strip() + " "
            if line.endswith("\\"):
                continue
            line, pending = pending.strip(), ""
            if not line.startswith("dual_connection "):
                continue
            args = [arg.strip() for arg in line[len("dual_connection "):].split(",")]
            if len(args) != 9:
                raise ValueError(f"Invalid dual connection: {line}")
            direction, constant, split_text = args[:3]
            if direction not in {"north", "south", "west", "east"} or constant not in by_constant:
                raise ValueError(f"Unknown dual connection source/direction: {line}")
            source = by_constant[constant]
            key = (constant, direction)
            if key in seen:
                raise ValueError(f"Duplicate dual connection: {key}")
            seen.add(key)
            split = int(split_text)
            dimension = source.width if direction in {"north", "south"} else source.height
            if dimension is None or not 0 < split < dimension * 2:
                raise ValueError(f"Dual split outside source edge: {line}")
            original = [c for c in source.connections if c.direction == direction]
            if len(original) != 1:
                raise ValueError(f"Dual connection requires one border connection: {key}")
            branches = []
            for index, bounds in [(3, (None, split)), (6, (split, None))]:
                label, target_constant, offset = args[index:index + 3]
                if label not in result or result[label].constant != target_constant:
                    raise ValueError(f"Unknown dual connection destination: {line}")
                branches.append(MapConnection(direction, label, target_constant, int(offset), split_range=bounds))
            replaced.add(original[0].label)
            position = source.connections.index(original[0])
            source.connections[position:position + 1] = branches
        if pending:
            raise ValueError("Unterminated dual connection continuation")

    # A replaced border strip with no remaining incoming edge is only a visual
    # proxy. CherrygroveTrainTrackDual is retained because a real branch uses it.
    incoming = {c.label for data in result.values() for c in data.connections}
    proxies = replaced - incoming
    for label in proxies:
        if label not in result:
            raise ValueError(f"Unknown dual border proxy: {label}")
        del result[label]

    opposite = {"north": "south", "south": "north", "west": "east", "east": "west"}
    for source in list(result.values()):
        for connection in list(source.connections):
            if connection.layout_only or connection.label not in result:
                continue
            target = result[connection.label]
            if not any(c.label == source.label for c in target.connections):
                target.connections.append(MapConnection(opposite[connection.direction], source.label,
                    source.constant, -connection.offset, layout_only=True, overlap_blocks=connection.overlap_blocks))
    return result, proxies


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
        data.constant = info.constant
        data.height = info.height
        data.map_type = info.map_type
        data.group = info.group
        data.tileset = info.tileset
        data.roof_constant = info.roof_constant


def _serialise_connections(
    attributes: Dict[str, MapAttributes],
    *,
    asset_prefix: Optional[str] = None,
    common_asset_prefix: Optional[str] = None,
    invariant_labels: Optional[Set[str]] = None,
    z_index_lookup: Optional[Dict[str, int]] = None,
) -> Dict[str, dict]:
    prefix = _normalise_asset_prefix(asset_prefix)
    common_prefix = _normalise_asset_prefix(common_asset_prefix or "maps/common/animated")
    invariant_set = set(invariant_labels or ())
    serialised: Dict[str, dict] = {}
    z_lookup = dict(z_index_lookup or {})
    for label, data in attributes.items():
        active_prefix = common_prefix if data.label in invariant_set else prefix
        entry = {
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
            "asset": _default_asset_path(data.label, active_prefix),
            "connections": [
                {
                    "direction": conn.direction,
                    "label": conn.label,
                    "map_constant": conn.constant,
                    "offset": conn.offset,
                    "target_present": conn.label in attributes,
                    **({"layout_only": True} if conn.layout_only else {}),
                    **({"overlap_blocks": conn.overlap_blocks} if conn.overlap_blocks else {}),
                    **({"split_range": conn.split_range} if conn.split_range is not None else {}),
                }
                for conn in data.connections
            ],
        }
        if data.label in z_lookup:
            try:
                entry["z_index"] = int(z_lookup[data.label])
            except Exception:
                # Ignore invalid z assignments gracefully
                pass
        serialised[label] = entry
    return serialised


def _to_pixels(blocks: Optional[int]) -> Optional[int]:
    if blocks is None:
        return None
    return blocks * atlas_common.block_pixel_size()


def _normalise_asset_prefix(prefix: Optional[str]) -> str:
    if prefix is None or not str(prefix).strip():
        return "maps/day/animated"
    sanitized = str(prefix).strip().replace("\\", "/")
    return sanitized[:-1] if sanitized.endswith("/") else sanitized


def _default_asset_path(label: str, asset_prefix: str) -> str:
    if not asset_prefix:
        return f"{label}.animation.json"
    return f"{asset_prefix}/{label}.animation.json"


def _default_output_path(root_label: str, time_slug: str) -> Path:
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", root_label) or "root"
    return atlas_common.DEFAULT_MAPS_DIR / time_slug / "animated" / f"{base}_connections.json"


def parse_args() -> argparse.Namespace:
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
        default=atlas_common.DEFAULT_POLISHED_PATH / "data/maps/attributes.asm",
        help="Path to attributes.asm (defaults to the polishedcrystal checkout).",
    )
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=atlas_common.DEFAULT_POLISHED_PATH,
        help="Path to the polishedcrystal repository root (for additional metadata).",
    )
    parser.add_argument(
        "--time-of-day",
        type=render_map.parse_time_of_day,
        default=1,
        help=(
            "Time of day palette (0-3 or morn/day/nite/eve). Determines default output locations and asset paths."
        ),
    )
    parser.add_argument(
        "--asset-prefix",
        type=str,
        default=None,
        help="Override the asset path prefix stored in the connection graph (defaults to maps/<time>/animated).",
    )
    parser.add_argument(
        "--common-asset-prefix",
        type=str,
        default=None,
        help="Override the asset prefix used for time-invariant map assets (defaults to maps/common/animated).",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help=(
            "Destination JSON file (defaults to maps/<time>/animated/<root>_connections.json when not provided)."
        ),
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
            repo_index = atlas_common.repository(polished_path)
        except Exception as exc:  # pragma: no cover - defensive guard
            raise RuntimeError(f"Failed to initialise RepositoryIndex at {polished_path}: {exc}") from exc
    else:
        repo_index = None

    parser = AttributesParser(attributes_path)
    graph = parser.parse()
    _augment_with_repo(graph, repo_index)
    if repo_index:
        graph, _ = _layout_graph(graph, polished_path)
    reachable = _collect_reachable(graph, args.root)
    time_of_day = args.time_of_day
    time_slug = render_map.time_of_day_slug(time_of_day)
    asset_prefix = _normalise_asset_prefix(args.asset_prefix or f"maps/{time_slug}/animated")
    common_asset_prefix = _normalise_asset_prefix(args.common_asset_prefix or "maps/common/animated")
    invariant_labels: Set[str] = atlas_common.time_invariant_maps(repo_index) if repo_index else set()
    payload = {
        "root": args.root,
        "map_count": len(reachable),
        "maps": _serialise_connections(
            reachable,
            asset_prefix=asset_prefix,
            common_asset_prefix=common_asset_prefix,
            invariant_labels=invariant_labels,
        ),
        "block_pixel_size": atlas_common.block_pixel_size(),
    }

    output_path = (args.output or _default_output_path(args.root, time_slug)).resolve()
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
