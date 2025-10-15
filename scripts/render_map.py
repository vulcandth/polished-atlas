#!/usr/bin/env python3
"""Generate a PNG render (or animated GIF) of any polishedcrystal overworld map.

The script understands the repo's VRAM banking scheme, metatile format, and
LZ-compressed map blocks so it can source the same assets used by the game.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

RGB = Tuple[int, int, int]

# LZ compression command identifiers (matching the engine format).
_LZ_COMMANDS = {
    "literal": 0,
    "iterate": 1,
    "alternate": 2,
    "blank": 3,
    "repeat": 4,
    "flip": 5,
    "reverse": 6,
    "long": 7,
}
_LZ_END = 0xFF

# Precompute bit-flipped bytes for the "flip" command.
_BIT_FLIPPED = [
    sum(((byte >> i) & 1) << (7 - i) for i in range(8))
    for byte in range(0x100)
]

_DEFAULT_RGB: RGB = (0xAB, 0xCD, 0xEF)

_WEEKDAY_NAME_TO_VALUE = {
    "sunday": 0,
    "sun": 0,
    "monday": 1,
    "mon": 1,
    "tuesday": 2,
    "tue": 2,
    "wednesday": 3,
    "wed": 3,
    "thursday": 4,
    "thu": 4,
    "thurs": 4,
    "friday": 5,
    "fri": 5,
    "saturday": 6,
    "sat": 6,
}

_TIME_OF_DAY_NAME_TO_VALUE = {
    "morn": 0,
    "morning": 0,
    "day": 1,
    "nite": 2,
    "night": 2,
    "eve": 3,
    "evening": 3,
}

_AZALEA_OVERCAST_DAYS = {0, 2, 4, 6}
_LAKE_OF_RAGE_OVERCAST_DAYS = {1, 3, 5}

_AZALEA_OVERCAST_MAPS = {"AZALEA_TOWN", "ROUTE_33"}
_LAKE_OF_RAGE_OVERCAST_MAPS = {"LAKE_OF_RAGE", "ROUTE_43"}
_STORMY_OVERCAST_MAPS = {
    "STORMY_BEACH",
    "GOLDENROD_CITY",
    "MAGNET_TUNNEL_WEST",
    "ROUTE_34",
    "ROUTE_34_COAST",
}

_EVENT_AZALEA_SLOWPOKES = "EVENT_AZALEA_TOWN_SLOWPOKES"
_EVENT_LAKE_CIVILIANS = "EVENT_LAKE_OF_RAGE_CIVILIANS"
_EVENT_GOLDENROD_TAKEOVER = "EVENT_GOLDENROD_CITY_ROCKET_TAKEOVER"

_NOT_OVERCAST = 0
_AZALEA_OVERCAST_INDEX = 1
_LAKE_OF_RAGE_OVERCAST_INDEX = 2
_STORMY_BEACH_OVERCAST_INDEX = 3

_ROOF_GFX = {
    "ROOF_NEW_BARK": "gfx/tilesets/roofs/new_bark",
    "ROOF_VIOLET": "gfx/tilesets/roofs/violet",
    "ROOF_AZALEA": "gfx/tilesets/roofs/azalea",
    "ROOF_OLIVINE": "gfx/tilesets/roofs/olivine",
    "ROOF_STATUE": "gfx/tilesets/roofs/statue",
}

_ROOF_TILE_OFFSET = 0x0A
_ROOF_TILE_COUNT = 9
_GIF_FRAME_DURATION_MS = 400
_ANIMATION_FRAME_DURATION_MS = _GIF_FRAME_DURATION_MS
_MAX_SPRITE_SHEET_DIMENSION = 4096


@dataclass
class TileAnimation:
    tile_index: int
    frames: List[List[int]]
    sequence: List[int]


@dataclass
class GraphicsSource:
    path: str
    is_png: bool
    tile_offset: int = 0
    tile_length: Optional[int] = None
    needs_slice: bool = False


@dataclass(frozen=True)
class AnimationSpec:
    sources: Tuple[str, ...]
    repeat_each: int = 1
    sequence: Optional[Tuple[int, ...]] = None
    tile_index: Optional[int] = None


@dataclass(frozen=True)
class AnimationCommand:
    location: str
    tile_index: Optional[int]
    function: str
    data_label: Optional[str]

@dataclass(frozen=True)
class SpecialPaletteEntry:
    trigger: str
    identifier: Optional[str]
    palette_type: str
    source: str


@dataclass
class _MapHeader:
    tileset: str
    map_type: str
    location: str
    default_constant: Optional[str]
    palette_flags: Set[str]



_ANIMATION_SPECS: Dict[str, AnimationSpec] = {
    "AnimateWaterTile": AnimationSpec(("gfx/tilesets/water/johto_water.png",), repeat_each=2),
    "AnimateRainPuddleTile": AnimationSpec(("gfx/tilesets/rain/rain_puddle.png",), repeat_each=1),
    "AnimateRainWaterTile": AnimationSpec(("gfx/tilesets/rain/rain_water.png",), repeat_each=1),
    "AnimateFlowerTile": AnimationSpec(
        (
            "gfx/tilesets/flower/1.png",
            "gfx/tilesets/flower/2.png",
        ),
        repeat_each=2,
        tile_index=0x03,
    ),
    "AnimateKantoWaterTile": AnimationSpec(("gfx/tilesets/water/kanto_water.png",), repeat_each=2),
    "AnimateKantoFlowerTile": AnimationSpec(
        (
            "gfx/tilesets/kanto-flower/1.png",
            "gfx/tilesets/kanto-flower/2.png",
            "gfx/tilesets/kanto-flower/3.png",
            "gfx/tilesets/kanto-flower/1.png",
        ),
        repeat_each=2,
        tile_index=0x03,
    ),
    "AnimateFarawayWaterTile": AnimationSpec(tuple(), repeat_each=2),
    "AnimateFountain": AnimationSpec(
        (
            "gfx/tilesets/fountain/1.png",
            "gfx/tilesets/fountain/2.png",
            "gfx/tilesets/fountain/3.png",
            "gfx/tilesets/fountain/4.png",
            "gfx/tilesets/fountain/5.png",
        ),
        sequence=(0, 1, 2, 3, 2, 3, 4, 0),
    ),
    "AnimateLCDTile": AnimationSpec(
        (
            "gfx/tilesets/lcd/1.png",
            "gfx/tilesets/lcd/2.png",
            "gfx/tilesets/lcd/3.png",
            "gfx/tilesets/lcd/4.png",
            "gfx/tilesets/lcd/5.png",
            "gfx/tilesets/lcd/6.png",
            "gfx/tilesets/lcd/7.png",
            "gfx/tilesets/lcd/8.png",
        ),
        tile_index=0x5E,
    ),
    "AnimateTinyWaterTile": AnimationSpec(tuple(), repeat_each=2),
    "AnimateTowerPillarTile": AnimationSpec(tuple(), sequence=(0, 1, 2, 3, 4, 3, 2, 1)),
    "ForestTreeLeftAnimation": AnimationSpec(
        (
            "gfx/tilesets/forest-tree/1.png",
            "gfx/tilesets/forest-tree/2.png",
        ),
        tile_index=0x50,
    ),
    "ForestTreeLeftAnimation2": AnimationSpec(
        (
            "gfx/tilesets/forest-tree/1.png",
            "gfx/tilesets/forest-tree/2.png",
        ),
        sequence=(1, 0),
        tile_index=0x50,
    ),
    "ForestTreeRightAnimation": AnimationSpec(
        (
            "gfx/tilesets/forest-tree/3.png",
            "gfx/tilesets/forest-tree/4.png",
        ),
        tile_index=0x53,
    ),
    "ForestTreeRightAnimation2": AnimationSpec(
        (
            "gfx/tilesets/forest-tree/3.png",
            "gfx/tilesets/forest-tree/4.png",
        ),
        sequence=(1, 0),
        tile_index=0x53,
    ),
    "ForestTree2LeftAnimation": AnimationSpec(
        (
            "gfx/tilesets/forest-tree-2/1.png",
            "gfx/tilesets/forest-tree-2/2.png",
        ),
        tile_index=0x5C,
    ),
    "ForestTree2LeftAnimation2": AnimationSpec(
        (
            "gfx/tilesets/forest-tree-2/1.png",
            "gfx/tilesets/forest-tree-2/2.png",
        ),
        sequence=(1, 0),
        tile_index=0x5C,
    ),
    "ForestTree2RightAnimation": AnimationSpec(
        (
            "gfx/tilesets/forest-tree-2/3.png",
            "gfx/tilesets/forest-tree-2/4.png",
        ),
        tile_index=0x5F,
    ),
    "ForestTree2RightAnimation2": AnimationSpec(
        (
            "gfx/tilesets/forest-tree-2/3.png",
            "gfx/tilesets/forest-tree-2/4.png",
        ),
        sequence=(1, 0),
        tile_index=0x5F,
    ),
    "LavaBubbleAnim1": AnimationSpec(
        (
            "gfx/tilesets/lava/1.png",
            "gfx/tilesets/lava/2.png",
            "gfx/tilesets/lava/3.png",
            "gfx/tilesets/lava/4.png",
        ),
        sequence=(2, 2, 3, 3, 0, 0, 1, 1),
        tile_index=0x5B,
    ),
    "LavaBubbleAnim2": AnimationSpec(
        (
            "gfx/tilesets/lava/1.png",
            "gfx/tilesets/lava/2.png",
            "gfx/tilesets/lava/3.png",
            "gfx/tilesets/lava/4.png",
        ),
        sequence=(0, 0, 1, 1, 2, 2, 3, 3),
        tile_index=0x38,
    ),
    "LavaBubbleAnim3": AnimationSpec(
        (
            "gfx/tilesets/lava/1.png",
            "gfx/tilesets/lava/2.png",
            "gfx/tilesets/lava/3.png",
            "gfx/tilesets/lava/4.png",
        ),
        sequence=(2, 2, 3, 3, 0, 0, 1, 1),
        tile_index=0x3D,
    ),
    "LavaBubbleAnim4": AnimationSpec(
        (
            "gfx/tilesets/lava/1.png",
            "gfx/tilesets/lava/2.png",
            "gfx/tilesets/lava/3.png",
            "gfx/tilesets/lava/4.png",
        ),
        sequence=(0, 0, 1, 1, 2, 2, 3, 3),
        tile_index=0x3C,
    ),
    "SpinnerAnimation": AnimationSpec(
        (
            "gfx/tilesets/spinner/1.png",
            "gfx/tilesets/spinner/2.png",
        ),
        repeat_each=2,
        tile_index=0x50,
    ),
}

_ANIMATION_DATA_SPECS: Dict[str, AnimationSpec] = {
    "WhirlpoolTiles1": AnimationSpec(("gfx/tilesets/whirlpool/1.png",), repeat_each=1),
    "WhirlpoolTiles2": AnimationSpec(("gfx/tilesets/whirlpool/2.png",), repeat_each=1),
    "WhirlpoolTiles3": AnimationSpec(("gfx/tilesets/whirlpool/3.png",), repeat_each=1),
    "WhirlpoolTiles4": AnimationSpec(("gfx/tilesets/whirlpool/4.png",), repeat_each=1),
    "FarawayWaterTiles1": AnimationSpec(("gfx/tilesets/water/faraway_water_1.png",), repeat_each=1),
    "FarawayWaterTiles2": AnimationSpec(("gfx/tilesets/water/faraway_water_2.png",), repeat_each=1),
    "TinyWaterTile": AnimationSpec(("gfx/tilesets/tiny/water.png",), repeat_each=1),
    "TinyPierTile": AnimationSpec(("gfx/tilesets/tiny/pier.png",), repeat_each=1),
    "TinyShoreTile": AnimationSpec(("gfx/tilesets/tiny/shore.png",), repeat_each=1),
    "TowerPillarTile1": AnimationSpec(("gfx/tilesets/tower-pillar/1.png",), repeat_each=1),
    "TowerPillarTile2": AnimationSpec(("gfx/tilesets/tower-pillar/2.png",), repeat_each=1),
    "TowerPillarTile3": AnimationSpec(("gfx/tilesets/tower-pillar/3.png",), repeat_each=1),
    "TowerPillarTile4": AnimationSpec(("gfx/tilesets/tower-pillar/4.png",), repeat_each=1),
    "TowerPillarTile5": AnimationSpec(("gfx/tilesets/tower-pillar/5.png",), repeat_each=1),
    "TowerPillarTile6": AnimationSpec(("gfx/tilesets/tower-pillar/6.png",), repeat_each=1),
    "TowerPillarTile7": AnimationSpec(("gfx/tilesets/tower-pillar/7.png",), repeat_each=1),
    "TowerPillarTile8": AnimationSpec(("gfx/tilesets/tower-pillar/8.png",), repeat_each=1),
    "TowerPillarTile9": AnimationSpec(("gfx/tilesets/tower-pillar/9.png",), repeat_each=1),
    "TowerPillarTile10": AnimationSpec(("gfx/tilesets/tower-pillar/10.png",), repeat_each=1),
}

_ANIMATION_TABLE_CACHE: Dict[str, Dict[str, List[AnimationCommand]]] = {}


@dataclass
class RendererData:
    block_indices: List[int]
    width: int
    height: int
    attributes: "Attributes"
    metatile_data: bytes
    bank0_tiles: List[List[int]]
    bank1_tiles: List[List[int]]
    tileset_key: str
    tileset_label: str
    map_label: str


@dataclass
class MapInfo:
    label: str
    tileset: str
    constant: str
    map_type: str
    width: int
    height: int
    group: int
    map_number: int
    roof_constant: Optional[str]
    tileset_index: int
    block_label: str
    location: str
    location_index: Optional[int]
    palette_flags: Set[str]
    region: Optional[int]


@dataclass
class TilesetResources:
    metatiles_path: str
    attributes_path: str
    bank0_sources: List[GraphicsSource]
    bank1_sources: List[GraphicsSource]


class RepositoryIndex:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._default_weekday = self._determine_default_weekday()
        self._initial_event_flags = self._parse_initial_event_flags()
        self._bg_tile_palettes = _load_palette(self.root / "gfx/tilesets/bg_tiles.pal")
        self._environment_palette_indices = self._parse_environment_colors()
        self._map_constants = self._parse_map_constants()
        self._map_roofs = self._parse_map_roofs()
        self._roof_palettes = self._parse_roof_palettes()
        self._overcast_roof_palettes = self._parse_overcast_roof_palettes()
        (
            self._landmark_indices,
            self._kanto_landmark_index,
            self._shamouti_landmark_index,
        ) = self._parse_landmark_constants()
        self._map_table = self._parse_map_table()
        self._map_attributes = self._parse_map_attributes()
        (
            self._tileset_constants,
            self._tileset_indices,
            self._no_roof_tilesets,
        ) = self._parse_tileset_constants()
        self._tileset_labels = self._parse_tileset_table()
        self._tileset_assets = self._parse_tileset_assets()
        self._block_assets = self._parse_block_assets()
        self._special_bg_palettes = self._parse_special_bg_palettes()
        self._constant_to_tileset_label = {
            constant: label
            for constant, label in zip(self._tileset_constants, self._tileset_labels)
        }
        self._palette_cache: Dict[str, List[Tuple[RGB, ...]]] = {}
        self.maps = self._build_map_infos()
        self.tilesets = self._build_tileset_resources()

    def map_info(self, label: str) -> MapInfo:
        try:
            return self.maps[label]
        except KeyError as exc:
            raise KeyError(f"Unknown map label '{label}'") from exc

    def tileset_resources(self, tileset_constant: str) -> TilesetResources:
        try:
            return self.tilesets[tileset_constant]
        except KeyError as exc:
            raise KeyError(f"Missing tileset resources for {tileset_constant}") from exc

    def tileset_label(self, tileset_constant: str) -> Optional[str]:
        return self._constant_to_tileset_label.get(tileset_constant)

    def tileset_index(self, tileset_constant: str) -> Optional[int]:
        return self._tileset_indices.get(tileset_constant)

    def block_asset(self, block_label: str) -> Optional[str]:
        return self._block_assets.get(block_label)

    @property
    def no_roof_tileset_threshold(self) -> int:
        return self._no_roof_tilesets

    @property
    def initial_event_flags(self) -> Set[str]:
        return set(self._initial_event_flags)

    def roof_palette(self, group: int, time_of_day: int = 1) -> Optional[Tuple[RGB, RGB]]:
        if 0 <= group < len(self._roof_palettes):
            palettes = self._roof_palettes[group]
            if not palettes:
                return None
            palette_index = self._time_of_day_palette_index(time_of_day)
            palette_index = min(palette_index, len(palettes) - 1)
            return palettes[palette_index]
        return None

    def roof_constant(self, group: int) -> Optional[str]:
        if 0 <= group < len(self._map_roofs):
            return self._map_roofs[group]
        return None

    def overcast_roof_palette(self, index: int, time_of_day: int = 1) -> Optional[Tuple[RGB, RGB]]:
        if index <= 0 or index > len(self._overcast_roof_palettes):
            return None
        palettes = self._overcast_roof_palettes[index - 1]
        if not palettes:
            return None
        palette_index = self._time_of_day_palette_index(time_of_day)
        palette_index = min(palette_index, len(palettes) - 1)
        return palettes[palette_index]

    @staticmethod
    def _time_of_day_palette_index(time_of_day: int) -> int:
        if time_of_day >= 3:
            return 2
        if time_of_day == 2:
            return 1
        return 0

    @staticmethod
    def _determine_default_weekday() -> int:
        return 1

    def _parse_initial_event_flags(self) -> Set[str]:
        path = self.root / "data/events/initialize_events.asm"
        flags: Set[str] = set()
        if not path.exists():
            return flags
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line or not line.startswith("dw"):
                continue
            entries = [entry.strip() for entry in line[2:].split(",") if entry.strip()]
            for entry in entries:
                if entry == "-1":
                    return flags
                flags.add(entry)
        return flags

    def _parse_map_table(self) -> dict[str, _MapHeader]:
        path = self.root / "data/maps/maps.asm"
        mapping: dict[str, _MapHeader] = {}
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line.startswith("map "):
                continue
            parts = [part.strip() for part in line.split(",")]
            if len(parts) < 5:
                continue
            label = parts[0].split()[1]
            tileset = parts[1]
            map_type = parts[2]
            location = parts[4]
            default_constant = parts[4] if len(parts) > 4 else None
            palette_flags: Set[str] = set()
            if len(parts) > 7:
                palette_flags = {flag.strip() for flag in parts[7].split("|") if flag.strip()}
            mapping[label] = _MapHeader(
                tileset=tileset,
                map_type=map_type,
                location=location,
                default_constant=default_constant,
                palette_flags=palette_flags,
            )
        return mapping

    def _parse_map_attributes(self) -> dict[str, str]:
        path = self.root / "data/maps/attributes.asm"
        mapping: dict[str, str] = {}
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line.startswith("map_attributes"):
                continue
            parts = [part.strip() for part in line[len("map_attributes") :].split(",")]
            if len(parts) < 2:
                continue
            label = parts[0]
            constant = parts[1]
            mapping[label] = constant
        return mapping

    def _parse_map_constants(self) -> dict[str, Tuple[int, int, int, int]]:
        path = self.root / "constants/map_constants.asm"
        constants: dict[str, Tuple[int, int, int, int]] = {}
        group = 0
        number = 0
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            if line.startswith("newgroup"):
                group += 1
                number = 0
                continue
            if line.startswith("map_const"):
                number += 1
                try:
                    _, rest = line.split(None, 1)
                except ValueError:
                    continue
                name_part, dimensions = rest.split(",", 1)
                name = name_part.strip()
                width_str, height_str = dimensions.split(",", 1)
                width = int(width_str.strip())
                height = int(height_str.strip())
                constants[name] = (width, height, group, number)
        return constants

    def _parse_map_roofs(self) -> List[Optional[str]]:
        path = self.root / "data/maps/roofs.asm"
        entries: List[Optional[str]] = []
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line or not line.startswith("db"):
                continue
            value = line[2:].strip()
            entries.append(None if value in {"-1", "0", ""} else value)
        return entries

    def _parse_roof_palettes(self) -> List[List[Tuple[RGB, RGB]]]:
        path = self.root / "gfx/tilesets/roofs.pal"
        palettes: List[List[Tuple[RGB, RGB]]] = []
        for raw_line in path.read_text().splitlines():
            stripped = raw_line.strip()
            if stripped.startswith("else"):
                break
            line = raw_line.split(";", 1)[0].strip()
            if not line.startswith("RGB"):
                continue
            numbers = [int(value) for value in re.findall(r"\d+", line)]
            if not numbers:
                palettes.append([])
                continue
            colors = [
                tuple(component * 8 for component in numbers[index : index + 3])
                for index in range(0, len(numbers), 3)
            ]
            pairs: List[Tuple[RGB, RGB]] = []
            for index in range(0, len(colors), 2):
                if index + 1 >= len(colors):
                    break
                pairs.append((colors[index], colors[index + 1]))
            palettes.append(pairs)
        return palettes

    def _parse_overcast_roof_palettes(self) -> List[List[Tuple[RGB, RGB]]]:
        path = self.root / "gfx/tilesets/roofs_overcast.pal"
        palettes: List[List[Tuple[RGB, RGB]]] = []
        for raw_line in path.read_text().splitlines():
            stripped = raw_line.strip()
            if stripped.startswith("else"):
                break
            line = raw_line.split(";", 1)[0].strip()
            if not line.startswith("RGB"):
                continue
            numbers = [int(value) for value in re.findall(r"\d+", line)]
            if not numbers:
                continue
            colors = [
                tuple(component * 8 for component in numbers[index : index + 3])
                for index in range(0, len(numbers), 3)
            ]
            pairs: List[Tuple[RGB, RGB]] = []
            for index in range(0, len(colors), 2):
                if index + 1 >= len(colors):
                    break
                pairs.append((colors[index], colors[index + 1]))
            palettes.append(pairs)
        return palettes

    def _parse_environment_colors(self) -> Dict[str, List[List[int]]]:
        path = self.root / "data/maps/environment_colors.asm"
        if not path.exists():
            return {}
        lines = path.read_text().splitlines()
        env_to_label: Dict[str, str] = {}
        pointer_section = False
        for raw_line in lines:
            code, _, comment = raw_line.partition(";")
            stripped = code.strip()
            if not pointer_section:
                if stripped.startswith("EnvironmentColorsPointers"):
                    pointer_section = True
                continue
            if stripped.startswith("assert_table_length"):
                break
            if not stripped:
                continue
            if stripped.startswith("dr"):
                label = stripped[3:].strip()
                if label.startswith('.'):
                    label = label[1:]
                env_name = comment.strip().split()[0].upper() if comment.strip() else ""
                if env_name and env_name != "UNUSED":
                    env_to_label[env_name] = label
                continue

        label_data: Dict[str, List[List[int]]] = {}
        current_labels: List[str] = []
        started_data = False
        for raw_line in lines:
            code, _, _ = raw_line.partition(";")
            stripped = code.strip()
            if not stripped:
                if started_data:
                    current_labels = []
                    started_data = False
                continue
            if stripped.endswith(":"):
                label = stripped.rstrip(":")
                if label.startswith('.'):
                    label = label[1:]
                if started_data:
                    current_labels = []
                    started_data = False
                current_labels.append(label)
                continue
            if stripped.startswith("db"):
                values: List[int] = []
                for token in stripped[2:].split(","):
                    element = token.strip()
                    if not element:
                        continue
                    if element.startswith("$"):
                        values.append(int(element[1:], 16))
                    else:
                        values.append(int(element, 0))
                if not values:
                    continue
                started_data = True
                for label in current_labels:
                    label_data.setdefault(label, []).append(values)
                continue
            if started_data:
                current_labels = []
                started_data = False

        environment_palettes: Dict[str, List[List[int]]] = {}
        for env_name, label in env_to_label.items():
            rows = label_data.get(label, [])
            environment_palettes[env_name] = [list(row) for row in rows]
        return environment_palettes

    def _parse_landmark_constants(self) -> Tuple[Dict[str, int], Optional[int], Optional[int]]:
        path = self.root / "constants/landmark_constants.asm"
        mapping: Dict[str, int] = {}
        current = 0
        kanto_start: Optional[int] = None
        shamouti_start: Optional[int] = None
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            if line == "const_def":
                current = 0
                continue
            if line.startswith("DEF NUM_LANDMARKS"):
                break
            if line.startswith("DEF KANTO_LANDMARK"):
                kanto_start = current
                continue
            if line.startswith("DEF SHAMOUTI_LANDMARK"):
                shamouti_start = current
                continue
            if line.startswith("const "):
                parts = line.split()
                if len(parts) >= 2:
                    mapping[parts[1]] = current
                    current += 1
        return mapping, kanto_start, shamouti_start

    def _region_for_location(self, location_index: Optional[int]) -> Optional[int]:
        if location_index is None:
            return None
        if self._shamouti_landmark_index is not None and location_index >= self._shamouti_landmark_index:
            return 2
        if self._kanto_landmark_index is not None and location_index >= self._kanto_landmark_index:
            return 1
        return 0

    def _parse_tileset_constants(self) -> Tuple[List[str], dict[str, int], int]:
        path = self.root / "constants/tileset_constants.asm"
        constants: List[str] = []
        indices: dict[str, int] = {}
        no_roof_tilesets: Optional[int] = None
        current = 0
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            if line.startswith("const_def"):
                parts = line.split()
                value = parts[1] if len(parts) > 1 else "0"
                current = int(value, 0)
                continue
            if line.startswith("const TILESET_"):
                parts = line.split()
                if len(parts) >= 2:
                    name = parts[1]
                    constants.append(name)
                    indices[name] = current
                    current += 1
                continue
            if line.startswith("DEF ") and "EQU const_value" in line:
                parts = line.split()
                if len(parts) >= 2 and parts[1] == "NO_ROOF_TILESETS":
                    no_roof_tilesets = current
                continue
            if line.startswith("DEF NUM_TILESETS"):
                break
        if no_roof_tilesets is None:
            raise ValueError("NO_ROOF_TILESETS not found in tileset constants")
        return constants, indices, no_roof_tilesets

    def _parse_tileset_table(self) -> List[str]:
        path = self.root / "data/tilesets.asm"
        labels: List[str] = []
        in_table = False
        for raw_line in path.read_text().splitlines():
            line = raw_line.strip()
            if not in_table:
                if line.startswith("Tilesets::"):
                    in_table = True
                continue
            if line.startswith("tileset "):
                parts = line.split()
                if len(parts) >= 2:
                    labels.append(parts[1])
                continue
            if line.startswith("assert_table_length"):
                break
        return labels

    def _parse_tileset_assets(self) -> dict[str, dict[str, str]]:
        path = self.root / "data/tilesets.asm"
        assets: dict[str, dict[str, str]] = {}
        pending: List[Tuple[str, str]] = []
        label_pattern = re.compile(r"Tileset(\w+)(GFX\d+|Meta|Attr)::")
        asset_pattern = re.compile(r'INCBIN\s+"([^"]+)"')
        for raw_line in path.read_text().splitlines():
            stripped = raw_line.strip()
            label_match = label_pattern.match(stripped)
            if label_match:
                label = f"Tileset{label_match.group(1)}"
                section = label_match.group(2)
                pending.append((label, section))
                asset_match = asset_pattern.search(stripped)
                if asset_match:
                    asset_path = asset_match.group(1)
                    for lbl, sec in pending:
                        assets.setdefault(lbl, {})[sec] = asset_path
                    pending.clear()
                continue
            asset_match = asset_pattern.search(stripped)
            if asset_match and pending:
                asset_path = asset_match.group(1)
                for lbl, sec in pending:
                    assets.setdefault(lbl, {})[sec] = asset_path
                pending.clear()
                continue
            if pending and (stripped.startswith("SECTION") or stripped.startswith("db") or stripped.startswith("INCLUDE")):
                pending.clear()
        return assets

    def _parse_block_assets(self) -> dict[str, str]:
        path = self.root / "data/maps/blocks.asm"
        assets: dict[str, str] = {}
        pending: List[str] = []
        incbin_pattern = re.compile(r'INCBIN\s+"([^"]+)"')
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            if line.startswith("SECTION"):
                pending.clear()
                continue
            if line.endswith(":"):
                label = line.rstrip(":")
                while label.endswith(":"):
                    label = label[:-1]
                if label:
                    pending.append(label)
                continue
            match = incbin_pattern.search(line)
            if match:
                asset_path = match.group(1)
                for label in pending:
                    assets[label] = asset_path
                pending.clear()
            elif pending:
                pending.clear()
        return assets

    def _parse_special_bg_palettes(self) -> List[SpecialPaletteEntry]:
        path = self.root / "data/maps/palettes.asm"
        entries: List[SpecialPaletteEntry] = []
        in_table = False
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            if not in_table:
                if line.startswith("SpecialBGPalettes"):
                    in_table = True
                continue
            if line.startswith("db 0"):
                break
            if not line.startswith("special_bg_pal"):
                continue
            parts = [part.strip() for part in line[len("special_bg_pal") :].split(",")]
            if len(parts) != 4:
                continue
            trigger, identifier, palette_type, source = parts
            entries.append(
                SpecialPaletteEntry(
                    trigger=trigger,
                    identifier=self._normalize_special_identifier(identifier),
                    palette_type=palette_type,
                    source=source,
                )
            )
        return entries

    @staticmethod
    def _normalize_special_identifier(identifier: str) -> Optional[str]:
        value = identifier.strip()
        if not value or value == "(unused)":
            return None
        if value.startswith("(") and value.endswith(")"):
            value = value[1:-1].strip()
        return value

    @staticmethod
    def _clone_palette_list(palettes: Sequence[Sequence[RGB]]) -> List[List[RGB]]:
        return [list(palette) for palette in palettes]

    @staticmethod
    def _ensure_palette_length(palettes: List[List[RGB]], target: int = 7) -> List[List[RGB]]:
        if len(palettes) >= target:
            return [list(palette) for palette in palettes[:target]]
        if not palettes:
            return [[_DEFAULT_RGB] * 4 for _ in range(target)]
        padded = [list(palette) for palette in palettes]
        while len(padded) < target:
            padded.append(list(padded[-1]))
        return padded

    def _is_overcast_map(
        self,
        map_info: MapInfo,
        weekday: Optional[int] = None,
        events: Optional[Set[str]] = None,
    ) -> bool:
        return self.get_overcast_index(map_info, weekday=weekday, events=events) is not None

    def get_overcast_index(
        self,
        map_info: MapInfo,
        weekday: Optional[int] = None,
        events: Optional[Set[str]] = None,
    ) -> Optional[int]:
        events_set: Set[str]
        if events is None:
            events_set = set(self._initial_event_flags)
        else:
            events_set = set(events)
        day = (self._default_weekday if weekday is None else weekday) % 7
        constant = map_info.constant
        if constant in _AZALEA_OVERCAST_MAPS:
            if _EVENT_AZALEA_SLOWPOKES in events_set:
                return None
            if day in _AZALEA_OVERCAST_DAYS:
                return _AZALEA_OVERCAST_INDEX
            return None
        if constant in _LAKE_OF_RAGE_OVERCAST_MAPS:
            if _EVENT_LAKE_CIVILIANS in events_set:
                return _LAKE_OF_RAGE_OVERCAST_INDEX
            if day in _LAKE_OF_RAGE_OVERCAST_DAYS:
                return _LAKE_OF_RAGE_OVERCAST_INDEX
            return None
        if constant in _STORMY_OVERCAST_MAPS:
            if constant == "STORMY_BEACH":
                return _STORMY_BEACH_OVERCAST_INDEX
            if _EVENT_GOLDENROD_TAKEOVER in events_set:
                return None
            return _STORMY_BEACH_OVERCAST_INDEX
        return None

    def _special_entry_applies(
        self,
        entry: SpecialPaletteEntry,
        map_info: MapInfo,
        weekday: Optional[int] = None,
        events: Optional[Set[str]] = None,
        overcast_index: Optional[int] = None,
    ) -> bool:
        trigger = entry.trigger
        identifier = entry.identifier
        if trigger == "map":
            return identifier == map_info.constant
        if trigger == "landmark":
            return identifier == map_info.location
        if trigger == "tileset":
            return identifier == map_info.tileset
        if trigger == "darkness":
            return "IN_DARKNESS" in map_info.palette_flags
        if trigger == "overcast":
            if overcast_index is None:
                overcast_index = self.get_overcast_index(map_info, weekday=weekday, events=events)
            return overcast_index is not None
        return False

    def _palette_from_entry(
        self,
        entry: SpecialPaletteEntry,
        map_info: MapInfo,
        time_of_day: int,
    ) -> Optional[List[List[RGB]]]:
        if entry.palette_type == "PAL_SINGLE":
            base = self._load_palette_by_label(entry.source)
            if not base:
                return None
            palettes = self._clone_palette_list(base)
            return self._ensure_palette_length(palettes)
        if entry.palette_type == "PAL_TIMEOFDAY":
            base = self._load_palette_by_label(entry.source)
            if not base:
                return None
            block_size = 8
            time_index = time_of_day & 0x03
            start = time_index * block_size
            block = base[start : start + block_size]
            if len(block) < 7:
                block = base[:block_size]
            palettes = self._clone_palette_list(block[:7])
            return self._ensure_palette_length(palettes)
        if entry.palette_type == "PAL_SPECIAL":
            return self._palette_from_special_case(entry.source, map_info)
        return None

    def _palette_from_special_case(self, label: str, map_info: MapInfo) -> Optional[List[List[RGB]]]:
        if label == "PokeCenterSpecialCase":
            base = self._load_palette_by_label("PokeCenterPalette")
            if len(base) < 7:
                return None
            palettes = self._clone_palette_list(base[:7])
            region = map_info.region
            if region == 2:
                return self._ensure_palette_length(palettes)
            if region == 1:
                source_index = 3  # PAL_BG_WATER
            else:
                if map_info.location == "SNOWTOP_MOUNTAIN":
                    source_index = 5  # PAL_BG_BROWN
                else:
                    source_index = 1  # PAL_BG_RED
            if len(palettes) > 6 and 0 <= source_index < len(palettes):
                palettes[6] = list(palettes[source_index])
            return self._ensure_palette_length(palettes)
        if label == "MartSpecialCase":
            base = self._load_palette_by_label("MartPalette")
            if not base:
                return None
            palettes = self._clone_palette_list(base[:7])
            asset_path = self.block_asset(map_info.block_label)
            if asset_path:
                normalized = asset_path.replace("\\", "/")
                if normalized.endswith("Mart.ablk") or normalized.endswith("Mart.ablk.lz"):
                    blue_source = self._load_palette_by_label("MartBluePalette")
                    if blue_source and len(palettes) > 2:
                        palettes[2] = list(blue_source[0])
            return self._ensure_palette_length(palettes)
        base = self._load_palette_by_label(label)
        if not base:
            return None
        palettes = self._clone_palette_list(base)
        return self._ensure_palette_length(palettes)

    def _load_palette_by_label(self, label: str) -> List[List[RGB]]:
        cached = self._palette_cache.get(label)
        if cached is not None:
            return self._clone_palette_list(cached)
        path = self.root / "data/maps/palettes.asm"
        lines = path.read_text().splitlines()
        label_pattern = re.compile(rf"^{re.escape(label)}::?")
        start_index: Optional[int] = None
        for index, raw_line in enumerate(lines):
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            if label_pattern.match(line):
                start_index = index + 1
                break
        if start_index is None:
            raise KeyError(f"Palette label '{label}' not found")
        include_paths: List[str] = []
        rgb_values: List[Tuple[int, int, int]] = []
        depth = 0
        using_target_branch = True
        within_monochrome_guard = False
        for index in range(start_index, len(lines)):
            raw_line = lines[index]
            stripped = raw_line.split(";", 1)[0].strip()
            if not stripped:
                continue
            if re.match(r"^[A-Za-z0-9_]+::?", stripped):
                break
            if stripped.startswith("if"):
                depth += 1
                if stripped.startswith("if !DEF(MONOCHROME)"):
                    using_target_branch = True
                    within_monochrome_guard = True
                elif depth == 1:
                    using_target_branch = False
                continue
            if stripped.startswith("else"):
                if within_monochrome_guard and depth == 1:
                    using_target_branch = False
                continue
            if stripped.startswith("endc"):
                if depth > 0:
                    if within_monochrome_guard and depth == 1:
                        using_target_branch = False
                        within_monochrome_guard = False
                    depth -= 1
                if depth <= 0:
                    break
                continue
            if not using_target_branch:
                continue
            if stripped.startswith("INCLUDE") or stripped.startswith("INCBIN"):
                match = re.search(r'"([^"]+)"', stripped)
                if match:
                    include_paths.append(match.group(1))
                continue
            if stripped.startswith("RGB"):
                numbers = [int(value) for value in re.findall(r"\d+", stripped)]
                for offset in range(0, len(numbers), 3):
                    chunk = numbers[offset : offset + 3]
                    if len(chunk) == 3:
                        rgb_values.append(tuple(component * 8 for component in chunk))
                continue
        palettes: List[List[RGB]] = []
        for include_path in include_paths:
            palettes.extend(_load_palette(self.root / include_path))
        if rgb_values:
            for index in range(0, len(rgb_values), 4):
                group = rgb_values[index : index + 4]
                if len(group) == 4:
                    palettes.append([tuple(color) for color in group])
        if not palettes:
            return []
        frozen: List[Tuple[RGB, ...]] = [tuple(tuple(color) for color in palette) for palette in palettes]
        self._palette_cache[label] = frozen
        return self._clone_palette_list(frozen)

    def environment_palette(self, map_info: MapInfo, time_of_day: int) -> List[List[RGB]]:
        map_type_key = map_info.map_type.upper()
        indices_by_time = self._environment_palette_indices.get(map_type_key)
        if indices_by_time is None:
            indices_by_time = self._environment_palette_indices.get("INDOOR")
        selected: List[List[RGB]] = []
        if indices_by_time:
            time_index = time_of_day & 0x03
            if time_index >= len(indices_by_time):
                time_index = 0
            raw_indices = indices_by_time[time_index][:7]
            for palette_index in raw_indices:
                if 0 <= palette_index < len(self._bg_tile_palettes):
                    selected.append(list(self._bg_tile_palettes[palette_index]))
        if not selected:
            selected = [list(palette) for palette in self._bg_tile_palettes[:7]]
        return self._ensure_palette_length(selected)

    def special_background_palette(
        self,
        map_info: MapInfo,
        time_of_day: int,
        weekday: Optional[int] = None,
        events: Optional[Set[str]] = None,
    ) -> Optional[List[List[RGB]]]:
        overcast_index = self.get_overcast_index(map_info, weekday=weekday, events=events)
        for entry in self._special_bg_palettes:
            if not self._special_entry_applies(
                entry,
                map_info,
                weekday=weekday,
                events=events,
                overcast_index=overcast_index,
            ):
                continue
            palettes = self._palette_from_entry(entry, map_info, time_of_day)
            if palettes is not None:
                return palettes
        return None

    def _build_map_infos(self) -> dict[str, MapInfo]:
        maps: dict[str, MapInfo] = {}
        for label, header in self._map_table.items():
            tileset = header.tileset
            map_type = header.map_type
            constant_name = self._map_attributes.get(label, header.default_constant)
            constant_data = self._map_constants.get(constant_name)
            if constant_data is None:
                continue
            tileset_index = self._tileset_indices.get(tileset)
            if tileset_index is None:
                continue
            width, height, group, map_number = constant_data
            roof_constant = self.roof_constant(group)
            location = header.location
            location_index = self._landmark_indices.get(location)
            region = self._region_for_location(location_index)
            maps[label] = MapInfo(
                label=label,
                tileset=tileset,
                constant=constant_name,
                map_type=map_type,
                width=width,
                height=height,
                group=group,
                map_number=map_number,
                roof_constant=roof_constant,
                tileset_index=tileset_index,
                block_label=f"{label}_BlockData",
                location=location,
                location_index=location_index,
                palette_flags=set(header.palette_flags),
                region=region,
            )
        return maps

    def _build_tileset_resources(self) -> dict[str, TilesetResources]:
        resources: dict[str, TilesetResources] = {}
        for constant, label in self._constant_to_tileset_label.items():
            asset = self._tileset_assets.get(label, {})
            meta_path = asset.get("Meta")
            attr_path = asset.get("Attr")
            if not meta_path or not attr_path:
                continue
            metatiles_path = self._normalize_binary_path(meta_path)
            attributes_path = self._normalize_binary_path(attr_path)
            bank0_sources: List[GraphicsSource] = []
            gfx0_path = asset.get("GFX0")
            if gfx0_path:
                bank0_sources.append(self._resolve_graphics_source(gfx0_path))
            bank1_sources: List[GraphicsSource] = []
            for key in ("GFX1", "GFX2"):
                gfx_path = asset.get(key)
                if gfx_path:
                    bank1_sources.append(self._resolve_graphics_source(gfx_path))
            resources[constant] = TilesetResources(
                metatiles_path=metatiles_path,
                attributes_path=attributes_path,
                bank0_sources=bank0_sources,
                bank1_sources=bank1_sources,
            )
        return resources

    def _normalize_binary_path(self, raw_path: str) -> str:
        candidate = Path(raw_path)
        if candidate.suffix == ".lz":
            without_lz = candidate.with_suffix("")
            if (self.root / without_lz).exists():
                candidate = without_lz
        elif not (self.root / candidate).exists() and raw_path.endswith(".lz"):
            without_lz = Path(raw_path[:-3])
            if (self.root / without_lz).exists():
                candidate = without_lz
        if not (self.root / candidate).exists():
            raise FileNotFoundError(f"Asset not found: {candidate}")
        return candidate.as_posix()

    def _graphics_source_path(self, raw_path: str) -> str:
        candidates: List[str] = []
        if raw_path:
            candidates.append(raw_path)
        if raw_path.endswith(".lz"):
            candidates.append(raw_path[:-3])
        base = raw_path[:-3] if raw_path.endswith(".lz") else raw_path
        base = re.sub(r"\.2bpp(?:\.[^.]+)?$", "", base)
        candidates.extend(
            [
                f"{base}.2bpp",
                f"{base}.2bpp.lz",
                f"{base}.png",
            ]
        )
        seen: set[str] = set()
        for candidate in candidates:
            if candidate in seen:
                continue
            seen.add(candidate)
            if (self.root / candidate).exists():
                return candidate
        raise FileNotFoundError(f"Tileset graphics not found for base {raw_path}")

    @staticmethod
    def _parse_vram_slice(raw_path: str) -> Tuple[int, Optional[int]]:
        match = re.search(r"\.vram(\d+)(p?)", raw_path)
        if not match:
            return 0, None
        index = int(match.group(1))
        has_p = match.group(2) == "p"
        if has_p:
            if index == 0:
                return 0, 127
            offset = max(index * 128 - 1, 0)
            return offset, 128
        return index * 128, 128

    def _resolve_graphics_source(self, raw_path: str) -> GraphicsSource:
        resolved = self._graphics_source_path(raw_path)
        offset, length = self._parse_vram_slice(raw_path)
        is_png = resolved.lower().endswith(".png")
        needs_slice = is_png or (".vram" in raw_path and ".vram" not in resolved)
        tile_offset = offset if needs_slice else 0
        tile_length = length if needs_slice else None
        return GraphicsSource(path=resolved, is_png=is_png, tile_offset=tile_offset, tile_length=tile_length, needs_slice=needs_slice)


def _tileset_animation_entries(polished_path: Path) -> Dict[str, List[AnimationCommand]]:
    key = polished_path.resolve().as_posix()
    cached = _ANIMATION_TABLE_CACHE.get(key)
    if cached is not None:
        return cached
    path = polished_path / "engine/tilesets/tileset_anims.asm"
    raw_lines = path.read_text().splitlines()
    pointer_pattern = re.compile(r"([A-Za-z0-9_]+):\s+dw\s+vTiles2\s+tile\s+\$([0-9A-Fa-f]+)\s*,\s*([A-Za-z0-9_]+)")
    pointer_tiles: Dict[str, Tuple[int, str]] = {}
    for raw_line in raw_lines:
        pointer_line = raw_line.split(";", 1)[0].strip()
        if not pointer_line:
            continue
        pointer_match = pointer_pattern.match(pointer_line)
        if pointer_match:
            pointer_tiles[pointer_match.group(1)] = (int(pointer_match.group(2), 16), pointer_match.group(3))
    entries: Dict[str, List[AnimationCommand]] = {}
    current_labels: List[str] = []
    current_data: List[AnimationCommand] = []

    def flush() -> None:
        nonlocal current_labels, current_data
        if current_labels and current_data:
            data_copy = list(current_data)
            for label in current_labels:
                entries[label] = list(data_copy)
        current_labels = []
        current_data = []

    label_pattern = re.compile(r"([A-Za-z0-9_]+)::")
    tile_pattern = re.compile(r"vTiles2\s+tile\s+\$([0-9A-Fa-f]+)")

    for raw_line in raw_lines:
        line = raw_line.split(";", 1)[0].strip()
        if not line:
            continue
        label_match = label_pattern.match(line)
        if label_match:
            label_name = label_match.group(1)
            if current_data:
                flush()
            if label_name.endswith("Anim"):
                base_label = label_name[:-4]
                if base_label not in current_labels:
                    current_labels.append(base_label)
            else:
                if current_labels:
                    flush()
            continue
        if not current_labels or not line.startswith("dw "):
            continue
        parts = [part.strip() for part in line[3:].split(",")]
        if len(parts) < 2:
            continue
        location, function = parts[0], parts[1]
        tile_index: Optional[int] = None
        data_label: Optional[str] = None
        tile_match = tile_pattern.search(location)
        if tile_match:
            try:
                tile_index = int(tile_match.group(1), 16)
            except ValueError:
                tile_index = None
        else:
            pointer_entry = pointer_tiles.get(location)
            if pointer_entry is not None:
                tile_index, data_label = pointer_entry
        current_data.append(AnimationCommand(location=location, tile_index=tile_index, function=function, data_label=data_label))

    if current_labels and current_data:
        flush()

    _ANIMATION_TABLE_CACHE[key] = entries
    return entries


class LzDecompressor:
    """Minimal reader for the project's LZ-compressed assets."""

    def __init__(self, data: bytes):
        self._data = bytearray(data)
        self._address = 0
        self._output: bytearray = bytearray()

    def _peek(self) -> int:
        return self._data[self._address]

    def _next(self) -> int:
        value = self._data[self._address]
        self._address += 1
        return value

    def _read_offset(self) -> int:
        if self._peek() >= 0x80:
            delta = (self._next() & 0x7F)
            return len(self._output) - delta - 1
        high = self._next()
        low = self._next()
        return (high << 8) | low

    def _repeat(self, length: int, direction: int = 1, table: Sequence[int] | None = None) -> None:
        offset = self._read_offset()
        for i in range(length):
            value = self._output[offset + i * direction]
            if table is not None:
                value = table[value]
            self._output.append(value)

    def decompress(self) -> bytes:
        while True:
            first = self._peek()
            if first == _LZ_END:
                self._next()
                break
            command = (first & 0b11100000) >> 5
            if command == _LZ_COMMANDS["long"]:
                command = (first & 0b00011100) >> 2
                self._next()
                length = ((self._next() & 0b00000011) << 8) + self._next() + 1
            else:
                self._next()
                length = (first & 0b00011111) + 1
            if command == _LZ_COMMANDS["literal"]:
                end = self._address + length
                self._output.extend(self._data[self._address:end])
                self._address = end
            elif command == _LZ_COMMANDS["iterate"]:
                value = self._next()
                self._output.extend([value] * length)
            elif command == _LZ_COMMANDS["alternate"]:
                first_val = self._next()
                second_val = self._next()
                for i in range(length):
                    self._output.append(first_val if i % 2 == 0 else second_val)
            elif command == _LZ_COMMANDS["blank"]:
                self._output.extend([0] * length)
            elif command == _LZ_COMMANDS["repeat"]:
                self._repeat(length)
            elif command == _LZ_COMMANDS["flip"]:
                self._repeat(length, table=_BIT_FLIPPED)
            elif command == _LZ_COMMANDS["reverse"]:
                self._repeat(length, direction=-1)
            else:
                raise ValueError(f"Unsupported LZ command id {command} at offset {self._address}")
        return bytes(self._output)


