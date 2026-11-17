"""Polished Crystal's banked tileframe command stream.

One call to step executes one VBlank command. Callers provide game state and
hardware counters explicitly; this module never substitutes random weather or
pretends the hardware divider is the tile animation timer.
"""
from dataclasses import dataclass
from hashlib import sha256
from pathlib import Path
import re


FRAME_MS = 1000 * 70224 / 4194304


@dataclass(frozen=True)
class Command:
    function: str
    bank: int = 0
    tile: int | None = None


@dataclass(frozen=True)
class Context:
    vblank: int
    divider: int
    time: int = 1
    spinning: bool = False
    forest_restless: bool = False
    judge_active: bool = False
    darkness: bool = False
    bgp: int = 0xe4


@dataclass(frozen=True)
class CopySpec:
    source: str | int
    count: int
    period: int
    repeat: int = 1
    phase: int = 0
    sequence: tuple[int, ...] | None = None


# These are ports of the source routines, not timings inferred from PNG sizes.
COPY_SPECS = {
    "AnimateFountainTile": CopySpec("fountain", 1, 8, sequence=(0, 1, 2, 3, 2, 3, 4, 0)),
    "AnimateWaterTile": CopySpec("water_johto", 1, 4, 2),
    "AnimateCaveWaterTile": CopySpec("water_cave", 1, 4, 2),
    "AnimateRockTiles": CopySpec("rocks", 3, 4, 2),
    "AnimateBuoyTiles": CopySpec("buoy", 4, 4, 2),
    "AnimateKantoBuoyTiles": CopySpec("buoy_kanto", 4, 8),
    "AnimateRainTiles": CopySpec("rain", 2, 8),
    "AnimateKantoWaterTile": CopySpec("water_kanto", 1, 8),
    "AnimateFarawayWaterTiles": CopySpec("water_faraway", 2, 8),
    "AnimateFlowerTile": CopySpec("flower_johto", 1, 2, 2),
    "AnimateKantoFlowerTile": CopySpec("flower_kanto", 1, 4, 2),
    "AnimateLavaBubbleTile1": CopySpec("lava", 1, 4, 2, 2),
    "AnimateLavaBubbleTile2": CopySpec("lava", 1, 4, 2),
    "AnimateBigStarTile1": CopySpec(0x45, 1, 4, 2, 2),
    "AnimateBigStarTile2": CopySpec(0x45, 1, 4, 2),
    "AnimateSmallStarsTile1": CopySpec(0x49, 1, 4, 2, 2),
    "AnimateSmallStarsTile2": CopySpec(0x49, 1, 4, 2),
    "AnimateDoubleStarTile": CopySpec(0x4d, 1, 2, 2),
    "AnimateWaterBubbleTiles": CopySpec(0x8b, 2, 8),
    "AnimateWhirlpoolTiles": CopySpec("whirlpool", 4, 4, 2),
    "AnimateTinyWaterTiles": CopySpec(0x4a, 4, 2, 2),
    "AnimateTinyRockTiles": CopySpec(0x52, 4, 2, 2),
    "AnimateLCDTile": CopySpec(0x20, 1, 8),
    "AnimateWaterfallTiles": CopySpec("waterfall", 2, 4),
    "AnimateGameCornerTiles": CopySpec("game_corner", 4, 2, 2),
    "AnimateFireTiles": CopySpec(0x77, 2, 4),
    "AnimateTorchTile": CopySpec(0x11, 1, 2, 2),
}
for number, source, count in ((1, 0x2d, 4), (2, 0x41, 3), (3, 0x51, 3), (4, 0x61, 3)):
    COPY_SPECS[f"AnimateTowerPillarTiles{number}"] = CopySpec(
        source, count, 8, 4, sequence=(0, 1, 2, 3, 4, 3, 2, 1))

SPECIAL = {
    "DoNothing", "DoneTileAnimation", "StandingTileFrame", "StandingTileFrame8",
    "ScrollFourTilesUpDownLeftRight", "AnimateSpinnerTile", "AnimateTurbineTiles",
    "AnimateForestTreeTiles", "AnimateLampLightTiles", "AnimateJudgeMachineTiles",
    "AnimateTubeLightTiles", "FlickeringCaveEntrancePalette", "CycleJudgeMachinePalette",
}
NO_DESTINATION = {
    "DoNothing", "DoneTileAnimation", "StandingTileFrame", "StandingTileFrame8",
    "FlickeringCaveEntrancePalette", "CycleJudgeMachinePalette",
}


