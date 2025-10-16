#!/usr/bin/env python3
"""Extract overworld object metadata (NPCs, items, etc.) from polishedcrystal.

The resulting JSON payload includes sprite graphics, palette data, movement
attributes, and per-map object placements so the web atlas can render NPCs and
interactive objects on top of the stitched maps.
"""

from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import math
import re
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Tuple

import render_map

RGB = Tuple[int, int, int]

TIME_OF_DAY_SLUGS = ("morn", "day", "nite", "eve")
DEFAULT_FACE_FOR_DIRECTION = {
    "DOWN": "FACING_STEP_DOWN_0",
    "UP": "FACING_STEP_UP_0",
    "LEFT": "FACING_STEP_LEFT_0",
    "RIGHT": "FACING_STEP_RIGHT_0",
}
EVENT_CELLS_PER_BLOCK = 2


class ExpressionError(ValueError):
    """Raised when an assembly expression cannot be evaluated."""


class ASMConstantParser:
    """Very small interpreter for the ``const`` macro family used in PC."""

    _RE_CONST_DEF = re.compile(r"^const_def(?:\s+([^,]+))?(?:\s*,\s*([^,]+))?$")
    _RE_CONST = re.compile(r"^const\s+([A-Za-z0-9_]+)$")
    _RE_SHIFT_CONST = re.compile(r"^shift_const\s+([A-Za-z0-9_]+)$")
    _RE_CONST_SKIP = re.compile(r"^const_skip(?:\s+(.+))?$")
    _RE_CONST_NEXT = re.compile(r"^const_next\s+(.+)$")
    _RE_DEF_EQU = re.compile(r"^(?:DEF|def|REDEF|redef)\s+([A-Za-z0-9_]+)\s+(?:EQU|equ)\s+(.+)$")
    _RE_OW_NPC_PAL_CONST = re.compile(r"^ow_npc_pal_const\s+([A-Za-z0-9_]+)$")

    def __init__(self) -> None:
        self.symbols: Dict[str, int] = {
            "_RS": 0,
            "_RN": 0,
            "_RF": 0,
            "FALSE": 0,
            "TRUE": 1,
            "DOWN": 0,
            "UP": 1,
            "LEFT": 2,
            "RIGHT": 3,
            "SCREEN_WIDTH": 20,
            "SCREEN_HEIGHT": 18,
        }
        self.order: List[str] = []

    def parse_file(self, path: Path) -> None:
        const_value = 0
        const_inc = 1
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            code, *_ = raw_line.split(";", 1)
            line = code.strip()
            if not line:
                continue
            if line.startswith("MACRO "):
                # Macro bodies can contain const_def etc but we only care about top level.
                continue
            match = self._RE_CONST_DEF.match(line)
            if match:
                value_expr, inc_expr = match.groups()
                try:
                    const_value = self._evaluate(value_expr.strip() if value_expr else "0", const_value, const_inc)
                except ExpressionError:
                    const_value = 0
                if inc_expr:
                    try:
                        const_inc = self._evaluate(inc_expr.strip(), const_value, const_inc)
                    except ExpressionError:
                        const_inc = 1
                else:
                    const_inc = 1
                continue
            match = self._RE_CONST.match(line)
            if match:
                name = match.group(1)
                self._define(name, const_value)
                const_value += const_inc
                continue
            match = self._RE_SHIFT_CONST.match(line)
            if match:
                name = match.group(1)
                value = 1 << const_value
                self._define(name, value)
                self._define(f"{name}_F", const_value)
                const_value += const_inc
                continue
            match = self._RE_CONST_SKIP.match(line)
            if match:
                skip_expr = match.group(1)
                if skip_expr:
                    try:
                        skip = self._evaluate(skip_expr.strip(), const_value, const_inc)
                    except ExpressionError:
                        skip = 1
                else:
                    skip = 1
                const_value += const_inc * skip
                continue
            match = self._RE_CONST_NEXT.match(line)
            if match:
                try:
                    const_value = self._evaluate(match.group(1).strip(), const_value, const_inc)
                except ExpressionError:
                    const_value = 0
                continue
            match = self._RE_DEF_EQU.match(line)
            if match:
                name, expr = match.groups()
                try:
                    value = self._evaluate(expr.strip(), const_value, const_inc)
                except ExpressionError:
                    continue
                self._define(name, value)
                continue
            match = self._RE_OW_NPC_PAL_CONST.match(line)
            if match:
                name = match.group(1)
                pal_ow = f"PAL_OW_{name}"
                pal_npc = f"PAL_NPC_{name}"
                self._define(pal_ow, const_value)
                self._define(pal_npc, const_value + 1)
                const_value += const_inc
                continue
            # Ignore any other directives.

    def _define(self, name: str, value: int) -> None:
        if name not in self.symbols:
            self.order.append(name)
        self.symbols[name] = value

    def _evaluate(self, expr: Optional[str], const_value: int, const_inc: int) -> int:
        if expr is None:
            raise ExpressionError("missing expression")
        text = expr.strip()
        if not text:
            raise ExpressionError("empty expression")
        normalized = self._normalise_expression(text)
        try:
            node = compile(normalized, "<expr>", "eval")
        except SyntaxError as exc:  # pragma: no cover - defensive
            raise ExpressionError(f"invalid expression: {expr}") from exc
        locals_map = dict(self.symbols)
        locals_map.setdefault("const_value", const_value)
        locals_map.setdefault("const_inc", const_inc)
        locals_map.setdefault("low", lambda value: value & 0xFF)
        locals_map.setdefault("high", lambda value: (value >> 8) & 0xFF)
        locals_map.setdefault("bank", lambda value: (value >> 14) & 0x7F)
        try:
            result = eval(node, {"__builtins__": {}}, locals_map)
        except NameError as exc:  # pragma: no cover - defensive
            raise ExpressionError(f"unknown symbol in expression: {expr}") from exc
        if not isinstance(result, (int, float)):
            raise ExpressionError(f"non-numeric expression: {expr}")
        return int(result)

    @staticmethod
    def _normalise_expression(expr: str) -> str:
        def hex_repl(match: re.Match[str]) -> str:
            return f"0x{match.group(1)}"

        def bin_repl(match: re.Match[str]) -> str:
            return f"0b{match.group(1)}"

        text = re.sub(r"\$([0-9A-Fa-f]+)", hex_repl, expr)
        text = re.sub(r"%([01]+)", bin_repl, text)
        # Substitute LOW/HIGH macros with Python helpers (lowercase to avoid clashing with constants).
        text = re.sub(r"\bLOW\s*\(", "low(", text)
        text = re.sub(r"\bHIGH\s*\(", "high(", text)
        text = re.sub(r"\bBANK\s*\(", "bank(", text)
        return text

    def get(self, name: str, default: Optional[int] = None) -> Optional[int]:
        return self.symbols.get(name, default)

    def evaluate(self, expr: str, *, fallback: Optional[int] = None) -> Optional[int]:
        try:
            return self._evaluate(expr, 0, 1)
        except ExpressionError:
            return fallback


