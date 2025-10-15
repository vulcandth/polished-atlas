#!/usr/bin/env python3
"""Generate connection graphs for every overworld neighborhood.

This utility walks the polishedcrystal map graph, groups connected overworld maps
into neighborhoods, and writes one connection JSON per neighborhood alongside a
manifest describing their layout metadata. Neighborhoods are rooted at a
canonical map (preferring ``TOWN`` over ``ROUTE`` over ``ISOLATED``) so the
output is deterministic and duplicates are avoided.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

import render_map

from generate_map_connections import (
    AttributesParser,
    MapAttributes,
    MapConnection,
    _augment_with_repo,
    _collect_reachable,
    _default_repo_root,
    _normalise_asset_prefix,
    _serialise_connections,
    _to_pixels,
)

TARGET_TYPES = ("TOWN", "ROUTE", "ISOLATED")
AUTO_MARGIN_BLOCKS = 8
MANIFEST_FILENAME = "map_neighborhoods.json"


@dataclass
class Placement:
    label: str
    x: int
    y: int
    width: int
    height: int


@dataclass
class NeighborhoodRecord:
    id: str
    root: str
    filename: str
    map_labels: List[str]
    primary_type: Optional[str]
    types_present: List[str]
    fingerprint: str
    bounds_blocks: Tuple[int, int]
    offset_blocks: Tuple[float, float]
    z_offset: int
    map_count: int


@dataclass
class LayoutSpec:
    offset: Optional[Tuple[float, float]]
    z_offset: Optional[int]


def parse_args() -> argparse.Namespace:
    repo_root = _default_repo_root()
    parser = argparse.ArgumentParser(
        description="Generate connection graphs for every connected overworld neighborhood.",
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
        "--output-dir",
        type=Path,
        default=None,
        help="Directory for generated connection JSON files (defaults to maps/<time>/animated).",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="Destination for the manifest file (defaults to <output-dir>/map_neighborhoods.json).",
    )
    parser.add_argument(
        "--time-of-day",
        type=render_map.parse_time_of_day,
        default=1,
        help=(
            "Time of day palette (0-3 or morn/day/nite/eve). Controls default output locations and asset paths."
        ),
    )
    parser.add_argument(
        "--asset-prefix",
        type=str,
        default=None,
        help="Override the asset path prefix stored in connection graphs (defaults to maps/<time>/animated).",
    )
    parser.add_argument(
        "--layout-template",
        type=Path,
        default=None,
        help=(
            "Optional manifest to seed layout offsets and z ordering (defaults to the day manifest when available)."
        ),
    )
    parser.add_argument(
        "--types",
        nargs="+",
        default=list(TARGET_TYPES),
        help="Map types that must appear in a neighborhood to be exported (default: TOWN ROUTE ISOLATED).",
    )
    parser.add_argument(
        "--margin-blocks",
        type=int,
        default=AUTO_MARGIN_BLOCKS,
        help="Blocks of vertical spacing inserted between auto-positioned neighborhoods.",
    )
    return parser.parse_args()


def _sanitize_label(label: str) -> str:
    base = re.sub(r"[^A-Za-z0-9_-]+", "_", label)
    return base or "root"


def _connection_filename(root_label: str) -> str:
    return f"{_sanitize_label(root_label)}_connections.json"


def _build_adjacency(graph: Dict[str, MapAttributes]) -> Dict[str, Set[str]]:
    adjacency: Dict[str, Set[str]] = {label: set() for label in graph}
    for label, data in graph.items():
        for connection in data.connections:
            if connection.label not in graph:
                continue
            adjacency[label].add(connection.label)
            adjacency[connection.label].add(label)
    return adjacency


def _component_members(start: str, adjacency: Dict[str, Set[str]]) -> Set[str]:
    queue: deque[str] = deque([start])
    seen: Set[str] = set()
    while queue:
        label = queue.popleft()
        if label in seen:
            continue
        seen.add(label)
        queue.extend(adjacency.get(label, ()))
    return seen


def _component_has_target(
    component: Iterable[str],
    graph: Dict[str, MapAttributes],
    target_types: Sequence[str],
) -> bool:
    target_set = set(target_types)
    for label in component:
        map_type = graph[label].map_type
        if map_type in target_set:
            return True
    return False


def _rank_label(label: str, graph: Dict[str, MapAttributes], priority: Sequence[str]) -> Tuple[int, str]:
    data = graph[label]
    map_type = data.map_type or ""
    try:
        tier = priority.index(map_type)
    except ValueError:
        tier = len(priority)
    return tier, label


def _select_root(component: Iterable[str], graph: Dict[str, MapAttributes], priority: Sequence[str]) -> str:
    return min(component, key=lambda label: _rank_label(label, graph, priority))


def _fingerprint(labels: Sequence[str]) -> str:
    digest = hashlib.blake2s(
        "\0".join(sorted(labels)).encode("utf-8"),
        digest_size=12,
    )
    return digest.hexdigest()


def _ensure_dimension(value: Optional[int], label: str, kind: str) -> int:
    if value is None:
        raise ValueError(f"Map '{label}' missing {kind} metadata")
    return int(value)


def _project_neighbour(source: Placement, width: int, height: int, connection: MapConnection) -> Tuple[int, int]:
    offset = int(connection.offset)
    direction = connection.direction.lower()
    if direction == "north":
        return source.x + offset, source.y - height
    if direction == "south":
        return source.x + offset, source.y + source.height
    if direction == "west":
        return source.x - width, source.y + offset
    if direction == "east":
        return source.x + source.width, source.y + offset
    raise ValueError(f"Unsupported connection direction '{connection.direction}'")


def _build_layout(component: Dict[str, MapAttributes], root: str) -> Tuple[Dict[str, Placement], Tuple[int, int]]:
    root_data = component[root]
    root_width = _ensure_dimension(root_data.width, root, "width")
    root_height = _ensure_dimension(root_data.height, root, "height")
    placements: Dict[str, Placement] = {
        root: Placement(label=root, x=0, y=0, width=root_width, height=root_height)
    }
    queue: deque[str] = deque([root])
    visited: Set[str] = set()

    while queue:
        label = queue.popleft()
        if label in visited:
            continue
        visited.add(label)
        current = component.get(label)
        placement = placements.get(label)
        if current is None or placement is None:
            continue
        for connection in current.connections:
            neighbour_label = connection.label
            neighbour = component.get(neighbour_label)
            if neighbour is None:
                continue
            if neighbour_label in placements:
                continue
            try:
                width = _ensure_dimension(neighbour.width, neighbour_label, "width")
                height = _ensure_dimension(neighbour.height, neighbour_label, "height")
            except ValueError:
                continue
            try:
                x, y = _project_neighbour(placement, width, height, connection)
            except ValueError:
                continue
            placements[neighbour_label] = Placement(
                label=neighbour_label,
                x=x,
                y=y,
                width=width,
                height=height,
            )
            queue.append(neighbour_label)

    if not placements:
        raise ValueError(f"No placements calculated for component rooted at {root}")

    min_x = min(place.x for place in placements.values())
    min_y = min(place.y for place in placements.values())
    max_x = max(place.x + place.width for place in placements.values())
    max_y = max(place.y + place.height for place in placements.values())
    bounds = (max_x - min_x, max_y - min_y)
    return placements, bounds


def _load_existing_layout(manifest_paths: Iterable[Path]) -> Tuple[Dict[str, LayoutSpec], Dict[str, LayoutSpec], int]:
    by_fingerprint: Dict[str, LayoutSpec] = {}
    by_id: Dict[str, LayoutSpec] = {}
    max_z: Optional[int] = None
    for manifest_path in manifest_paths:
        if manifest_path is None or not manifest_path.exists():
            continue
        try:
            data = json.loads(manifest_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            continue
        neighborhoods = data.get("neighborhoods")
        if not isinstance(neighborhoods, list):
            continue
        for entry in neighborhoods:
            if not isinstance(entry, dict):
                continue
            fingerprint = entry.get("fingerprint")
            identifier = entry.get("id")
            offset = entry.get("offset_blocks")
            parsed_offset: Optional[Tuple[float, float]] = None
            if isinstance(offset, list) and len(offset) == 2:
                try:
                    parsed_offset = (float(offset[0]), float(offset[1]))
                except (TypeError, ValueError):
                    parsed_offset = None
            raw_z = entry.get("z_offset")
            parsed_z: Optional[int] = None
            if isinstance(raw_z, (int, float)) and not isinstance(raw_z, bool):
                try:
                    parsed_z = int(raw_z)
                except (TypeError, ValueError):
                    parsed_z = None
            if parsed_z is not None:
                max_z = parsed_z if max_z is None else max(max_z, parsed_z)
            if not fingerprint:
                continue
            spec = LayoutSpec(offset=parsed_offset, z_offset=parsed_z)
            fingerprint_key = str(fingerprint)
            if fingerprint_key not in by_fingerprint:
                by_fingerprint[fingerprint_key] = spec
            if isinstance(identifier, str) and identifier and identifier not in by_id:
                by_id[identifier] = spec
    next_z = (max_z + 1) if max_z is not None else 0
    return by_fingerprint, by_id, next_z


def _write_connection_file(
    output_path: Path,
    graph: Dict[str, MapAttributes],
    root_label: str,
    asset_prefix: str,
) -> None:
    payload = {
        "root": root_label,
        "map_count": len(graph),
        "maps": _serialise_connections(graph, asset_prefix=asset_prefix),
        "block_pixel_size": _to_pixels(1),
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def _build_manifest(
    manifest_path: Path,
    neighborhoods: List[NeighborhoodRecord],
) -> None:
    manifest_payload = {
        "version": 1,
        "generated_at": datetime.utcnow().replace(tzinfo=None).isoformat() + "Z",
        "neighborhoods": [
            {
                "id": record.id,
                "root": record.root,
                "graph": record.filename,
                "map_count": record.map_count,
                "primary_type": record.primary_type,
                "types_present": record.types_present,
                "map_labels": record.map_labels,
                "fingerprint": record.fingerprint,
                "bounds_blocks": {
                    "width": record.bounds_blocks[0],
                    "height": record.bounds_blocks[1],
                },
                "offset_blocks": [record.offset_blocks[0], record.offset_blocks[1]],
                "z_offset": record.z_offset,
            }
            for record in neighborhoods
        ],
    }
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    with manifest_path.open("w", encoding="utf-8") as handle:
        json.dump(manifest_payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def main() -> None:
    args = parse_args()
    attributes_path = args.attributes.resolve()
    polished_path = args.polishedcrystal.resolve()
    repo_root = _default_repo_root()
    time_of_day = args.time_of_day
    time_slug = render_map.time_of_day_slug(time_of_day)
    output_dir = (args.output_dir or (repo_root / "maps" / time_slug / "animated")).resolve()
    asset_prefix = _normalise_asset_prefix(args.asset_prefix or f"maps/{time_slug}/animated")
    manifest_path = (args.manifest or (output_dir / MANIFEST_FILENAME)).resolve()
    layout_sources: List[Path] = [manifest_path]
    if args.layout_template:
        template_path = args.layout_template.resolve()
        if template_path != manifest_path:
            layout_sources.append(template_path)
    elif time_slug != "day":
        day_manifest = (repo_root / "maps" / "day" / "animated" / MANIFEST_FILENAME).resolve()
        if day_manifest != manifest_path:
            layout_sources.append(day_manifest)
    # Deduplicate while preserving order to avoid reading the same manifest twice.
    deduped_layout_sources = list(dict.fromkeys(layout_sources))
    target_types: List[str] = [t.upper() for t in args.types]

    if not attributes_path.exists():
        raise FileNotFoundError(f"attributes.asm not found at {attributes_path}")
    if not polished_path.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {polished_path}")

    parser = AttributesParser(attributes_path)
    raw_graph = parser.parse()

    repo_index = render_map.RepositoryIndex(polished_path)
    _augment_with_repo(raw_graph, repo_index)

    adjacency = _build_adjacency(raw_graph)
    global_seen: Set[str] = set()
    components: List[Set[str]] = []

    for label in sorted(raw_graph):
        if label in global_seen:
            continue
        members = _component_members(label, adjacency)
        components.append(members)
        global_seen.update(members)

    existing_by_fingerprint, existing_by_id, auto_z_start = _load_existing_layout(deduped_layout_sources)
    auto_cursor: float = 0.0
    auto_z = auto_z_start
    neighborhoods: List[NeighborhoodRecord] = []
    encountered_fingerprints: Set[str] = set()

    for members in sorted((sorted(component) for component in components), key=lambda labels: labels[0]):
        if not _component_has_target(members, raw_graph, target_types):
            continue
        root_label = _select_root(members, raw_graph, target_types)
        reachable = _collect_reachable(raw_graph, root_label)
        filename = _connection_filename(root_label)
        output_path = output_dir / filename
        _write_connection_file(output_path, reachable, root_label, asset_prefix)
        _, bounds = _build_layout(reachable, root_label)
        map_labels = list(reachable.keys())
        fingerprint = _fingerprint(map_labels)
        if fingerprint in encountered_fingerprints:
            raise RuntimeError(f"Duplicate neighborhood detected for root {root_label}")
        encountered_fingerprints.add(fingerprint)
        primary_type = reachable[root_label].map_type
        types_present = sorted({reachable[label].map_type or "UNKNOWN" for label in map_labels})
        layout_hint = existing_by_fingerprint.get(fingerprint)
        if layout_hint is None:
            layout_hint = existing_by_id.get(root_label)
        offset = layout_hint.offset if layout_hint and layout_hint.offset is not None else None
        if offset is None:
            offset = (0.0, auto_cursor)
            auto_cursor += float(bounds[1]) + max(float(args.margin_blocks), 0.0)
        z_offset = layout_hint.z_offset if layout_hint and layout_hint.z_offset is not None else None
        if z_offset is None:
            z_offset = auto_z
            auto_z += 1
        neighborhoods.append(
            NeighborhoodRecord(
                id=root_label,
                root=root_label,
                filename=filename,
                map_labels=map_labels,
                primary_type=primary_type,
                types_present=types_present,
                fingerprint=fingerprint,
                bounds_blocks=bounds,
                offset_blocks=offset,
                z_offset=z_offset,
                map_count=len(map_labels),
            )
        )

    neighborhoods.sort(key=lambda record: (record.z_offset, record.root))
    _build_manifest(manifest_path, neighborhoods)

    print(f"Generated {len(neighborhoods)} neighborhoods into {output_dir}")
    print(f"Manifest written to {manifest_path}")


if __name__ == "__main__":  # pragma: no cover - script entry point
    main()
