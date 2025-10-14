#!/usr/bin/env python3
"""Generate a PNG render (or animated GIF) of any polishedcrystal overworld map.

The script understands the repo's VRAM banking scheme, metatile format, and
LZ-compressed map blocks so it can source the same assets used by the game.
"""

from __future__ import annotations

import argparse
import math
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


@dataclass(frozen=True)
class AnimationCommand:
    location: str
    tile_index: Optional[int]
    function: str
    data_label: Optional[str]


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
    ),
}

_ANIMATION_DATA_SPECS: Dict[str, AnimationSpec] = {
    "WhirlpoolTiles1": AnimationSpec(("gfx/tilesets/whirlpool/1.png",), repeat_each=1),
    "WhirlpoolTiles2": AnimationSpec(("gfx/tilesets/whirlpool/2.png",), repeat_each=1),
    "WhirlpoolTiles3": AnimationSpec(("gfx/tilesets/whirlpool/3.png",), repeat_each=1),
    "WhirlpoolTiles4": AnimationSpec(("gfx/tilesets/whirlpool/4.png",), repeat_each=1),
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
    roof_constant: Optional[str]
    tileset_index: int


@dataclass
class TilesetResources:
    metatiles_path: str
    attributes_path: str
    bank0_sources: List[GraphicsSource]
    bank1_sources: List[GraphicsSource]


class RepositoryIndex:
    def __init__(self, root: Path) -> None:
        self.root = root
        self._map_constants = self._parse_map_constants()
        self._map_roofs = self._parse_map_roofs()
        self._roof_palettes = self._parse_roof_palettes()
        self._map_table = self._parse_map_table()
        self._map_attributes = self._parse_map_attributes()
        (
            self._tileset_constants,
            self._tileset_indices,
            self._no_roof_tilesets,
        ) = self._parse_tileset_constants()
        self._tileset_labels = self._parse_tileset_table()
        self._tileset_assets = self._parse_tileset_assets()
        self._constant_to_tileset_label = {
            constant: label
            for constant, label in zip(self._tileset_constants, self._tileset_labels)
        }
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

    @property
    def no_roof_tileset_threshold(self) -> int:
        return self._no_roof_tilesets

    def roof_palette(self, group: int) -> Optional[Tuple[RGB, RGB]]:
        if 0 <= group < len(self._roof_palettes):
            return self._roof_palettes[group]
        return None

    def roof_constant(self, group: int) -> Optional[str]:
        if 0 <= group < len(self._map_roofs):
            return self._map_roofs[group]
        return None

    def _parse_map_table(self) -> dict[str, Tuple[str, str, str]]:
        path = self.root / "data/maps/maps.asm"
        mapping: dict[str, Tuple[str, str, str]] = {}
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
            constant = parts[4]
            mapping[label] = (tileset, map_type, constant)
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

    def _parse_map_constants(self) -> dict[str, Tuple[int, int, int]]:
        path = self.root / "constants/map_constants.asm"
        constants: dict[str, Tuple[int, int, int]] = {}
        group = 0
        for raw_line in path.read_text().splitlines():
            line = raw_line.split(";", 1)[0].strip()
            if not line:
                continue
            if line.startswith("newgroup"):
                group += 1
                continue
            if line.startswith("map_const"):
                try:
                    _, rest = line.split(None, 1)
                except ValueError:
                    continue
                name_part, dimensions = rest.split(",", 1)
                name = name_part.strip()
                width_str, height_str = dimensions.split(",", 1)
                width = int(width_str.strip())
                height = int(height_str.strip())
                constants[name] = (width, height, group)
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

    def _parse_roof_palettes(self) -> List[Optional[Tuple[RGB, RGB]]]:
        path = self.root / "gfx/tilesets/roofs.pal"
        palettes: List[Optional[Tuple[RGB, RGB]]] = []
        for raw_line in path.read_text().splitlines():
            stripped = raw_line.strip()
            if stripped.startswith("else"):
                break
            line = raw_line.split(";", 1)[0].strip()
            if not line.startswith("RGB"):
                continue
            numbers = [int(value) for value in re.findall(r"\d+", line)]
            if len(numbers) < 6:
                palettes.append(None)
                continue
            color1 = tuple(component * 8 for component in numbers[:3])
            color2 = tuple(component * 8 for component in numbers[3:6])
            palettes.append((color1, color2))
        return palettes

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

    def _build_map_infos(self) -> dict[str, MapInfo]:
        maps: dict[str, MapInfo] = {}
        for label, (tileset, map_type, constant) in self._map_table.items():
            constant_name = self._map_attributes.get(label, constant)
            constant_data = self._map_constants.get(constant_name)
            if constant_data is None:
                continue
            tileset_index = self._tileset_indices.get(tileset)
            if tileset_index is None:
                continue
            width, height, group = constant_data
            roof_constant = self.roof_constant(group)
            maps[label] = MapInfo(
                label=label,
                tileset=tileset,
                constant=constant_name,
                map_type=map_type,
                width=width,
                height=height,
                group=group,
                roof_constant=roof_constant,
                tileset_index=tileset_index,
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


def _day_palette(base_path: Path, roof_override: Optional[Tuple[RGB, RGB]] = None) -> List[List[RGB]]:
    palettes = _load_palette(base_path / "gfx/tilesets/bg_tiles.pal")
    selected = palettes[8:11] + [palettes[0x29]] + palettes[12:16]
    result: List[List[RGB]] = [list(palette) for palette in selected]
    if roof_override is not None and len(result) > 6:
        roof_palette = list(result[6])
        roof_palette[1] = roof_override[0]
        roof_palette[2] = roof_override[1]
        result[6] = roof_palette
    return result


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

    
# (Remaining content identical to original script continues...)