@dataclass
class SpriteHeader:
    sprite_constant: str
    sprite_id: int
    gfx_pointer: str
    sprite_type: str
    default_palette: str
    tile_path: str
    tile_bytes: bytes


@dataclass
class MovementInfo:
    identifier: str
    movement_id: int
    function: str
    facing: str
    action: str
    flags1: int
    flags2: int
    palette_flags: int


@dataclass
class FacingEntry:
    label: str
    constant: str
    tiles: List[Dict[str, int]] = field(default_factory=list)
    entry_count: int = 0


@dataclass
class ObjectEventEntry:
    index: int
    macro: str
    raw_text: str
    x_tiles: int
    y_tiles: int
    sprite_constant: str
    sprite_id: Optional[int]
    movement_constant: str
    movement_id: Optional[int]
    range_y: Optional[int]
    range_x: Optional[int]
    species_constant: Optional[str]
    species_id: Optional[int]
    time_mask: Optional[int]
    palette_value: Optional[int]
    palette_constant: Optional[str]
    object_type_constant: str
    object_type_id: Optional[int]
    script_command: Optional[str]
    script_argument: Optional[str]
    event_flag: Optional[str]
    extra_payload: Dict[str, object] = field(default_factory=dict)

    def to_payload(self, block_pixel_size: int, palette_lookup: Sequence[str]) -> Dict[str, object]:
        division = EVENT_CELLS_PER_BLOCK if EVENT_CELLS_PER_BLOCK > 0 else 1
        cell_pixel_size = max(1, block_pixel_size // division) if block_pixel_size > 0 else 1
        px = self.x_tiles * cell_pixel_size
        py = self.y_tiles * cell_pixel_size
        palette_name = None
        if self.palette_value is not None and self.palette_value > 0:
            index = self.palette_value - 1
            if 0 <= index < len(palette_lookup):
                palette_name = palette_lookup[index]
        time_slots = decode_time_mask(self.time_mask)
        payload: Dict[str, object] = {
            "index": self.index,
            "macro": self.macro,
            "x_tiles": self.x_tiles,
            "y_tiles": self.y_tiles,
            "x_pixels": px,
            "y_pixels": py,
            "sprite": {
                "constant": self.sprite_constant,
                "id": self.sprite_id,
            },
            "movement": {
                "constant": self.movement_constant,
                "id": self.movement_id,
            },
            "range": {
                "y": self.range_y,
                "x": self.range_x,
            },
            "time_of_day": {
                "mask": self.time_mask,
                "slots": time_slots,
            },
            "palette_override": {
                "value": self.palette_value,
                "constant": palette_name,
            },
            "object_type": {
                "constant": self.object_type_constant,
                "id": self.object_type_id,
            },
            "script": {
                "command": self.script_command,
                "argument": self.script_argument,
            },
            "event_flag": self.event_flag,
        }
        if self.species_constant or self.species_id is not None:
            payload["species"] = {
                "constant": self.species_constant,
                "id": self.species_id,
            }
        if self.extra_payload:
            payload["extra"] = self.extra_payload
        return payload


@dataclass
class MapObjectData:
    label: str
    map_constant: Optional[str]
    map_type: Optional[str]
    width_blocks: Optional[int]
    height_blocks: Optional[int]
    objects: List[ObjectEventEntry]

    def to_payload(self, block_pixel_size: int, palette_lookup: Sequence[str]) -> Dict[str, object]:
        return {
            "label": self.label,
            "map_constant": self.map_constant,
            "map_type": self.map_type,
            "width_blocks": self.width_blocks,
            "height_blocks": self.height_blocks,
            "objects": [entry.to_payload(block_pixel_size, palette_lookup) for entry in self.objects],
        }


def decode_time_mask(mask: Optional[int]) -> List[str]:
    if mask is None or mask < 0:
        return list(TIME_OF_DAY_SLUGS)
    slots: List[str] = []
    for index, slug in enumerate(TIME_OF_DAY_SLUGS):
        if mask & (1 << index):
            slots.append(slug)
    return slots


def parse_args() -> argparse.Namespace:
    repo_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Generate overworld object metadata for polished-atlas.")
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=repo_root / "external/polishedcrystal",
        help="Path to the polishedcrystal repository clone.",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=repo_root / "maps" / "object_metadata.json",
        help="Destination for the generated metadata payload.",
    )
    return parser.parse_args()


