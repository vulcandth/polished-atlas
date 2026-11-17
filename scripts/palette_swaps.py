"""Parse upstream palette-swap callbacks and evaluate spatial atlas colors.

The game selects whole BG palette slots from the player's position. The atlas
uses the same ordered selection at each rendered location to create a composite.
Unsupported callback control flow fails explicitly rather than choosing a table
without evaluating its conditions.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
import re
from typing import Callable

RGB = tuple[int, int, int]
Palette = tuple[RGB, ...]
PaletteSet = tuple[Palette, ...]
_LABEL = re.compile(r"^([A-Za-z_][\w.]*|\.[\w.]+)::?$")


def code_lines(path: Path) -> list[str]:
    return [line.split(";", 1)[0].strip() for line in path.read_text(encoding="utf-8").splitlines()]


def qualify(label: str, scope: str) -> str:
    return scope + label if label.startswith(".") else label


def number(value: str) -> int:
    value = value.strip()
    if value.startswith("$"):
        return int(value[1:], 16)
    if value.startswith("%"):
        return int(value[1:], 2)
    return int(value, 10)


@dataclass(frozen=True)
class PaletteSwap:
    min_x: int
    max_x: int
    min_y: int
    max_y: int
    slot: int
    outside: str | None
    inside: str | None

    def contains(self, x: int, y: int) -> bool:
        return self.min_x <= x < self.max_x and self.min_y <= y < self.max_y


@dataclass(frozen=True)
class ResolvedSwap:
    rectangle: PaletteSwap
    outside: Palette | None
    inside: Palette | None


def evaluate(base: PaletteSet, swaps: tuple[ResolvedSwap, ...], x: int, y: int) -> PaletteSet:
    result = list(base)
    for swap in swaps:
        selected = swap.inside if swap.rectangle.contains(x, y) else swap.outside
        if selected is not None:
            result[swap.rectangle.slot] = selected
    return tuple(result)


class PaletteSwapIndex:
    def __init__(self, root: Path, load_palette: Callable):
        self.maps: dict[str, tuple[PaletteSwap, ...]] = {}
        self.palettes: dict[str, tuple[Palette, ...]] = {}
        palette_source = root / "data/tileset_palettes.asm"
        if not palette_source.exists():
            # v3.2.2 has no palette-swap system.
            return
        constants = [line.split()[1] for line in code_lines(root / "constants/tileset_constants.asm")
                     if line.startswith("const PAL_BG_")]
        slots = dict(zip(constants, range(len(constants))))
        if len(slots) != 8:
            raise ValueError("Expected eight upstream PAL_BG_* constants")
        pending: list[str] = []
        includes: dict[str, str] = {}
        for line in code_lines(palette_source):
            label = _LABEL.fullmatch(line)
            if label:
                pending.append(label[1])
            elif line.startswith("INCLUDE "):
                match = re.fullmatch(r'INCLUDE "([^"]+)"', line)
                if not match:
                    raise ValueError(f"Unsupported palette INCLUDE: {line}")
                includes.update({label: match[1] for label in pending})
                pending.clear()
            elif line and not line.startswith(("table_width", "assert_table_length")):
                pending.clear()
        for path in sorted((root / "maps").glob("*.asm")):
            lines = code_lines(path)
            if not any(line.startswith("usepaletteswap ") for line in lines):
                continue
            swaps = self.parse_map(lines, slots, path.stem)
            self.maps[path.stem] = swaps
            for swap in swaps:
                for label in (swap.outside, swap.inside):
                    if label is None or label in self.palettes:
                        continue
                    if label not in includes:
                        raise ValueError(f"Unknown palette table {label} in {path}")
                    colors = tuple(tuple(tuple(rgb) for rgb in pal) for pal in load_palette(root / includes[label]))
                    if len(colors) != 8 or any(len(pal) != 4 for pal in colors):
                        raise ValueError(f"Palette swap {label} must have four regular and four overcast palettes")
                    self.palettes[label] = colors

    @staticmethod
    def parse_map(lines: list[str], slots: dict[str, int], map_label: str) -> tuple[PaletteSwap, ...]:
        sections: dict[str, list[tuple[str, str]]] = {}
        callbacks = []
        scope = current = ""
        uses = 0
        for line in lines:
            if not line:
                continue
            label = _LABEL.fullmatch(line)
            if label:
                if not label[1].startswith("."):
                    scope = label[1]
                current = qualify(label[1], scope)
                sections.setdefault(current, [])
            else:
                sections.setdefault(current, []).append((line, scope))
                if line.startswith("callback MAPCALLBACK_CMDQUEUE,"):
                    callbacks.append(qualify(line.split(",", 1)[1].strip(), scope))
                if line.startswith("usepaletteswap "):
                    uses += 1
        tables = []
        for callback in callbacks:
            commands = sections.get(callback)
            if commands is None:
                raise ValueError(f"Unresolved palette callback {callback} in {map_label}")
            # At the audited target these setup callbacks are unconditional. Do
            # not silently ignore future script branches or multiple activations.
            if not any(line.startswith("usepaletteswap ") for line, _ in commands):
                continue
            if len(commands) != 2 or commands[1][0] != "endcallback" or not commands[0][0].startswith("usepaletteswap "):
                raise ValueError(f"Unsupported palette callback control flow in {map_label}: {callback}")
            command, scope = commands[0]
            tables.append(qualify(command.split()[1], scope))
        if len(tables) != 1 or uses != 1:
            raise ValueError(f"Expected one resolved palette-swap setup callback in {map_label}; found {uses} commands, {len(tables)} tables")
        table = sections.get(tables[0])
        if table is None:
            raise ValueError(f"Unresolved palette-swap table {tables[0]} in {map_label}")
        swaps = []
        terminated = False
        for line, _ in table:
            if line == "db -1":
                terminated = True
                break
            if not line.startswith("paletteswap "):
                raise ValueError(f"Unsupported palette-swap data in {map_label}: {line}")
            args = [arg.strip() for arg in line[len("paletteswap "):].split(",")]
            if len(args) != 7 or args[4] not in slots:
                raise ValueError(f"Invalid palette-swap entry in {map_label}: {line}")
            bounds = [number(arg) for arg in args[:4]]
            if not all(0 <= n <= 255 for n in bounds) or bounds[0] >= bounds[1] or bounds[2] >= bounds[3]:
                raise ValueError(f"Invalid palette-swap rectangle in {map_label}: {line}")
            swaps.append(PaletteSwap(*bounds, slots[args[4]],
                                     None if args[5] == "NULL" else args[5],
                                     None if args[6] == "NULL" else args[6]))
        if not terminated or not 1 <= len(swaps) <= 8:
            raise ValueError(f"Invalid palette-swap list in {map_label}")
        return tuple(swaps)

    def resolve(self, label: str, time_of_day: int, overcast: bool) -> tuple[ResolvedSwap, ...]:
        index = (time_of_day & 3) + (4 if overcast else 0)
        return tuple(ResolvedSwap(swap,
                                 self.palettes[swap.outside][index] if swap.outside else None,
                                 self.palettes[swap.inside][index] if swap.inside else None)
                     for swap in self.maps.get(label, ()))

    def metadata(self, label: str) -> list[dict]:
        return [asdict(entry) for entry in self.maps.get(label, ())]