def parse_tables(path: Path) -> dict[str, tuple[Command, ...]]:
    tables = {}
    labels = []
    commands = []

    def flush():
        if not commands or commands[-1].function != "DoneTileAnimation":
            raise ValueError(f"Unterminated tile animation: {labels}")
        for label in labels:
            if label in tables:
                raise ValueError(f"Duplicate tile animation: {label}")
            tables[label] = tuple(commands)

    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.split(";", 1)[0].strip()
        label = re.fullmatch(r"(Tileset\w+)Anim::", line)
        if label:
            if commands:
                flush()
                labels, commands = [], []
            labels.append(label[1])
        elif labels and line:
            match = re.fullmatch(r"tileframe (\w+)(?:,\s*\$([01]):([0-9a-fA-F]{2}))?", line)
            if not match:
                raise ValueError(f"Unsupported tileframe syntax: {line}")
            name = match[1]
            if name not in COPY_SPECS and name not in SPECIAL:
                raise ValueError(f"Unsupported tile animation command: {name}")
            tile = int(match[3], 16) if match[3] else None
            if (tile is None) != (name in NO_DESTINATION):
                raise ValueError(f"Unexpected tileframe destination: {line}")
            if commands and commands[-1].function == "DoneTileAnimation":
                raise ValueError(f"Unreachable tileframe: {line}")
            commands.append(Command(name, int(match[2] or 0), tile))
    if labels:
        flush()
    if not tables:
        raise ValueError("No tileframe animation tables found")
    return tables


def encode_tiles(tiles) -> bytes:
    data = bytearray()
    for tile in tiles:
        if len(tile) != 64 or any(value not in range(4) for value in tile):
            raise ValueError("Invalid 2bpp tile")
        for row in range(8):
            pixels = tile[row * 8:(row + 1) * 8]
            for bit in (0, 1):
                data.append(sum(((pixel >> bit) & 1) << (7 - x) for x, pixel in enumerate(pixels)))
    return bytes(data)


def repository_sources(root: Path) -> dict[str, bytes]:
    # Deferred imports avoid an import cycle when used by render_map's CLI.
    import atlas_common
    from render_map import _decode_tiles_from_png
    png = atlas_common.png_module(root)
    names = {spec.source for spec in COPY_SPECS.values() if isinstance(spec.source, str)} | {"turbine"}
    return {name: encode_tiles(_decode_tiles_from_png(root / f"gfx/tilesets/animations/{name}.png", png))
            for name in names}