def ensure_repo(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {resolved}")
    return resolved


def gather_constants(root: Path) -> ASMConstantParser:
    parser = ASMConstantParser()
    constant_files = [
        "constants/sprite_constants.asm",
        "constants/map_object_constants.asm",
        "constants/sprite_data_constants.asm",
        "constants/script_constants.asm",
        "constants/ram_constants.asm",
        "constants/hardware_constants.asm",
        "constants/hardware.inc",
        "constants/pokemon_constants.asm",
    ]
    for relative in constant_files:
        target = root / relative
        if target.exists():
            parser.parse_file(target)
    return parser


def parse_palette_definitions(root: Path) -> Tuple[List[str], List[str], List[str]]:
    time_palettes: List[str] = []
    individual_palettes: List[str] = []
    copy_palettes: List[str] = []
    target = root / "constants/sprite_data_constants.asm"
    if not target.exists():
        return time_palettes, individual_palettes, copy_palettes
    current_section = "time"
    for raw_line in target.read_text(encoding="utf-8").splitlines():
        code, *_ = raw_line.split(";", 1)
        line = code.strip()
        if not line:
            continue
        if line.startswith("ow_npc_pal_const"):
            _, name = line.split(None, 1)
            palette_name = f"PAL_OW_{name.strip()}"
            if current_section == "time":
                time_palettes.append(palette_name)
            elif current_section == "individual":
                individual_palettes.append(palette_name)
            else:
                copy_palettes.append(palette_name)
            continue
        if line.startswith("DEF NUM_OW_TIME_OF_DAY_PALS"):
            current_section = "individual"
            continue
        if line.startswith("DEF NUM_OW_INDIVIDUAL_PALS"):
            current_section = "copy"
            continue
    return time_palettes, individual_palettes, copy_palettes


def convert_gb_rgb(value: int) -> int:
    return max(0, min(255, round((value / 31) * 255)))


def _resolve_palette_file(root: Path, relative: str) -> Path:
    candidate = root / relative
    if candidate.exists():
        return candidate
    if candidate.suffix:
        alt = candidate.with_suffix(candidate.suffix + ".inc")
        if alt.exists():
            return alt
        alt = candidate.with_suffix(".pal.inc")
        if alt.exists():
            return alt
    else:
        alt = candidate.with_suffix(".pal")
        if alt.exists():
            return alt
    return candidate


def parse_time_of_day_palettes(root: Path, names: Sequence[str]) -> Dict[str, Dict[str, List[List[int]]]]:
    path = _resolve_palette_file(root, "gfx/overworld/npc_sprites.pal")
    result: Dict[str, Dict[str, List[List[int]]]] = {name: {} for name in names}
    if not path.exists():
        return result
    variant: Optional[str] = None
    palette_index = 0
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("else"):
            break
        if stripped.startswith(";"):
            label = stripped[1:].strip().lower()
            if label in TIME_OF_DAY_SLUGS:
                variant = label
                palette_index = 0
            continue
        code, *_ = raw_line.split(";", 1)
        line = code.strip()
        if not line.startswith("RGB"):
            continue
        if variant is None:
            continue
        if palette_index >= len(names):
            continue
        numbers: List[int] = []
        for part in line[4:].split(","):
            value = part.strip()
            if not value:
                continue
            try:
                numbers.append(int(value, 0))
            except ValueError:
                numbers.append(0)
        colors: List[List[int]] = []
        for idx in range(0, len(numbers), 3):
            r = convert_gb_rgb(numbers[idx])
            g = convert_gb_rgb(numbers[idx + 1])
            b = convert_gb_rgb(numbers[idx + 2])
            colors.append([r, g, b])
        palette_name = names[palette_index]
        result[palette_name][variant] = colors
        palette_index += 1
    return result


def parse_single_object_palettes(root: Path, names: Sequence[str]) -> Dict[str, List[List[int]]]:
    path = _resolve_palette_file(root, "gfx/overworld/npc_single_object.pal")
    mapping: Dict[str, List[List[int]]] = {}
    if not path.exists():
        return mapping
    index = 0
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("else"):
            break
        code, *_ = raw_line.split(";", 1)
        line = code.strip()
        if not line.startswith("RGB"):
            continue
        if index >= len(names):
            continue
        numbers: List[int] = []
        for part in line[4:].split(","):
            value = part.strip()
            if not value:
                continue
            try:
                numbers.append(int(value, 0))
            except ValueError:
                numbers.append(0)
        colors: List[List[int]] = []
        for idx in range(0, len(numbers), 3):
            colors.append([convert_gb_rgb(numbers[idx]), convert_gb_rgb(numbers[idx + 1]), convert_gb_rgb(numbers[idx + 2])])
        mapping[names[index]] = colors
        index += 1
    return mapping


def parse_special_overcast_palettes(root: Path, names: Sequence[str]) -> Dict[str, Dict[str, List[List[int]]]]:
    path = _resolve_palette_file(root, "gfx/overworld/npc_sprites_overcast.pal")
    result: Dict[str, Dict[str, List[List[int]]]] = {name: {} for name in names}
    if not path.exists():
        return result
    variant: Optional[str] = None
    index = 0
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("else"):
            break
        if stripped.startswith(";"):
            label = stripped[1:].strip().lower()
            if label in TIME_OF_DAY_SLUGS:
                variant = label
                index = 0
            continue
        code, *_ = raw_line.split(";", 1)
        line = code.strip()
        if not line.startswith("RGB") or variant is None:
            continue
        if index >= len(names):
            continue
        numbers: List[int] = []
        for part in line[4:].split(","):
            value = part.strip()
            if not value:
                continue
            try:
                numbers.append(int(value, 0))
            except ValueError:
                numbers.append(0)
        colors: List[List[int]] = []
        for idx in range(0, len(numbers), 3):
            colors.append([convert_gb_rgb(numbers[idx]), convert_gb_rgb(numbers[idx + 1]), convert_gb_rgb(numbers[idx + 2])])
        result[names[index]][variant] = colors
        index += 1
    return result


def parse_darkness_palettes(root: Path, names: Sequence[str]) -> Dict[str, List[List[int]]]:
    path = _resolve_palette_file(root, "gfx/overworld/npc_sprites_darkness.pal")
    mapping: Dict[str, List[List[int]]] = {}
    if not path.exists():
        return mapping
    index = 0
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if stripped.startswith("else"):
            break
        code, *_ = raw_line.split(";", 1)
        line = code.strip()
        if not line.startswith("RGB"):
            continue
        if index >= len(names):
            continue
        numbers: List[int] = []
        for part in line[4:].split(","):
            value = part.strip()
            if not value:
                continue
            try:
                numbers.append(int(value, 0))
            except ValueError:
                numbers.append(0)
        colors: List[List[int]] = []
        for idx in range(0, len(numbers), 3):
            colors.append([convert_gb_rgb(numbers[idx]), convert_gb_rgb(numbers[idx + 1]), convert_gb_rgb(numbers[idx + 2])])
        mapping[names[index]] = colors
        index += 1
    return mapping


def parse_sprite_headers(root: Path, constants: ASMConstantParser) -> Tuple[List[SpriteHeader], Dict[str, SpriteHeader]]:
    sprite_constant_names = _read_sprite_constant_names(root / "constants" / "sprite_constants.asm")
    headers_path = root / "data/sprites/sprites.asm"
    pointer_to_path = parse_sprite_pointer_sources(root)
    headers: List[SpriteHeader] = []
    mapping: Dict[str, SpriteHeader] = {}
    header_lines = iter(
        line
        for line in headers_path.read_text(encoding="utf-8").splitlines()
        if line.strip().startswith("overworld_sprite")
    )
    for sprite_name in sprite_constant_names:
        sprite_id = constants.get(sprite_name, -1)
        try:
            line = next(header_lines)
        except StopIteration:
            tile_path = ""
            header = SpriteHeader(
                sprite_constant=sprite_name,
                sprite_id=sprite_id,
                gfx_pointer="",
                sprite_type="",
                default_palette="",
                tile_path="",
                tile_bytes=b"",
            )
            headers.append(header)
            mapping[sprite_name] = header
            continue
        payload = line.split("overworld_sprite", 1)[1].strip()
        args = split_arguments(payload)
        if len(args) != 3:
            raise ValueError(f"Unexpected overworld_sprite entry: {line}")
        gfx_pointer, sprite_type, palette_constant = [arg.strip() for arg in args]
        tile_path = pointer_to_path.get(gfx_pointer)
        tile_bytes = read_sprite_graphics(root, tile_path) if tile_path else b""
        header = SpriteHeader(
            sprite_constant=sprite_name,
            sprite_id=sprite_id if sprite_id is not None else -1,
            gfx_pointer=gfx_pointer,
            sprite_type=sprite_type,
            default_palette=palette_constant,
            tile_path=tile_path or "",
            tile_bytes=tile_bytes,
        )
        headers.append(header)
        mapping[sprite_name] = header
    return headers, mapping


def _read_sprite_constant_names(path: Path) -> List[str]:
    if not path.exists():
        return []
    names: List[str] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        code, *_ = raw_line.split(";", 1)
        line = code.strip()
        if not line or not line.startswith("const "):
            continue
        parts = line.split()
        if len(parts) < 2:
            continue
        name = parts[1]
        if not name.startswith("SPRITE_"):
            continue
        if name == "SPRITE_NONE":
            continue
        names.append(name)
    return names


def parse_sprite_pointer_sources(root: Path) -> Dict[str, str]:
    path = root / "gfx/sprites.asm"
    mapping: Dict[str, str] = {}
    current_label: Optional[str] = None
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        if stripped.startswith("SECTION"):
            continue
        inline_match = re.match(r"^([A-Za-z0-9_]+)::\s+INCBIN\s+\"([^\"]+)\"", stripped)
        if inline_match:
            mapping[inline_match.group(1)] = inline_match.group(2)
            current_label = None
            continue
        if stripped.endswith("::"):
            current_label = stripped[:-2]
            continue
        if "INCBIN" in stripped and current_label:
            match = re.search(r'INCBIN\s+"([^"]+)"', stripped)
            if match:
                mapping[current_label] = match.group(1)
            current_label = None
    return mapping


def read_sprite_graphics(root: Path, relative_path: Optional[str]) -> bytes:
    if not relative_path:
        return b""
    target = root / relative_path
    if target.exists():
        data = target.read_bytes()
        if target.suffix == ".lz":
            decompressor = render_map.LzDecompressor(data)
            return bytes(decompressor.decompress())
        return data
    fallback = None
    if relative_path.endswith(".2bpp.lz"):
        candidate = relative_path[:-len(".2bpp.lz")] + ".png"
        fallback = root / candidate
    else:
        fallback = target.with_suffix(".png")
    if fallback is None or not fallback.exists():
        return b""
    png_module = _load_png_module(root)
    if png_module is None:
        return b""
    tiles = render_map._decode_tiles_from_png(fallback, png_module)
    return encode_tiles_to_2bpp(tiles)


def _load_png_module(root: Path):
    try:
        import png  # type: ignore

        return png
    except ImportError:
        module_path = root / "utils" / "png.py"
        if not module_path.exists():
            return None
        spec = importlib.util.spec_from_file_location("pc_png", module_path)
        if spec is None or spec.loader is None:
            return None
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)  # type: ignore[attr-defined]
        return module


