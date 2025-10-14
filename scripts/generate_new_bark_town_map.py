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
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

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
    "AnimateWhirlpoolTile": AnimationSpec(
        (
            "gfx/tilesets/whirlpool/1.png",
            "gfx/tilesets/whirlpool/2.png",
            "gfx/tilesets/whirlpool/3.png",
            "gfx/tilesets/whirlpool/4.png",
        ),
        repeat_each=1,
    ),
}

_ANIMATION_TABLE_CACHE: Dict[str, Dict[str, List[Tuple[int, str]]]] = {}


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


def _tileset_animation_entries(polished_path: Path) -> Dict[str, List[Tuple[int, str]]]:
    key = polished_path.resolve().as_posix()
    cached = _ANIMATION_TABLE_CACHE.get(key)
    if cached is not None:
        return cached
    path = polished_path / "engine/tilesets/tileset_anims.asm"
    raw_lines = path.read_text().splitlines()
    pointer_pattern = re.compile(r"([A-Za-z0-9_]+):\s+dw\s+vTiles2\s+tile\s+\$([0-9A-Fa-f]+)")
    pointer_tiles: Dict[str, int] = {}
    for raw_line in raw_lines:
        pointer_line = raw_line.split(";", 1)[0].strip()
        if not pointer_line:
            continue
        pointer_match = pointer_pattern.match(pointer_line)
        if pointer_match:
            pointer_tiles[pointer_match.group(1)] = int(pointer_match.group(2), 16)
    entries: Dict[str, List[Tuple[int, str]]] = {}
    current_labels: List[str] = []
    current_data: List[Tuple[int, str]] = []

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
        tile_index: Optional[int]
        tile_match = tile_pattern.search(location)
        if tile_match:
            try:
                tile_index = int(tile_match.group(1), 16)
            except ValueError:
                tile_index = None
        else:
            tile_index = pointer_tiles.get(location)
        if tile_index is None:
            continue
        current_data.append((tile_index, function))

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


def _read_block_bytes(map_path: Path) -> bytes:
    if map_path.exists():
        return map_path.read_bytes()
    compressed = map_path.with_suffix(map_path.suffix + ".lz")
    if not compressed.exists():
        raise FileNotFoundError(f"Missing {map_path} or {compressed}")
    return LzDecompressor(compressed.read_bytes()).decompress()


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
    tileset_key: str,
    tileset_label: str,
    png_module,
) -> List[TileAnimation]:
    entries = _tileset_animation_entries(polished_path).get(tileset_label)
    if not entries:
        if tileset_key == "TILESET_JOHTO_TRADITIONAL":
            return _johto_traditional_animations(polished_path, png_module)
        return []
    animations: List[TileAnimation] = []
    frames_cache: Dict[Tuple[str, ...], List[List[int]]] = {}
    for tile_index, function in entries:
        spec = _ANIMATION_SPECS.get(function)
        if spec is None:
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
        animations.append(TileAnimation(tile_index=tile_index, frames=frames, sequence=sequence))
    if animations:
        return animations
    if tileset_key == "TILESET_JOHTO_TRADITIONAL":
        return _johto_traditional_animations(polished_path, png_module)
    return []


def _animation_period(animations: Sequence[TileAnimation]) -> int:
    period = 1
    for animation in animations:
        if not animation.sequence:
            continue
        period = math.lcm(period, len(animation.sequence))
    return max(period, 1)


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
        from PIL import Image
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
) -> RendererData:
    map_info = repo_index.map_info(map_label)
    tileset_resources = repo_index.tileset_resources(map_info.tileset)
    blocks_path = polished_path / "maps" / f"{map_info.label}.ablk"
    block_bytes = _read_block_bytes(blocks_path)
    block_indices = _map_block_indices(block_bytes, map_info.width, map_info.height)
    allows_roof_palette = map_info.map_type in {"TOWN", "ROUTE", "ISOLATED"}
    roof_palette_override = None
    if map_info.roof_constant and allows_roof_palette:
        roof_palette_override = repo_index.roof_palette(map_info.group)
    palette = _day_palette(polished_path, roof_palette_override)
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
        "--output",
        type=Path,
        default=None,
        help="Destination path for the generated image (use .gif for animation). Defaults to <map>.png",
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
    try:
        renderer = _build_renderer(png, polished_path, repo_index, map_label)
    except KeyError as exc:
        raise SystemExit(str(exc))
    animations = _load_tileset_animations(polished_path, renderer.tileset_key, renderer.tileset_label, png)
    output_path = (args.output or (Path(__file__).resolve().parent.parent / f"{renderer.map_label}.png")).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if output_path.suffix.lower() == ".gif":
        period = _animation_period(animations)
        frames: List[Tuple[int, int, List[List[int]]]] = []
        for timer in range(period):
            animated_tiles = _apply_tile_animations(renderer.bank0_tiles, animations, timer)
            frames.append(_render_with_tiles(renderer, animated_tiles, renderer.bank1_tiles))
        _write_gif(output_path, frames, _GIF_FRAME_DURATION_MS)
    else:
        width, height, rows = _render_with_tiles(renderer, renderer.bank0_tiles, renderer.bank1_tiles)
        _write_png(output_path, width, height, rows, png)
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()