class Machine:
    """Stateful VRAM writes plus explicit palette changes for one tileset."""

    def __init__(self, commands: tuple[Command, ...], banks: tuple[bytes, bytes],
                 sources: dict[str, bytes], palette: list[list[tuple[int, int, int]]],
                 judge_colors: tuple[tuple[tuple[int, int, int], ...], ...] = ()):
        if not commands or commands[-1].function != "DoneTileAnimation":
            raise ValueError("Animation must end with DoneTileAnimation")
        if any(len(bank) > 4096 or len(bank) % 16 for bank in banks):
            raise ValueError("Invalid tile bank size")
        self.commands = commands
        self.banks = [bytearray(bank.ljust(4096, b"\0")) for bank in banks]
        self.sources = sources
        self.palette = [list(row) for row in palette]
        self.base_palette = [list(row) for row in palette]
        self.judge_colors = judge_colors
        self.timer = 0
        self.pc = 0

    def _copy(self, command: Command, source: bytes, offset: int, count: int):
        if command.tile is None or command.tile + count > 256:
            raise ValueError(f"Invalid animation destination: {command}")
        data = source[offset:offset + count * 16]
        if offset < 0 or len(data) != count * 16:
            raise ValueError(f"Animation source out of bounds: {command}, offset={offset}")
        start = command.tile * 16
        self.banks[command.bank][start:start + len(data)] = data

    def step(self, context: Context) -> tuple[dict[tuple[int, int], bytes], dict[tuple[int, int], tuple[int, int, int]]]:
        """Return only changed tiles/colors; execute no commands speculatively."""
        before = [bytes(bank) for bank in self.banks]
        previous_colors = [list(row) for row in self.palette]
        command = self.commands[self.pc]
        name = command.function
        self.pc += 1
        bank = bytes(self.banks[command.bank])
        if name in COPY_SPECS:
            spec = COPY_SPECS[name]
            frame = (self.timer // spec.repeat + spec.phase) % spec.period
            if spec.sequence:
                frame = spec.sequence[frame]
            source = self.sources[spec.source] if isinstance(spec.source, str) else bank
            offset = 0 if isinstance(spec.source, str) else spec.source * 16
            self._copy(command, source, offset + frame * spec.count * 16, spec.count)
        elif name == "DoneTileAnimation":
            self.pc = 0
        elif name == "StandingTileFrame8":
            self.timer = (self.timer + 1) & 7
        elif name == "StandingTileFrame":
            self.timer = (self.timer + 1) & 255
        elif name == "AnimateSpinnerTile":
            self._copy(command, bank, (8 + ((self.timer >> 1) & 1 if context.spinning else 0)) * 16, 1)
        elif name == "AnimateTurbineTiles":
            self._copy(command, self.sources["turbine"], (context.vblank & 1) * 64, 4)
        elif name == "AnimateForestTreeTiles":
            if context.forest_restless:
                self._copy(command, bank, 0x44 * 16 + (self.timer & 1) * 64, 4)
        elif name == "AnimateLampLightTiles":
            if (context.time & 3) >= 2:  # NITE=2, EVE=3
                self._copy(command, bank, (0x66 + ((context.vblank >> 1) & 1)) * 16, 1)
        elif name == "AnimateJudgeMachineTiles":
            # rDIV supplies a BYTE offset, including non-tile-aligned copies.
            self._copy(command, bank, 0x5c * 16 + (context.divider & 62), 2)
        elif name == "AnimateTubeLightTiles":
            self._copy(command, bank, (0x48 + (4 if context.vblank & 2 else 0)) * 16, 4)
        elif name == "ScrollFourTilesUpDownLeftRight":
            if command.tile is None or command.tile > 252:
                raise ValueError(f"Invalid scroll destination: {command}")
            for i in range(4):
                start = (command.tile + i) * 16
                tile = bank[start:start + 16]
                if i == 0:
                    tile = tile[2:] + tile[:2]
                elif i == 1:
                    tile = tile[-2:] + tile[:-2]
                elif i == 2:
                    tile = bytes(((value << 1) | (value >> 7)) & 255 for value in tile)
                else:
                    tile = bytes((value >> 1) | ((value & 1) << 7) for value in tile)
                self.banks[command.bank][start:start + 16] = tile
        elif name == "FlickeringCaveEntrancePalette":
            if context.darkness and context.bgp == 0xe4:
                self.palette[4][0] = self.base_palette[4][1 if context.vblank & 2 else 0]
        elif name == "CycleJudgeMachinePalette":
            if context.judge_active:
                if len(self.judge_colors) != 16 or any(len(row) != 2 for row in self.judge_colors):
                    raise ValueError("Judge palette cycle requires 16 pairs of colors")
                self.palette[6][1:3] = self.judge_colors[self.timer & 15]
        elif name != "DoNothing":
            raise ValueError(f"Unsupported animation command: {name}")
        tiles = {(b, t): bytes(bank[t * 16:(t + 1) * 16])
                 for b, bank in enumerate(self.banks) for t in range(256)
                 if bank[t * 16:(t + 1) * 16] != before[b][t * 16:(t + 1) * 16]}
        colors = {(p, c): color for p, row in enumerate(self.palette) for c, color in enumerate(row)
                  if color != previous_colors[p][c]}
        return tiles, colors


@dataclass(frozen=True)
class Cycle:
    banks: tuple[bytes, bytes]
    palette: tuple[tuple[tuple[int, int, int], ...], ...]
    # Each entry is one VBlank's changes; empty entries still consume one frame.
    changes: tuple[tuple[dict, dict], ...]
    warmup_frames: int


def capture_cycle(machine: Machine, state: Context, max_frames: int = 32768) -> Cycle:
    """Capture a steady loop, retaining command ordering and empty VBlanks.

    rDIV is sampled at a fixed phase of CGB double-speed frames. Actual ROM
    execution can sample at a different phase because of earlier VBlank work;
    this is a reproducible representative animation, not CPU-cycle emulation.
    """
    functions = {command.function for command in machine.commands}
    timer_period = 32 if any(name.startswith("AnimateTowerPillar") for name in functions) else 16 if "CycleJudgeMachinePalette" in functions else 8
    counter_period = 512 if "AnimateJudgeMachineTiles" in functions else 4
    initial_banks = tuple(bytes(bank) for bank in machine.banks)
    initial_palette = tuple(tuple(row) for row in machine.palette)
    seen = {}
    changes = []
    for frame in range(max_frames):
        palette = tuple(tuple(row) for row in machine.palette)
        key = (machine.pc, machine.timer % timer_period, frame % counter_period,
               sha256(machine.banks[0] + machine.banks[1]).digest(), palette)
        if key in seen:
            start = seen[key]
            banks = [bytearray(bank) for bank in initial_banks]
            colors = [list(row) for row in initial_palette]
            for tile_changes, color_changes in changes[:start]:
                for (bank, tile), value in tile_changes.items():
                    banks[bank][tile * 16:(tile + 1) * 16] = value
                for (slot, color), value in color_changes.items():
                    colors[slot][color] = value
            return Cycle(tuple(bytes(bank) for bank in banks), tuple(tuple(row) for row in colors),
                         tuple(changes[start:]), start)
        seen[key] = frame
        context = Context(
            vblank=(state.vblank + frame) & 255,
            divider=(state.divider + frame * 70224 * 2 // 256) & 255,
            time=state.time, spinning=state.spinning, forest_restless=state.forest_restless,
            judge_active=state.judge_active, darkness=state.darkness, bgp=state.bgp)
        changes.append(machine.step(context))
    raise ValueError(f"Tile animation did not repeat within {max_frames} frames")


def judge_palette(root: Path) -> tuple[tuple[tuple[int, int, int], ...], ...]:
    """Read the color-build cycle in original 5-bit RGB channel units."""
    pairs = []
    for raw in (root / "gfx/stats/ev_iv_cycle.pal").read_text(encoding="utf-8").splitlines():
        line = raw.split(";", 1)[0].strip()
        if not line.startswith("RGB "):
            continue
        values = [int(value.strip()) for value in line[4:].split(",")]
        if len(values) != 6 or any(value not in range(32) for value in values):
            raise ValueError(f"Unsupported Judge palette row: {line}")
        pairs.append((tuple(values[:3]), tuple(values[3:])))
    if len(pairs) != 16:
        raise ValueError("Judge palette must have 16 color pairs")
    return tuple(pairs)