def encode_tiles_to_2bpp(tiles: Sequence[Sequence[int]]) -> bytes:
    output = bytearray()
    for tile in tiles:
        if len(tile) != 64:
            raise ValueError("tile data must contain 64 elements")
        for row in range(8):
            low = 0
            high = 0
            for col in range(8):
                value = tile[row * 8 + col] & 0x03
                shift = 7 - col
                low |= (value & 0x01) << shift
                high |= ((value >> 1) & 0x01) << shift
            output.append(low)
            output.append(high)
    return bytes(output)


def split_arguments(payload: str) -> List[str]:
    args: List[str] = []
    if not payload:
        return args
    current: List[str] = []
    depth = 0
    in_string = False
    string_char = ""
    for char in payload:
        if char in {'"', '\''}:
            if in_string and char == string_char:
                in_string = False
            elif not in_string:
                in_string = True
                string_char = char
        if not in_string:
            if char == "(":
                depth += 1
            elif char == ")":
                depth = max(0, depth - 1)
            elif char == "," and depth == 0:
                arg = "".join(current).strip()
                if arg:
                    args.append(arg)
                current = []
                continue
        current.append(char)
    trailing = "".join(current).strip()
    if trailing:
        args.append(trailing)
    return args


def parse_movement_table(root: Path, constants: ASMConstantParser) -> Dict[str, MovementInfo]:
    path = root / "data/sprites/map_objects.asm"
    mapping: Dict[str, MovementInfo] = {}
    if not path.exists():
        return mapping
    movement_index = 0
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        code, _, comment = raw_line.partition(";")
        stripped = code.strip()
        if not stripped.startswith("sprite_movement_data"):
            continue
        args = split_arguments(stripped[len("sprite_movement_data") :].strip())
        if len(args) != 6:
            continue
        identifier = comment.strip().split()[-1] if comment.strip() else f"SPRITEMOVEDATA_{movement_index:02X}"
        mapping[identifier] = MovementInfo(
            identifier=identifier,
            movement_id=constants.get(identifier, movement_index),
            function=args[0],
            facing=args[1],
            action=args[2],
            flags1=constants.evaluate(args[3], fallback=0) if args[3] else 0,
            flags2=constants.evaluate(args[4], fallback=0) if args[4] else 0,
            palette_flags=constants.evaluate(args[5], fallback=0) if args[5] else 0,
        )
        movement_index += 1
    return mapping