def _chunk_bytes(data: bytes, size: int) -> List[List[int]]:
    if size <= 0:
        raise ValueError("chunk size must be positive")
    if len(data) % size:
        raise ValueError("data length is not a multiple of chunk size")
    return [list(data[i : i + size]) for i in range(0, len(data), size)]


def _decode_2bpp_tiles(data: bytes) -> List[List[int]]:
    if len(data) % 16:
        raise ValueError("2bpp data length must be a multiple of 16 bytes per tile")
    tiles: List[List[int]] = []
    for offset in range(0, len(data), 16):
        tile: List[int] = []
        for row in range(8):
            low = data[offset + row * 2]
            high = data[offset + row * 2 + 1]
            for bit in range(7, -1, -1):
                color = ((high >> bit) & 1) << 1 | ((low >> bit) & 1)
                tile.append(color)
        tiles.append(tile)
    return tiles


def _decode_tiles_from_png(image_path: Path, png_module) -> List[List[int]]:
    reader = png_module.Reader(filename=str(image_path))
    width, height, pixel_data, metadata = reader.read_flat()
    tiles_per_row = width // Tileset.TILE_SIZE
    stride = 1 if "palette" in metadata else metadata.get("planes", 1)
    if metadata.get("alpha"):
        stride += 1
    palette = metadata.get("palette")
    bitdepth = metadata.get("bitdepth", 8)
    raw_values: List[int] = []
    total_pixels = width * height
    for i in range(total_pixels):
        component = pixel_data[i * stride]
        if palette:
            component = palette[component][0]
        shade = 3 - (4 * component) // (2 ** bitdepth)
        raw_values.append(shade)
    tiles: List[List[int]] = []
    total_tiles = tiles_per_row * (height // Tileset.TILE_SIZE)
    for tile_index in range(total_tiles):
        ty, tx = divmod(tile_index, tiles_per_row)
        tile: List[int] = []
        for row in range(Tileset.TILE_SIZE):
            start = (
                ty * Tileset.TILE_SIZE * Tileset.TILE_SIZE * tiles_per_row
                + tx * Tileset.TILE_SIZE
                + row * Tileset.TILE_SIZE * tiles_per_row
            )
            tile.extend(raw_values[start : start + Tileset.TILE_SIZE])
        tiles.append(tile)
    return tiles


def _load_palette(pal_path: Path) -> List[List[RGB]]:
    channels: List[int] = []
    for raw_line in pal_path.read_text().splitlines():
        line = raw_line.split(";", 1)[0].strip()
        if not line.startswith("RGB "):
            continue
        values = [int(part.strip()) for part in line[4:].split(",")]
        channels.extend(values)
    colors: List[RGB] = []
    for i in range(0, len(channels), 3):
        r, g, b = channels[i : i + 3]
        colors.append((r * 8, g * 8, b * 8))
    return [colors[i : i + 4] for i in range(0, len(colors), 4)]


def _ensure_palette_rows(palette: List[List[RGB]], target: int = 7) -> None:
    if not palette:
        palette.extend([[_DEFAULT_RGB] * 4 for _ in range(target)])
        return
    while len(palette) < target:
        palette.append(list(palette[-1]))
    for index, row in enumerate(palette):
        if len(row) < 4:
            filler = row[-1] if row else _DEFAULT_RGB
            palette[index] = list(row) + [filler] * (4 - len(row))


def _apply_roof_color_override(palette: List[List[RGB]], override: Optional[Tuple[RGB, RGB]]) -> None:
    if override is None:
        return
    _ensure_palette_rows(palette)
    if len(palette) <= 6:
        return
    roof_palette = list(palette[6])
    if len(roof_palette) < 4:
        filler = roof_palette[-1] if roof_palette else _DEFAULT_RGB
        while len(roof_palette) < 4:
            roof_palette.append(filler)
    roof_palette[1] = override[0]
    roof_palette[2] = override[1]
    palette[6] = roof_palette


class Attributes:
    COLOR = 0x07
    BANK1 = 0x08
    XFLIP = 0x20
    YFLIP = 0x40

    def __init__(self, data: bytes, palette_source: Iterable[List[RGB]]):
        self.colors = list(palette_source)
        self.data = _chunk_bytes(data, 16)


class Tileset:
    TILE_SIZE = 8

    def __init__(
        self,
        bank0_tiles: Sequence[Sequence[int]],
        bank1_tiles: Sequence[Sequence[int]],
        attributes: Attributes,
    ) -> None:
        self._bank0 = [list(tile) for tile in bank0_tiles]
        self._bank1 = [list(tile) for tile in bank1_tiles]
        self._attributes = attributes

    def _tile_pixels(self, tiles: Sequence[Sequence[int]], index: int) -> List[int]:
        if not tiles or index >= len(tiles):
            return [0] * (self.TILE_SIZE * self.TILE_SIZE)
        return list(tiles[index])

    def tile(self, index: int, attr: int) -> List[RGB]:
        use_bank1 = bool(attr & Attributes.BANK1)
        tiles = self._bank1 if use_bank1 and self._bank1 else self._bank0
        tile_values = self._tile_pixels(tiles, index)
        color_set = self._attributes.colors[attr & Attributes.COLOR]
        rows: List[RGB] = []
        y_indices: Iterable[int] = range(self.TILE_SIZE)
        if attr & Attributes.YFLIP:
            y_indices = reversed(list(y_indices))
        for row in y_indices:
            start = row * self.TILE_SIZE
            slice_ = tile_values[start : start + self.TILE_SIZE]
            if attr & Attributes.XFLIP:
                slice_ = list(reversed(slice_))
            rows.extend(color_set[pixel] for pixel in slice_)
        return rows if rows else [_DEFAULT_RGB] * (self.TILE_SIZE * self.TILE_SIZE)


class MetatileSet:
    METATILE_DIM = 4

    def __init__(self, data: bytes, tileset: Tileset, attributes: Attributes):
        indices = _chunk_bytes(data, self.METATILE_DIM ** 2)
        self._tiles: List[List[List[RGB]]] = []
        for idx, index_set in enumerate(indices):
            attr_set = attributes.data[idx]
            metatile = [tileset.tile(tile_idx, attr) for tile_idx, attr in zip(index_set, attr_set)]
            self._tiles.append(metatile)

    def __getitem__(self, item: int) -> List[List[RGB]]:
        return self._tiles[item]


def _read_block_bytes(map_path: Path) -> bytes:
    candidates: List[Path] = []
    seen: Set[Path] = set()
    candidates.append(map_path)
    if map_path.suffix == ".lz":
        candidates.insert(0, map_path.with_suffix(""))
    else:
        candidates.append(map_path.with_suffix(map_path.suffix + ".lz"))
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        if not candidate.exists():
            continue
        data = candidate.read_bytes()
        if candidate.suffix == ".lz":
            data = LzDecompressor(data).decompress()
        return data
    raise FileNotFoundError("Missing any of: {}".format(", ".join(str(path) for path in candidates)))


def _read_asset_bytes(path: Path) -> bytes:
    data = path.read_bytes()
    if path.suffix == ".lz":
        data = LzDecompressor(data).decompress()
    return data


def _load_tileset_bank(polished_path: Path, sources: Sequence[GraphicsSource], png_module) -> List[List[int]]:
    tiles: List[List[int]] = []
    png_cache: Dict[str, List[List[int]]] = {}
    data_cache: Dict[str, List[List[int]]] = {}
    for source in sources:
        asset_path = polished_path / source.path
        if source.is_png:
            cached = png_cache.get(source.path)
            if cached is None:
                cached = _decode_tiles_from_png(asset_path, png_module)
                png_cache[source.path] = cached
            tiles_segment = cached
        else:
            cached = data_cache.get(source.path)
            if cached is None:
                data = _read_asset_bytes(asset_path)
                cached = _decode_2bpp_tiles(data)
                data_cache[source.path] = cached
            tiles_segment = cached
        if source.needs_slice:
            start = min(source.tile_offset, len(tiles_segment))
            end = len(tiles_segment) if source.tile_length is None else min(start + source.tile_length, len(tiles_segment))
            tiles.extend(tiles_segment[start:end])
        else:
            tiles.extend(tiles_segment)
    return tiles


def _load_roof_tiles(polished_path: Path, roof_constant: str, png_module) -> List[List[int]]:
    relative = _ROOF_GFX.get(roof_constant)
    if relative is None:
        raise KeyError(f"No roof graphics defined for {roof_constant}")
    base_path = polished_path / relative
    for suffix in (".2bpp.lz", ".2bpp"):
        candidate = base_path.with_suffix(suffix)
        if candidate.exists():
            data = _read_asset_bytes(candidate)
            tiles = _decode_2bpp_tiles(data)
            break
    else:
        png_path = base_path.with_suffix(".png")
        if not png_path.exists():
            raise FileNotFoundError(f"Roof graphics not found for {roof_constant} ({base_path})")
        tiles = _decode_tiles_from_png(png_path, png_module)
    if len(tiles) < _ROOF_TILE_COUNT:
        raise ValueError(f"Expected at least {_ROOF_TILE_COUNT} tiles for {roof_constant}, found {len(tiles)}")
    return tiles[:_ROOF_TILE_COUNT]


def _apply_roof_tiles(bank0_tiles: List[List[int]], roof_tiles: Sequence[Sequence[int]]) -> None:
    blank_tile = [0] * (Tileset.TILE_SIZE * Tileset.TILE_SIZE)
    while len(bank0_tiles) < _ROOF_TILE_OFFSET:
        bank0_tiles.append(list(blank_tile))
    for offset, tile in enumerate(roof_tiles):
        index = _ROOF_TILE_OFFSET + offset
        tile_data = list(tile)
        if index < len(bank0_tiles):
            bank0_tiles[index] = tile_data
        else:
            bank0_tiles.append(tile_data)


def _decode_animation_tiles(polished_path: Path, sources: Sequence[str], png_module) -> List[List[int]]:
    frames: List[List[int]] = []
    for relative in sources:
        asset_path = polished_path / relative
        if asset_path.suffix == ".png":
            frames.extend(_decode_tiles_from_png(asset_path, png_module))
        else:
            data = _read_asset_bytes(asset_path)
            frames.extend(_decode_2bpp_tiles(data))
    return frames


def _merge_animation_specs(data_spec: Optional[AnimationSpec], func_spec: Optional[AnimationSpec]) -> Optional[AnimationSpec]:
    if data_spec is None and func_spec is None:
        return None
    sources: Tuple[str, ...] = ()
    for candidate in (data_spec, func_spec):
        if candidate and candidate.sources:
            sources = candidate.sources
            break
    if not sources:
        return None
    repeat_each = 1
    if data_spec is not None:
        repeat_each = data_spec.repeat_each
    if func_spec is not None and (data_spec is None or data_spec.repeat_each == 1):
        repeat_each = func_spec.repeat_each
    sequence: Optional[Tuple[int, ...]] = None
    if data_spec is not None and data_spec.sequence is not None:
        sequence = data_spec.sequence
    elif func_spec is not None:
        sequence = func_spec.sequence
    tile_index: Optional[int] = None
    if data_spec is not None and data_spec.tile_index is not None:
        tile_index = data_spec.tile_index
    elif func_spec is not None:
        tile_index = func_spec.tile_index
    return AnimationSpec(sources, repeat_each, sequence, tile_index)


def _repeat_sequence(frame_count: int, repeat_each: int) -> List[int]:
    if frame_count <= 0:
        return []
    cycle = frame_count * max(repeat_each, 1)
    sequence: List[int] = []
    for tick in range(cycle):
        sequence.append((tick // max(repeat_each, 1)) % frame_count)
    return sequence


def _johto_traditional_animations(polished_path: Path, png_module) -> List[TileAnimation]:
    animations: List[TileAnimation] = []
    water_frames = _decode_animation_tiles(polished_path, ["gfx/tilesets/water/johto_water.png"], png_module)
    if water_frames:
        animations.append(TileAnimation(tile_index=0x14, frames=water_frames, sequence=_repeat_sequence(len(water_frames), 2)))
    rain_puddle_frames = _decode_animation_tiles(polished_path, ["gfx/tilesets/rain/rain_puddle.png"], png_module)
    if rain_puddle_frames:
        animations.append(TileAnimation(tile_index=0x1C, frames=rain_puddle_frames, sequence=_repeat_sequence(len(rain_puddle_frames), 1)))
    rain_water_frames = _decode_animation_tiles(polished_path, ["gfx/tilesets/rain/rain_water.png"], png_module)
    if rain_water_frames:
        animations.append(TileAnimation(tile_index=0x1D, frames=rain_water_frames, sequence=_repeat_sequence(len(rain_water_frames), 1)))
    flower_frames = _decode_animation_tiles(
        polished_path,
        [
            "gfx/tilesets/flower/1.png",
            "gfx/tilesets/flower/2.png",
        ],
        png_module,
    )
    if flower_frames:
        animations.append(TileAnimation(tile_index=0x03, frames=flower_frames, sequence=_repeat_sequence(len(flower_frames), 2)))
    return animations


def _load_tileset_animations(
    polished_path: Path,
    renderer: RendererData,
    png_module,
) -> List[TileAnimation]:
    tileset_label = renderer.tileset_label
    entries = _tileset_animation_entries(polished_path).get(tileset_label)
    if not entries:
        if renderer.tileset_key == "TILESET_JOHTO_TRADITIONAL":
            return _johto_traditional_animations(polished_path, png_module)
        return []
    animations_by_tile: Dict[int, TileAnimation] = {}
    frames_cache: Dict[Tuple[str, ...], List[List[int]]] = {}
    for command in entries:
        tile_index = command.tile_index
        data_label = command.data_label
        data_spec = _ANIMATION_DATA_SPECS.get(data_label) if data_label else None
        func_spec = _ANIMATION_SPECS.get(command.function)
        spec = _merge_animation_specs(data_spec, func_spec)
        if spec is None:
            continue
        if tile_index is None and spec.tile_index is not None:
            tile_index = spec.tile_index
        if tile_index is None:
            continue
        frames = frames_cache.get(spec.sources)
        if frames is None:
            frames = _decode_animation_tiles(polished_path, list(spec.sources), png_module)
            frames_cache[spec.sources] = frames
        if not frames:
            continue
        if spec.sequence is not None:
            sequence = list(spec.sequence)
        else:
            sequence = _repeat_sequence(len(frames), spec.repeat_each)
        if not sequence:
            continue
        animations_by_tile[tile_index] = TileAnimation(tile_index=tile_index, frames=frames, sequence=sequence)
    simulated = _simulate_scroll_commands(entries, renderer)
    for tile_index, frames in simulated.items():
        if len(frames) <= 1:
            continue
        if tile_index in animations_by_tile:
            continue
        sequence = _repeat_sequence(len(frames), 1)
        if not sequence:
            continue
        animations_by_tile[tile_index] = TileAnimation(tile_index=tile_index, frames=frames, sequence=sequence)
    if animations_by_tile:
        return [animations_by_tile[index] for index in sorted(animations_by_tile)]
    if renderer.tileset_key == "TILESET_JOHTO_TRADITIONAL":
        return _johto_traditional_animations(polished_path, png_module)
    return []


def _animation_period(animations: Sequence[TileAnimation]) -> int:
    period = 1
    for animation in animations:
        if not animation.sequence:
            continue
        period = math.lcm(period, len(animation.sequence))
    return max(period, 1)


def _simulate_scroll_commands(commands: Sequence[AnimationCommand], renderer: RendererData) -> Dict[int, List[List[int]]]:
    supported = {
        "WriteTileToBuffer",
        "ReadTileFromBuffer",
        "ScrollTileDown",
        "ScrollTileUp",
        "ScrollTileLeft",
        "ScrollTileRight",
        "ScrollTileRightLeft",
    }
    tracked: Set[int] = set()
    for command in commands:
        if command.function in supported and command.tile_index is not None:
            tracked.add(command.tile_index)
    if not tracked:
        return {}
    base_tiles = [list(tile) for tile in renderer.bank0_tiles]
    tile_state: Dict[int, List[int]] = {}

    def ensure_tile(index: int) -> List[int]:
        tile = tile_state.get(index)
        if tile is not None:
            return tile
        if index < len(base_tiles):
            tile = list(base_tiles[index])
        else:
            tile = [0] * (Tileset.TILE_SIZE * Tileset.TILE_SIZE)
        tile_state[index] = tile
        return tile

    for index in tracked:
        ensure_tile(index)

    buffer_tile: List[int] = [0] * (Tileset.TILE_SIZE * Tileset.TILE_SIZE)
    frames: Dict[int, List[List[int]]] = {index: [list(tile_state[index])] for index in tracked}
    initial_snapshot = {index: tuple(tile_state[index]) for index in tracked}
    max_frames = 16
    for frame_index in range(max_frames):
        for command in commands:
            function = command.function
            if function not in supported:
                continue
            if function == "WriteTileToBuffer":
                if command.tile_index is None:
                    continue
                buffer_tile = list(ensure_tile(command.tile_index))
            elif function == "ReadTileFromBuffer":
                if command.tile_index is None:
                    continue
                target = ensure_tile(command.tile_index)
                target[:] = list(buffer_tile)
            elif function == "ScrollTileRightLeft":
                direction = "ScrollTileRight" if (frame_index % 8) < 4 else "ScrollTileLeft"
                if command.location == "wTileAnimBuffer":
                    buffer_tile = _scroll_tile_values(buffer_tile, direction)
                elif command.tile_index is not None:
                    target = ensure_tile(command.tile_index)
                    target[:] = _scroll_tile_values(target, direction)
            else:
                if command.location == "wTileAnimBuffer":
                    buffer_tile = _scroll_tile_values(buffer_tile, function)
                elif command.tile_index is not None:
                    target = ensure_tile(command.tile_index)
                    target[:] = _scroll_tile_values(target, function)
        snapshot = {index: tuple(tile_state[index]) for index in tracked}
        for index in tracked:
            frames[index].append(list(tile_state[index]))
        if snapshot == initial_snapshot:
            for index in tracked:
                frames[index].pop()
            break
    return frames


def _scroll_tile_values(tile: Sequence[int], function: str) -> List[int]:
    size = Tileset.TILE_SIZE
    if len(tile) != size * size:
        return list(tile)
    rows = [list(tile[row * size : (row + 1) * size]) for row in range(size)]
    if function == "ScrollTileDown":
        shifted = [rows[(row - 1) % size] for row in range(size)]
    elif function == "ScrollTileUp":
        shifted = [rows[(row + 1) % size] for row in range(size)]
    elif function == "ScrollTileLeft":
        shifted = [row[1:] + [row[0]] for row in rows]
    elif function == "ScrollTileRight":
        shifted = [[row[-1]] + row[:-1] for row in rows]
    else:
        shifted = rows
    return [value for row in shifted for value in row]


def _apply_tile_animations(base_tiles: Sequence[Sequence[int]], animations: Sequence[TileAnimation], timer: int) -> List[List[int]]:
    tiles = [list(tile) for tile in base_tiles]
    blank_tile = [0] * (Tileset.TILE_SIZE * Tileset.TILE_SIZE)
    for animation in animations:
        if not animation.frames or not animation.sequence:
            continue
        frame_index = animation.sequence[timer % len(animation.sequence)]
        frame_index %= len(animation.frames)
        while len(tiles) <= animation.tile_index:
            tiles.append(list(blank_tile))
        tiles[animation.tile_index] = list(animation.frames[frame_index])
    return tiles


def _render_map(block_indices: Sequence[int], width: int, height: int, metatiles: MetatileSet) -> Tuple[int, int, List[List[int]]]:
    tiles_per_metatile = MetatileSet.METATILE_DIM
    tile_size = Tileset.TILE_SIZE
    block_px = tiles_per_metatile * tile_size
    overall_width = width * block_px
    rows: List[List[int]] = []
    for block_row in range(height):
        for pixel_row in range(block_px):
            row: List[int] = []
            tile_row = pixel_row // tile_size
            within_tile_row = pixel_row % tile_size
            for block_col in range(width):
                block_index = block_indices[block_row * width + block_col]
                metatile = metatiles[block_index]
                for tile_col in range(tiles_per_metatile):
                    tile_index = tile_row * tiles_per_metatile + tile_col
                    tile_pixels = metatile[tile_index]
                    start = within_tile_row * tile_size
                    for rgb in tile_pixels[start : start + tile_size]:
                        row.extend(rgb)
            expected_row_len = overall_width * 3
            if len(row) != expected_row_len:
                raise ValueError(
                    "row {row_index} (block_row {block_row}, local_row {pixel_row}) has length {actual} "
                    "(expected {expected})".format(
                        row_index=len(rows),
                        block_row=block_row,
                        pixel_row=pixel_row,
                        actual=len(row),
                        expected=expected_row_len,
                    )
                )
            rows.append(row)
    overall_height = len(rows)
    return overall_width, overall_height, rows


def _write_png(path: Path, width: int, height: int, rows: List[List[int]], png_module) -> None:
    with path.open("wb") as handle:
        writer = png_module.Writer(width, height, greyscale=False)
        writer.write(handle, rows)


def _render_with_tiles(renderer: RendererData, bank0_tiles: Sequence[Sequence[int]], bank1_tiles: Sequence[Sequence[int]]) -> Tuple[int, int, List[List[int]]]:
    tileset = Tileset(bank0_tiles, bank1_tiles, renderer.attributes)
    metatiles = MetatileSet(renderer.metatile_data, tileset, renderer.attributes)
    return _render_map(renderer.block_indices, renderer.width, renderer.height, metatiles)


def _write_gif(path: Path, frames: Sequence[Tuple[int, int, List[List[int]]]], duration_ms: int) -> None:
    try:
        from PIL import Image  # type: ignore[import]
    except ImportError as exc:  # pragma: no cover - optional dependency guard
        raise RuntimeError("Animated GIF output requires Pillow (pip install pillow)") from exc
    if not frames:
        raise ValueError("No frames available to write GIF")
    images: List["Image.Image"] = []
    for width, height, rows in frames:
        flat = bytes(value for row in rows for value in row)
        images.append(Image.frombytes("RGB", (width, height), flat))
    first, *rest = images
    first.save(path, format="GIF", save_all=True, append_images=rest, duration=duration_ms, loop=0, disposal=2)


def _compose_sprite_sheet(
    frames: Sequence[Tuple[int, int, List[List[int]]]],
    max_sheet_dimension: Optional[int] = None,
) -> Tuple[int, int, List[List[int]], int]:
    if not frames:
        raise ValueError("No frames available to compose sprite sheet")
    base_width, base_height, first_rows = frames[0]
    if base_width <= 0 or base_height <= 0:
        raise ValueError("Frame dimensions must be positive")
    if len(first_rows) != base_height:
        raise ValueError("Frame row count does not match declared height")
    for width, height, rows in frames[1:]:
        if width != base_width or height != base_height:
            raise ValueError("All frames must share the same dimensions")
        if len(rows) != base_height:
            raise ValueError("Frame row count does not match declared height")
    columns = len(frames)
    if max_sheet_dimension is not None and max_sheet_dimension > 0:
        max_columns = max(1, max_sheet_dimension // base_width)
        candidate_columns = min(len(frames), max_columns)
        chosen_columns = candidate_columns
        if base_height * math.ceil(len(frames) / chosen_columns) > max_sheet_dimension:
            for possible in range(candidate_columns, 0, -1):
                if base_width * possible > max_sheet_dimension:
                    continue
                rows_needed = math.ceil(len(frames) / possible)
                if base_height * rows_needed <= max_sheet_dimension:
                    chosen_columns = possible
                    break
        columns = max(1, min(len(frames), chosen_columns))

    rows_needed = math.ceil(len(frames) / columns)
    sheet_width = base_width * columns
    sheet_height = base_height * rows_needed
    sheet_rows: List[List[int]] = []
    blank_segment = [0] * len(first_rows[0])
    for row_index in range(rows_needed):
        for tile_row in range(base_height):
            combined_row: List[int] = []
            for column_index in range(columns):
                frame_index = row_index * columns + column_index
                if frame_index < len(frames):
                    combined_row.extend(frames[frame_index][2][tile_row])
                else:
                    combined_row.extend(blank_segment)
            sheet_rows.append(combined_row)
    return sheet_width, sheet_height, sheet_rows, columns


def _write_animation_sheet(
    metadata_path: Path,
    image_path: Path,
    frames: Sequence[Tuple[int, int, List[List[int]]]],
    frame_durations_ms: Sequence[int],
    png_module,
) -> None:
    if not frames:
        raise ValueError("No frames provided for animation sheet")
    if len(frame_durations_ms) != len(frames):
        raise ValueError("Frame duration list must match frame count")
    sheet_width, sheet_height, sheet_rows, sheet_columns = _compose_sprite_sheet(
        frames, _MAX_SPRITE_SHEET_DIMENSION
    )
    image_path.parent.mkdir(parents=True, exist_ok=True)
    _write_png(image_path, sheet_width, sheet_height, sheet_rows, png_module)
    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    image_reference: str
    try:
        image_reference = os.path.relpath(image_path, metadata_path.parent)
    except ValueError:
        image_reference = image_path.as_posix()
    payload = {
        "version": 1,
        "image": image_reference.replace("\\", "/"),
        "frameWidth": frames[0][0],
        "frameHeight": frames[0][1],
        "frameCount": len(frames),
        "frameDurationsMs": list(frame_durations_ms),
        "loopDurationMs": sum(frame_durations_ms),
        "sheetColumns": sheet_columns,
    }
    with metadata_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")


def _map_block_indices(data: bytes, width: int, height: int) -> List[int]:
    expected = width * height
    if len(data) != expected:
        raise ValueError(f"Expected {expected} blocks, found {len(data)}")
    return list(data)


def _build_renderer(
    png_module,
    polished_path: Path,
    repo_index: RepositoryIndex,
    map_label: str,
    *,
    weekday: Optional[int] = None,
    time_of_day: int = 1,
    events: Optional[Set[str]] = None,
) -> RendererData:
    map_info = repo_index.map_info(map_label)
    tileset_resources = repo_index.tileset_resources(map_info.tileset)
    block_asset = repo_index.block_asset(map_info.block_label)
    if block_asset:
        blocks_path = polished_path / Path(block_asset)
    else:
        blocks_path = polished_path / "maps" / f"{map_info.label}.ablk"
    block_bytes = _read_block_bytes(blocks_path)
    block_indices = _map_block_indices(block_bytes, map_info.width, map_info.height)
    allows_roof_palette = map_info.map_type in {"TOWN", "ROUTE", "ISOLATED"}
    overcast_index = repo_index.get_overcast_index(map_info, weekday=weekday, events=events)
    special_palette = repo_index.special_background_palette(
        map_info,
        time_of_day,
        weekday=weekday,
        events=events,
    )
    if special_palette is not None:
        palette = special_palette
    else:
        palette = repo_index.environment_palette(map_info, time_of_day)
    _ensure_palette_rows(palette)
    if (
        allows_roof_palette
        and map_info.tileset != "TILESET_SNOWTOP_MOUNTAIN"
    ):
        if overcast_index is not None:
            roof_override = repo_index.overcast_roof_palette(overcast_index, time_of_day=time_of_day)
        else:
            roof_override = repo_index.roof_palette(map_info.group, time_of_day=time_of_day)
        _apply_roof_color_override(palette, roof_override)
    attributes_data = _read_asset_bytes(polished_path / tileset_resources.attributes_path)
    attributes = Attributes(attributes_data, palette)
    bank0_tiles = _load_tileset_bank(polished_path, tileset_resources.bank0_sources, png_module)
    if (
        map_info.roof_constant
        and allows_roof_palette
        and map_info.tileset_index < repo_index.no_roof_tileset_threshold
    ):
        roof_tiles = _load_roof_tiles(polished_path, map_info.roof_constant, png_module)
        _apply_roof_tiles(bank0_tiles, roof_tiles)
    bank1_tiles = _load_tileset_bank(polished_path, tileset_resources.bank1_sources, png_module)
    metatile_data = _read_asset_bytes(polished_path / tileset_resources.metatiles_path)
    tileset_label = repo_index.tileset_label(map_info.tileset) or map_info.tileset
    return RendererData(
        block_indices=block_indices,
        width=map_info.width,
        height=map_info.height,
        attributes=attributes,
        metatile_data=metatile_data,
        bank0_tiles=[list(tile) for tile in bank0_tiles],
        bank1_tiles=[list(tile) for tile in bank1_tiles],
        tileset_key=map_info.tileset,
        tileset_label=tileset_label,
        map_label=map_info.label,
    )


def _parse_weekday_argument(value: str) -> int:
    text = str(value).strip()
    if not text:
        raise argparse.ArgumentTypeError("Weekday value cannot be empty.")
    lowered = text.lower()
    if lowered in _WEEKDAY_NAME_TO_VALUE:
        return _WEEKDAY_NAME_TO_VALUE[lowered]
    try:
        numeric = int(text, 0)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "Weekday must be a number 0-6 or a weekday name (e.g., Monday)."
        ) from exc
    return numeric % 7


def _parse_time_of_day_argument(value: str) -> int:
    text = str(value).strip()
    if not text:
        raise argparse.ArgumentTypeError("Time of day value cannot be empty.")
    lowered = text.lower()
    if lowered in _TIME_OF_DAY_NAME_TO_VALUE:
        return _TIME_OF_DAY_NAME_TO_VALUE[lowered]
    try:
        numeric = int(text, 0)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(
            "Time of day must be 0 (morn), 1 (day), 2 (nite), or 3 (eve)."
        ) from exc
    if numeric < 0 or numeric > 3:
        raise argparse.ArgumentTypeError(
            "Time of day must be within 0-3 or a named value (morn/day/nite/eve)."
        )
    return numeric


def _parse_bool_flag(value: str) -> bool:
    normalized = str(value).strip().lower()
    truthy = {"1", "true", "t", "yes", "y", "on"}
    falsy = {"0", "false", "f", "no", "n", "off"}
    if normalized in truthy:
        return True
    if normalized in falsy:
        return False
    raise argparse.ArgumentTypeError(
        "Expected a boolean value (on/off, true/false, yes/no, 1/0)."
    )


def _parse_event_override(value: str) -> Tuple[str, bool]:
    raw = str(value).strip()
    if not raw:
        raise argparse.ArgumentTypeError("Event override cannot be empty.")
    if "=" in raw:
        name, state_text = raw.split("=", 1)
    else:
        name, state_text = raw, "on"
    name = name.strip()
    if not name:
        raise argparse.ArgumentTypeError("Event flag name cannot be empty.")
    state = _parse_bool_flag(state_text)
    return name.upper(), state


def parse_args() -> argparse.Namespace:
    default_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Render a polishedcrystal overworld map to PNG or GIF.")
    parser.add_argument(
        "map",
        nargs="?",
        default="NewBarkTown",
        help="Map label as defined in data/maps/maps.asm (e.g. NewBarkTown).",
    )
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=default_root / "external/polishedcrystal",
        help="Path to the polishedcrystal repository clone.",
    )
    parser.add_argument(
        "--weekday",
        type=_parse_weekday_argument,
        default=1,
        help="Game weekday (0=Sunday ... 6=Saturday). Accepts names like Monday. Defaults to Monday.",
    )
    parser.add_argument(
        "--time-of-day",
        type=_parse_time_of_day_argument,
        default=1,
        help="Time of day palette: 0/morn, 1/day, 2/nite, 3/eve. Defaults to day.",
    )
    parser.add_argument(
        "--event",
        dest="event_overrides",
        action="append",
        type=_parse_event_override,
        metavar="FLAG[=STATE]",
        help=(
            "Override an event flag state (e.g., EVENT_GOLDENROD_CITY_ROCKET_TAKEOVER=off). "
            "Repeat to adjust multiple flags. Defaults mirror a new game."
        ),
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=None,
        help=(
            "Destination path for the generated asset. Defaults to <map>.animation.json when using the default "
            "sheet format, <map>.gif for GIFs, or <map>.png for static images."
        ),
    )
    parser.add_argument(
        "--format",
        choices=("sheet", "gif", "png"),
        default="sheet",
        help="Select output format: sprite sheet metadata (sheet), animated GIF (gif), or static PNG (png).",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    polished_path = args.polishedcrystal.resolve()
    if not polished_path.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {polished_path}")
    sys.path.insert(0, str(polished_path / "utils"))
    import png  # type: ignore

    repo_index = RepositoryIndex(polished_path)
    map_label = args.map
    weekday = args.weekday
    time_of_day = args.time_of_day
    events: Set[str] = repo_index.initial_event_flags
    if args.event_overrides:
        for flag_name, state in args.event_overrides:
            if state:
                events.add(flag_name)
            else:
                events.discard(flag_name)
    try:
        renderer = _build_renderer(
            png,
            polished_path,
            repo_index,
            map_label,
            weekday=weekday,
            time_of_day=time_of_day,
            events=events,
        )
    except KeyError as exc:
        raise SystemExit(str(exc))
    animations = _load_tileset_animations(polished_path, renderer, png)
    format_choice = args.format
    repo_root = Path(__file__).resolve().parent.parent
    base_output_dir = repo_root / "maps" / "day" / "animated"
    if format_choice == "gif":
        default_output = base_output_dir / f"{renderer.map_label}.gif"
    elif format_choice == "png":
        default_output = base_output_dir / f"{renderer.map_label}.png"
    else:
        default_output = base_output_dir / f"{renderer.map_label}.animation.json"
    output_target = (args.output or default_output).resolve()

    if format_choice == "gif":
        output_target.parent.mkdir(parents=True, exist_ok=True)
        period = _animation_period(animations)
        frames: List[Tuple[int, int, List[List[int]]]] = []
        for timer in range(period):
            animated_tiles = _apply_tile_animations(renderer.bank0_tiles, animations, timer)
            frames.append(_render_with_tiles(renderer, animated_tiles, renderer.bank1_tiles))
        _write_gif(output_target, frames, _GIF_FRAME_DURATION_MS)
        print(f"Wrote {output_target}")
        return

    if format_choice == "png":
        output_path = output_target
        if output_path.suffix.lower() not in {".png", ""}:
            output_path = output_path.with_suffix(".png")
        if output_path.is_dir():
            output_path = output_path / f"{renderer.map_label}.png"
        output_path.parent.mkdir(parents=True, exist_ok=True)
        width, height, rows = _render_with_tiles(renderer, renderer.bank0_tiles, renderer.bank1_tiles)
        _write_png(output_path, width, height, rows, png)
        print(f"Wrote {output_path}")
        return

    # Default: sprite sheet metadata output
    metadata_path = output_target
    if metadata_path.exists() and metadata_path.is_dir():
        metadata_path = metadata_path / f"{renderer.map_label}.animation.json"
    elif metadata_path.suffix.lower() != ".json":
        metadata_path = metadata_path.with_suffix(".json")
    image_path = metadata_path.with_suffix(".png")
    period = _animation_period(animations)
    frames: List[Tuple[int, int, List[List[int]]]] = []
    for timer in range(period):
        animated_tiles = _apply_tile_animations(renderer.bank0_tiles, animations, timer)
        frames.append(_render_with_tiles(renderer, animated_tiles, renderer.bank1_tiles))
    if not frames:
        width, height, rows = _render_with_tiles(renderer, renderer.bank0_tiles, renderer.bank1_tiles)
        frames.append((width, height, rows))
    frame_durations = [_ANIMATION_FRAME_DURATION_MS for _ in frames]
    _write_animation_sheet(metadata_path, image_path, frames, frame_durations, png)
    print(f"Wrote {metadata_path} and {image_path}")


if __name__ == "__main__":
    main()
