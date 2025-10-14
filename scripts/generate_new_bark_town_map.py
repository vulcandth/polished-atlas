#!/usr/bin/env python3
"""Generate a PNG render of New Bark Town using polishedcrystal assets.

The script understands the repo's VRAM banking scheme, metatile format, and
LZ-compressed map blocks so it can source the same assets used by the game.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from typing import Iterable, List, Sequence, Tuple

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
_TILESET_INFO = {
    "TILESET_JOHTO_TRADITIONAL": {
        "metatiles_bin": "data/tilesets/johto_traditional_metatiles.bin",
        "attributes_bin": "data/tilesets/johto_traditional_attributes.bin",
        "bank0_sources": [
            "gfx/tilesets/johto_common.png",
        ],
        "bank1_sources": [
            "gfx/tilesets/johto_traditional.johto_common.png",
        ],
    },
}


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


def _day_palette(base_path: Path) -> List[List[RGB]]:
    palettes = _load_palette(base_path / "gfx/tilesets/bg_tiles.pal")
    return palettes[8:11] + [palettes[0x29]] + palettes[12:16]


class Attributes:
    COLOR = 0x07
    BANK1 = 0x08
    XFLIP = 0x20
    YFLIP = 0x40

    def __init__(self, path: Path, palette_source: Iterable[List[RGB]]):
        self.colors = list(palette_source)
        self.data = _chunk_bytes(path.read_bytes(), 16)


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

    def __init__(self, path: Path, tileset: Tileset, attributes: Attributes):
        indices = _chunk_bytes(path.read_bytes(), self.METATILE_DIM ** 2)
        self._tiles: List[List[List[RGB]]] = []
        for idx, index_set in enumerate(indices):
            attr_set = attributes.data[idx]
            metatile = [tileset.tile(tile_idx, attr) for tile_idx, attr in zip(index_set, attr_set)]
            self._tiles.append(metatile)

    def __getitem__(self, item: int) -> List[List[RGB]]:
        return self._tiles[item]


def _parse_map_dimensions(constants_path: Path, constant: str) -> Tuple[int, int]:
    pattern = re.compile(rf"map_const\s+{constant},\s*(\d+),\s*(\d+)")
    for line in constants_path.read_text().splitlines():
        match = pattern.search(line)
        if match:
            width, height = int(match.group(1)), int(match.group(2))
            return width, height
    raise ValueError(f"Could not locate dimensions for {constant}")


def _parse_map_tileset(maps_path: Path, map_label: str) -> str:
    pattern = re.compile(rf"map\s+{map_label},\s*(TILESET_[A-Z0-9_]+)")
    for line in maps_path.read_text().splitlines():
        line = line.split(";", 1)[0]
        match = pattern.search(line)
        if match:
            return match.group(1)
    raise ValueError(f"Could not locate tileset for {map_label}")


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


def _load_tileset_bank(polished_path: Path, sources: Sequence[str], png_module) -> List[List[int]]:
    tiles: List[List[int]] = []
    for relative in sources:
        asset_path = polished_path / relative
        if asset_path.suffix == ".png":
            tiles.extend(_decode_tiles_from_png(asset_path, png_module))
        else:
            data = _read_asset_bytes(asset_path)
            tiles.extend(_decode_2bpp_tiles(data))
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


def _map_block_indices(data: bytes, width: int, height: int) -> List[int]:
    expected = width * height
    if len(data) != expected:
        raise ValueError(f"Expected {expected} blocks, found {len(data)}")
    return list(data)


def _build_renderer(png_module, polished_path: Path) -> Tuple[MetatileSet, List[int], int, int]:
    map_label = "NewBarkTown"
    map_constant = "NEW_BARK_TOWN"
    constants_path = polished_path / "constants/map_constants.asm"
    maps_path = polished_path / "data/maps/maps.asm"
    width, height = _parse_map_dimensions(constants_path, map_constant)
    tileset_key = _parse_map_tileset(maps_path, map_label)
    resources = _TILESET_INFO.get(tileset_key)
    if not resources:
        raise KeyError(f"Tileset resources for {tileset_key} are not defined")
    blocks_path = polished_path / "maps" / f"{map_label}.ablk"
    block_bytes = _read_block_bytes(blocks_path)
    block_indices = _map_block_indices(block_bytes, width, height)
    palette = _day_palette(polished_path)
    attributes = Attributes(polished_path / resources["attributes_bin"], palette)
    bank0_tiles = _load_tileset_bank(polished_path, resources.get("bank0_sources", []), png_module)
    bank1_tiles = _load_tileset_bank(polished_path, resources.get("bank1_sources", []), png_module)
    tileset = Tileset(bank0_tiles, bank1_tiles, attributes)
    metatiles = MetatileSet(polished_path / resources["metatiles_bin"], tileset, attributes)
    return metatiles, block_indices, width, height


def parse_args() -> argparse.Namespace:
    default_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Render the New Bark Town overworld map to PNG.")
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=default_root / "external/polishedcrystal",
        help="Path to the polishedcrystal repository clone.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=default_root / "new_bark_town.png",
        help="Destination path for the generated PNG.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    polished_path = args.polishedcrystal.resolve()
    if not polished_path.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {polished_path}")
    sys.path.insert(0, str(polished_path / "utils"))
    import png  # type: ignore

    metatiles, block_indices, width, height = _build_renderer(png, polished_path)
    overall_width, overall_height, rows = _render_map(block_indices, width, height, metatiles)
    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    _write_png(output_path, overall_width, overall_height, rows, png)
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()