def parse_facings(root: Path, constants: ASMConstantParser) -> Dict[str, FacingEntry]:
    path = root / "data/sprites/facings.asm"
    if not path.exists():
        return {}
    lines = path.read_text(encoding="utf-8").splitlines()
    facing_map: Dict[str, str] = {}
    in_table = False
    for raw_line in lines:
        code, _, comment = raw_line.partition(";")
        stripped = code.strip()
        if not stripped:
            continue
        if stripped.startswith("Facings:"):
            in_table = True
            continue
        if not in_table:
            continue
        if stripped.startswith("assert_table_length"):
            break
        if stripped.startswith("dw"):
            label = stripped[2:].strip()
            constant = comment.strip() if comment else ""
            if constant:
                facing_map[constant] = label
    entries: Dict[str, FacingEntry] = {}
    pending_labels: List[str] = []
    active_entries: List[FacingEntry] = []
    expected = 0
    for raw_line in lines:
        code, _, comment = raw_line.partition(";")
        stripped = code.strip()
        if not stripped:
            continue
        if stripped.endswith(":"):
            label = stripped.rstrip(":")
            pending_labels.append(label)
            expected = 0
            active_entries = []
            continue
        if stripped.startswith("db"):
            args = split_arguments(stripped[2:].strip())
            if expected == 0:
                expected = int(constants.evaluate(args[0], fallback=0)) if args else 0
                if expected < 0:
                    expected = 0
                if not active_entries:
                    shared_tiles: List[Dict[str, int]] = []
                    if not pending_labels:
                        pending_labels.append(f"anon_{len(entries)}")
                    for label in pending_labels:
                        entry = entries.get(label)
                        if entry is None:
                            entry = FacingEntry(label=label, constant="")
                            entries[label] = entry
                        entry.tiles = shared_tiles
                        entry.entry_count = 0
                        active_entries.append(entry)
                    pending_labels.clear()
                continue
            if len(args) != 4:
                continue
            values = [int(constants.evaluate(arg, fallback=0)) if arg else 0 for arg in args]
            if not active_entries:
                continue
            tiles = active_entries[0].tiles
            tiles.append({
                "dy": values[0],
                "dx": values[1],
                "attributes": values[2],
                "tile": values[3],
            })
            for entry in active_entries:
                entry.entry_count = len(entry.tiles)
            expected = max(0, expected - 1)
            if expected == 0:
                active_entries = []
    for facing_constant, label in facing_map.items():
        if label in entries:
            entries[label].constant = facing_constant
    return entries


def evaluate_expression(expr: str, constants: ASMConstantParser) -> Optional[int]:
    if not expr:
        return None
    return constants.evaluate(expr)


def macro_object_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    return args, {}


def macro_itemball_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) != 5:
        raise ValueError("itemball_event expects 5 arguments")
    x, y, item, qty, flag = args
    expanded = [
        x,
        y,
        "SPRITE_BALL_CUT_FRUIT",
        "SPRITEMOVEDATA_STANDING_DOWN",
        "0",
        "0",
        "-1",
        "PAL_NPC_POKE_BALL",
        "OBJECTTYPE_ITEMBALL",
        "PLAYEREVENT_ITEMBALL",
        item,
        qty,
        flag,
    ]
    extra = {"item": item, "quantity": qty}
    return expanded, extra


def macro_keyitemball_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) != 4:
        raise ValueError("keyitemball_event expects 4 arguments")
    x, y, item, flag = args
    expanded = [
        x,
        y,
        "SPRITE_BALL_CUT_FRUIT",
        "SPRITEMOVEDATA_STANDING_DOWN",
        "0",
        "0",
        "-1",
        "PAL_NPC_KEY_ITEM",
        "OBJECTTYPE_ITEMBALL",
        "PLAYEREVENT_KEYITEMBALL",
        item,
        flag,
    ]
    extra = {"item": item, "quantity": "1"}
    return expanded, extra


def macro_tmhmball_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) != 4:
        raise ValueError("tmhmball_event expects 4 arguments")
    x, y, item, flag = args
    expanded = [
        x,
        y,
        "SPRITE_BALL_CUT_FRUIT",
        "SPRITEMOVEDATA_STANDING_DOWN",
        "0",
        "0",
        "-1",
        "PAL_NPC_YELLOW",
        "OBJECTTYPE_ITEMBALL",
        "PLAYEREVENT_TMHMBALL",
        item,
        flag,
    ]
    extra = {"item": item, "quantity": "1"}
    return expanded, extra


def macro_cuttree_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) != 3:
        raise ValueError("cuttree_event expects 3 arguments")
    x, y, flag = args
    expanded = [
        x,
        y,
        "SPRITE_BALL_CUT_FRUIT",
        "SPRITEMOVEDATA_CUTTABLE_TREE",
        "0",
        "0",
        "-1",
        "0",
        "OBJECTTYPE_COMMAND",
        "jumpstd",
        "cuttree",
        flag,
    ]
    return expanded, {}


def macro_fruittree_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) not in {5, 7}:
        raise ValueError("fruittree_event expects 5 or 7 arguments")
    x, y, tree, berry, palette = args[:5]
    if len(args) == 5:
        expanded = [
            x,
            y,
            "SPRITE_BALL_CUT_FRUIT",
            "SPRITEMOVEDATA_FRUIT",
            "0",
            f"{tree}-1",
            "-1",
            palette,
            "OBJECTTYPE_COMMAND",
            "fruittree",
            tree,
            berry,
            "-1",
        ]
    else:
        radius = f"{tree}-1"
        steps = args[5]
        flag = args[6]
        expanded = [
            x,
            y,
            "SPRITE_BALL_CUT_FRUIT",
            "SPRITEMOVEDATA_FRUIT",
            "0",
            radius,
            f"(1 << {steps})",
            palette,
            "OBJECTTYPE_COMMAND",
            "fruittree",
            tree,
            berry,
            flag,
        ]
    return expanded, {"tree": tree, "berry": berry}


def macro_strengthboulder_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) == 2:
        x, y = args
        flag = "-1"
    elif len(args) == 3:
        x, y, flag = args
    else:
        raise ValueError("strengthboulder_event expects 2 or 3 arguments")
    expanded = [
        x,
        y,
        "SPRITE_BOULDER_ROCK_FOSSIL",
        "SPRITEMOVEDATA_STRENGTH_BOULDER",
        "0",
        "0",
        "-1",
        "0",
        "OBJECTTYPE_COMMAND",
        "jumpstd",
        "strengthboulder",
        flag,
    ]
    return expanded, {}


def macro_smashrock_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) == 2:
        x, y = args
        flag = "-1"
        arg11 = "0"
    elif len(args) == 3:
        x, y, flag = args
        arg11 = "0"
    else:
        raise ValueError("smashrock_event expects 2 or 3 arguments")
    expanded = [
        x,
        y,
        "SPRITE_BOULDER_ROCK_FOSSIL",
        "SPRITEMOVEDATA_SMASHABLE_ROCK",
        "0",
        "0",
        "-1",
        "0",
        "OBJECTTYPE_COMMAND",
        "jumpstd",
        "smashrock",
        arg11,
        flag,
    ]
    return expanded, {}


def macro_pokemon_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) == 8:
        x, y, species, movement, time_mask, palette, script, flag = args
        expanded = [
            x,
            y,
            "SPRITE_MON_ICON",
            movement,
            "0",
            species,
            time_mask,
            palette,
            "OBJECTTYPE_POKEMON",
            "NO_FORM",
            script,
            flag,
        ]
        extra = {"species": species, "form": "NO_FORM"}
    elif len(args) == 9:
        x, y, species, form, movement, time_mask, palette, script, flag = args
        expanded = [
            x,
            y,
            "SPRITE_MON_ICON",
            movement,
            "0",
            species,
            time_mask,
            palette,
            "OBJECTTYPE_POKEMON",
            form,
            script,
            flag,
        ]
        extra = {"species": species, "form": form}
    else:
        raise ValueError("pokemon_event expects 8 or 9 arguments")
    return expanded, extra


def macro_pc_nurse_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) != 2:
        raise ValueError("pc_nurse_event expects 2 arguments")
    x, y = args
    expanded = [
        x,
        y,
        "SPRITE_BOWING_NURSE",
        "SPRITEMOVEDATA_STANDING_DOWN",
        "0",
        "0",
        "-1",
        "0",
        "OBJECTTYPE_COMMAND",
        "jumpstd",
        "pokecenternurse",
        "-1",
    ]
    return expanded, {}


def macro_mart_clerk_event(args: List[str]) -> Tuple[List[str], Dict[str, object]]:
    if len(args) != 4:
        raise ValueError("mart_clerk_event expects 4 arguments")
    x, y, mart_type, mart_id = args
    expanded = [
        x,
        y,
        "SPRITE_CLERK",
        "SPRITEMOVEDATA_STANDING_RIGHT",
        "0",
        "0",
        "-1",
        "0",
        "OBJECTTYPE_COMMAND",
        "pokemart",
        mart_type,
        mart_id,
        "-1",
    ]
    extra = {"mart_type": mart_type, "mart_id": mart_id}
    return expanded, extra


MACRO_EXPANSIONS = {
    "object_event": macro_object_event,
    "itemball_event": macro_itemball_event,
    "keyitemball_event": macro_keyitemball_event,
    "tmhmball_event": macro_tmhmball_event,
    "cuttree_event": macro_cuttree_event,
    "fruittree_event": macro_fruittree_event,
    "strengthboulder_event": macro_strengthboulder_event,
    "smashrock_event": macro_smashrock_event,
    "pokemon_event": macro_pokemon_event,
    "pc_nurse_event": macro_pc_nurse_event,
    "mart_clerk_event": macro_mart_clerk_event,
}


def parse_map_objects(
    root: Path,
    constants: ASMConstantParser,
    sprite_lookup: Dict[str, SpriteHeader],
    movement_lookup: Dict[str, MovementInfo],
    palette_names: Sequence[str],
) -> List[MapObjectData]:
    repo_index = render_map.RepositoryIndex(root)
    block_pixel_size = render_map.MetatileSet.METATILE_DIM * render_map.Tileset.TILE_SIZE
    map_results: List[MapObjectData] = []
    for script_path in sorted((root / "maps").rglob("*.asm")):
        label = script_path.stem
        map_info = repo_index.maps.get(label)
        map_objects: List[ObjectEventEntry] = []
        inside = False
        index = 0
        for raw_line in script_path.read_text(encoding="utf-8").splitlines():
            code, *_ = raw_line.split(";", 1)
            line = code.strip()
            if not line:
                continue
            if not inside:
                if line.startswith("def_object_events"):
                    inside = True
                continue
            if line.startswith("def_"):
                break
            macro_name, *rest = line.split(None, 1)
            args_str = rest[0] if rest else ""
            if macro_name not in MACRO_EXPANSIONS:
                continue
            raw_args = split_arguments(args_str)
            try:
                expanded_args, extra = MACRO_EXPANSIONS[macro_name](raw_args)
            except Exception:
                continue
            object_args, extra_payload = expanded_args, dict(extra)
            index += 1
            entry = build_object_entry(
                index=index,
                macro=macro_name,
                raw_text=line,
                args=object_args,
                constants=constants,
                sprite_lookup=sprite_lookup,
                movement_lookup=movement_lookup,
                palette_names=palette_names,
                extra_payload=extra_payload,
            )
            map_objects.append(entry)
        if not map_objects:
            continue
        data = MapObjectData(
            label=label,
            map_constant=map_info.constant if map_info else None,
            map_type=map_info.map_type if map_info else None,
            width_blocks=map_info.width if map_info else None,
            height_blocks=map_info.height if map_info else None,
            objects=map_objects,
        )
        map_results.append(data)
    return map_results


def build_object_entry(
    *,
    index: int,
    macro: str,
    raw_text: str,
    args: List[str],
    constants: ASMConstantParser,
    sprite_lookup: Dict[str, SpriteHeader],
    movement_lookup: Dict[str, MovementInfo],
    palette_names: Sequence[str],
    extra_payload: Dict[str, object],
) -> ObjectEventEntry:
    def resolve_constant(name: str) -> Optional[int]:
        return constants.get(name)

    x_expr, y_expr = args[0], args[1]
    sprite_expr = args[2]
    movement_expr = args[3]
    range_y_expr = args[4] if len(args) > 4 else "0"
    range_x_expr = args[5] if len(args) > 5 else "0"
    time_expr = args[6] if len(args) > 6 else "-1"
    palette_expr = args[7] if len(args) > 7 else "0"
    object_type_expr = args[8] if len(args) > 8 else "OBJECTTYPE_SCRIPT"
    command_expr = args[9] if len(args) > 9 else "0"
    script_expr = args[10] if len(args) > 10 else "0"
    flag_expr = args[11] if len(args) > 11 else "-1"
    extra_expr = args[12] if len(args) > 12 else None

    x_tiles = evaluate_expression(x_expr, constants) or 0
    y_tiles = evaluate_expression(y_expr, constants) or 0
    sprite_constant = sprite_expr
    sprite_id = resolve_constant(sprite_constant)
    movement_constant = movement_expr
    movement_id = resolve_constant(movement_constant)
    range_y = evaluate_expression(range_y_expr, constants)
    range_x = evaluate_expression(range_x_expr, constants)
    time_mask = evaluate_expression(time_expr, constants)
    palette_value = evaluate_expression(palette_expr, constants)
    object_type_id = evaluate_expression(object_type_expr, constants)
    object_type_constant = object_type_expr
    species_constant = extra_payload.get("species") if isinstance(extra_payload.get("species"), str) else None
    species_id = resolve_constant(species_constant) if species_constant else None
    if palette_value is not None and palette_value < 0:
        palette_value = -1
    script_command = None
    script_argument = None
    if object_type_constant == "OBJECTTYPE_COMMAND":
        script_command = command_expr
        script_argument = script_expr
        if extra_expr:
            extra_payload.setdefault("argument2", extra_expr)
    else:
        script_command = command_expr if command_expr not in {"0", "NO_FORM"} else None
        script_argument = script_expr if script_expr not in {"0", "-1"} else None
    event_flag = None
    if flag_expr not in {"0", "-1"}:
        event_flag = flag_expr
    entry = ObjectEventEntry(
        index=index,
        macro=macro,
        raw_text=raw_text,
        x_tiles=x_tiles,
        y_tiles=y_tiles,
        sprite_constant=sprite_constant,
        sprite_id=sprite_id,
        movement_constant=movement_constant,
        movement_id=movement_id,
        range_y=range_y,
        range_x=range_x,
        species_constant=species_constant,
        species_id=species_id,
        time_mask=time_mask,
        palette_value=palette_value,
        palette_constant=None,
        object_type_constant=object_type_constant,
        object_type_id=object_type_id,
        script_command=script_command,
        script_argument=script_argument,
        event_flag=event_flag,
        extra_payload=extra_payload,
    )
    return entry


def build_payload(
    *,
    sprites: List[SpriteHeader],
    movements: Dict[str, MovementInfo],
    facings: Dict[str, FacingEntry],
    map_objects: List[MapObjectData],
    time_palettes: Dict[str, Dict[str, List[List[int]]]],
    individual_palettes: Dict[str, List[List[int]]],
    overcast_palettes: Dict[str, Dict[str, List[List[int]]]],
    darkness_palettes: Dict[str, List[List[int]]],
    palette_names: Sequence[str],
    block_pixel_size: int,
) -> Dict[str, object]:
    sprite_payload: Dict[str, object] = {}
    for sprite in sprites:
        sprite_payload[sprite.sprite_constant] = {
            "id": sprite.sprite_id,
            "gfx_pointer": sprite.gfx_pointer,
            "sprite_type": sprite.sprite_type,
            "default_palette": sprite.default_palette,
            "tile_path": sprite.tile_path,
            "tile_count": len(sprite.tile_bytes) // 16 if sprite.tile_bytes else 0,
            "tiles_2bpp_base64": base64.b64encode(sprite.tile_bytes).decode("ascii") if sprite.tile_bytes else "",
        }
    movement_payload: Dict[str, object] = {}
    for name, movement in movements.items():
        movement_payload[name] = {
            "id": movement.movement_id,
            "function": movement.function,
            "facing": movement.facing,
            "action": movement.action,
            "flags1": movement.flags1,
            "flags2": movement.flags2,
            "palette_flags": movement.palette_flags,
        }
    facing_payload: Dict[str, object] = {}
    for entry in facings.values():
        facing_payload[entry.constant or entry.label] = {
            "label": entry.label,
            "entries": entry.tiles,
        }
    maps_payload = {
        map_data.label: map_data.to_payload(block_pixel_size, palette_names)
        for map_data in map_objects
    }
    palette_payload: Dict[str, object] = {}
    for name in palette_names:
        palette_payload[name] = {
            "time_variants": time_palettes.get(name, {}),
            "overcast": overcast_palettes.get(name, {}),
            "darkness": darkness_palettes.get(name),
        }
    palette_payload.update({name: {"static": colors} for name, colors in individual_palettes.items()})
    return {
        "version": 1,
        "generated_at": datetime.utcnow().replace(tzinfo=None).isoformat() + "Z",
        "block_pixel_size": block_pixel_size,
        "cells_per_block": EVENT_CELLS_PER_BLOCK,
        "event_cell_pixel_size": max(1, block_pixel_size // (EVENT_CELLS_PER_BLOCK if EVENT_CELLS_PER_BLOCK > 0 else 1))
        if block_pixel_size > 0
        else 1,
        "palettes": palette_payload,
        "sprites": sprite_payload,
        "movements": movement_payload,
        "facings": facing_payload,
        "maps": maps_payload,
        "palette_names": list(palette_names),
        "default_facing_for_direction": DEFAULT_FACE_FOR_DIRECTION,
        "time_of_day_slots": list(TIME_OF_DAY_SLUGS),
    }


def main() -> None:
    args = parse_args()
    polished_root = ensure_repo(args.polishedcrystal)
    constants = gather_constants(polished_root)
    time_palette_names, individual_palette_names, copy_palette_names = parse_palette_definitions(polished_root)
    palette_names = time_palette_names + individual_palette_names + copy_palette_names
    time_palettes = parse_time_of_day_palettes(polished_root, time_palette_names)
    individual_palettes = parse_single_object_palettes(polished_root, individual_palette_names)
    overcast_palettes = parse_special_overcast_palettes(polished_root, time_palette_names)
    darkness_palettes = parse_darkness_palettes(polished_root, time_palette_names + individual_palette_names)
    sprites, sprite_lookup = parse_sprite_headers(polished_root, constants)
    movements = parse_movement_table(polished_root, constants)
    facings = parse_facings(polished_root, constants)
    block_pixel_size = render_map.MetatileSet.METATILE_DIM * render_map.Tileset.TILE_SIZE
    map_objects = parse_map_objects(
        polished_root,
        constants,
        sprite_lookup,
        movements,
        palette_names,
    )
    payload = build_payload(
        sprites=sprites,
        movements=movements,
        facings=facings,
        map_objects=map_objects,
        time_palettes=time_palettes,
        individual_palettes=individual_palettes,
        overcast_palettes=overcast_palettes,
        darkness_palettes=darkness_palettes,
        palette_names=palette_names,
        block_pixel_size=block_pixel_size,
    )
    output_path = args.output.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(f"Wrote object metadata for {len(map_objects)} map(s) to {output_path}")


if __name__ == "__main__":  # pragma: no cover - script entry point
    main()
