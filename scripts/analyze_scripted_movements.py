#!/usr/bin/env python3
"""Audit scripted movements and teleports across map scripts.

Goals:
- Flag sprite-limit risks during scripted sequences (>40 total, >10 per scanline)
- Flag potential follower collisions (NPC runs over follower, or vice versa)

Inputs:
- external/polishedcrystal/maps/*.asm: map scripts to parse
- maps/object_metadata.json: object facings, movements, and per-map object positions
- maps/warp_metadata.json: collision grids, warp graph, overworld flags

Outputs:
- Human-readable summary to stdout
- Optional JSON report via --json argument

Note: This is a pragmatic v1. It focuses on deterministic scripted movement
paths referenced by coord events and map callbacks. It simulates movement
within a single script label with limited control-flow understanding, and
computes sprite usage using a faithful per-8px-tile scanline counter for the
player, follower, the moving NPC, and currently-visible static NPCs.

It intentionally avoids modeling generic NPC wandering patterns (that logic
exists in the web app TypeScript). Future versions can import that metadata or
mirror the movement model if needed.
"""
from __future__ import annotations

import argparse
import base64
from copy import deepcopy
from functools import lru_cache
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import atlas_common
from event_state import initial_flags
from generate_object_metadata import MACRO_EXPANSIONS, gather_constants, split_arguments
from object_schedule import ObjectSchedule


# ---------------------------- Constants ----------------------------

SCREEN_WIDTH_PX = 160
SCREEN_HEIGHT_PX = 144
CAMERA_ANCHOR_X = SCREEN_WIDTH_PX // 2  # 80
CAMERA_ANCHOR_Y = SCREEN_HEIGHT_PX // 2 - 8  # 64

DEFAULT_SCANLINE_LIMIT = 10
DEFAULT_TOTAL_LIMIT = 40
# ---------------------------- Event tri-state ----------------------------

EV_TRUE = 1
EV_FALSE = 0
EV_UNKNOWN = -1

def _ev_get(state: Dict[str, int], ev: str) -> int:
    return state.get(ev, EV_UNKNOWN)

def _ev_set(state: Dict[str, int], ev: str, val: int) -> None:
    if val not in (EV_TRUE, EV_FALSE, EV_UNKNOWN):
        return
    state[ev] = val



# ---------------------------- Data types ----------------------------

@dataclass
class MapCoordEvent:
    x: int
    y: int
    scene: str
    label: str


@dataclass
class MapCallback:
    kind: str  # e.g., MAPCALLBACK_NEWMAP, MAPCALLBACK_TILES, etc
    label: str


@dataclass
class ObjectSpawn:
    label: str  # symbolic constant, e.g., AZALEATOWN_RIVAL
    index: Optional[int]
    x: int
    y: int
    script_label: Optional[str] = None  # label executed when talking to NPC
    visible: bool = True
    hide_event: Optional[str] = None  # event flag controlling visibility (hidden when set)


@dataclass
class MovementBlock:
    name: str
    # Sequence of tokens like 'step_left', 'step_up', 'turn_head_left', ...
    tokens: List[str]


@dataclass
class ScriptCommand:
    opcode: str
    args: Tuple[str, ...] = field(default_factory=tuple)
    line_no: Optional[int] = None


@dataclass
class ScriptLabel:
    name: str
    commands: List[ScriptCommand] = field(default_factory=list)


@dataclass
class ParsedMapScript:
    label: str
    path: Path
    object_constants: List[str]
    object_spawns: Dict[str, ObjectSpawn]
    coord_events: List[MapCoordEvent]
    callbacks: List[MapCallback]
    scenes: List[Tuple[Optional[str], Optional[str]]]
    previous_warp_checks: Dict[str, int]
    movement_blocks: Dict[str, MovementBlock]
    script_labels: Dict[str, ScriptLabel]
    schedule: Optional[ObjectSchedule] = None


@dataclass
class CollisionGrid:
    width_cells: int
    height_cells: int
    cells: bytes  # each cell is permission value 0..n from collision_permissions table

    def get(self, x: int, y: int) -> int:
        if x < 0 or y < 0 or x >= self.width_cells or y >= self.height_cells:
            return 0
        return self.cells[y * self.width_cells + x]


@dataclass
class WarpMeta:
    is_overworld: bool
    collision: Optional[CollisionGrid]


@dataclass
class ObjectFacingProfile:
    tiles: List[Tuple[int, int]]  # (dx, dy) in pixels for each 8x8 tile origin


@dataclass
class AuditIssue:
    map_label: str
    file: str
    kind: str  # scanline-limit | total-limit | follower-collision | cross-map
    severity: str  # at-limit | exceeds | warn
    details: Dict[str, object]


# ---------------------------- Utilities ----------------------------

def _strip_comment(line: str) -> str:
    return line.split(";", 1)[0].rstrip()


def _numeric(token: str) -> Optional[int]:
    t = token.strip()
    if not t:
        return None
    neg = False
    if t[0] in "+-":
        neg = t[0] == "-"
        t = t[1:]
    base = 10
    if t.startswith("$"):
        base = 16
        t = t[1:]
    elif t.startswith("%"):
        base = 2
        t = t[1:]
    try:
        val = int(t, base)
    except ValueError:
        return None
    return -val if neg else val


def _parse_object_const_block(lines: List[str], start: int) -> Tuple[List[str], int]:
    constants: List[str] = []
    i = start
    while i < len(lines):
        code = _strip_comment(lines[i]).strip()
        if not code:
            i += 1
            continue
        if code.startswith("object_const_def"):
            i += 1
            continue
        if code.startswith("const "):
            parts = code.split()
            if len(parts) >= 2:
                constants.append(parts[1])
            i += 1
            continue
        # End of block when we hit a non-const and non-empty token
        break
    return constants, i


def _parse_object_events(lines: List[str], constants: List[str]) -> Dict[str, ObjectSpawn]:
    """Parse def_object_events section, mapping constants -> (x,y, script_label).

    The order of object_event declarations corresponds to the order of constants
    defined by object_const_def. We'll associate by index.
    """
    spawns: Dict[str, ObjectSpawn] = {}
    # Extract only the def_object_events block
    in_section = False
    decls: List[Tuple[Optional[int], Optional[int], Optional[str], Optional[str]]] = []  # x,y,script_label,hide_event
    for raw in lines:
        code = _strip_comment(raw).strip()
        if not code:
            continue
        if code.startswith("def_object_events"):
            in_section = True
            continue
        if in_section and (code.startswith("def_") or code.startswith("object_const_def") or code.endswith(":")):
            break
        if not in_section:
            continue
        words = code.split(None, 1)
        if len(words) != 2 or words[0] not in MACRO_EXPANSIONS:
            continue
        args, _ = MACRO_EXPANSIONS[words[0]](split_arguments(words[1]))
        script_label = args[10] if len(args) > 10 and _looks_like_label(args[10]) else None
        hide_event = args[-1] if args[-1].startswith("EVENT_") else None
        decls.append((_numeric(args[0]), _numeric(args[1]), script_label, hide_event))
    # Associate by order with constants
    names = list(constants)
    names.extend(f"OBJECT_{i + 1}" for i in range(len(names), len(decls)))
    for i, const_name in enumerate(names):
        if i < len(decls):
            x, y, script_label, hide_event = decls[i]
            if x is None or y is None:
                continue
            spawns[const_name] = ObjectSpawn(
                label=const_name,
                index=i + 1,
                x=x,
                y=y,
                script_label=script_label,
                visible=True,
                hide_event=hide_event,
            )
    return spawns


_COORD_EVENT_RE = re.compile(r"^coord_event\s+(\d+)\s*,\s*(\d+)\s*,\s*([^,]+?)\s*,\s*([\w\.]+)")


def _parse_coord_events(lines: List[str]) -> List[MapCoordEvent]:
    out: List[MapCoordEvent] = []
    in_section = False
    for raw in lines:
        code = _strip_comment(raw).strip()
        if not code:
            continue
        if code.startswith("def_coord_events"):
            in_section = True
            continue
        if in_section and code.startswith("def_"):
            break
        if not in_section:
            continue
        m = _COORD_EVENT_RE.match(code)
        if m:
            out.append(MapCoordEvent(int(m[1]), int(m[2]), m[3], m[4]))
    return out


_CALLBACK_RE = re.compile(r"^callback\s+([A-Z0-9_]+)\s*,\s*([\w\.]+)")


def _parse_callbacks(lines: List[str]) -> List[MapCallback]:
    out: List[MapCallback] = []
    in_section = False
    for raw in lines:
        code = _strip_comment(raw).strip()
        if not code:
            continue
        if code.startswith("def_callbacks"):
            in_section = True
            continue
        if in_section and code.startswith("def_"):
            break
        if not in_section:
            continue
        m = _CALLBACK_RE.match(code)
        if m:
            out.append(MapCallback(kind=m.group(1), label=m.group(2)))
    return out


@lru_cache(maxsize=4)
def _movement_commands(macros: Path) -> set[str]:
    if macros.is_file():
        return set(re.findall(r"^MACRO\s+(\w+)", macros.read_text(encoding="utf-8"), re.M | re.I))
    # Small standalone map fixtures can omit the upstream macro definitions.
    return set(_STEP_DELTAS) | {
        "turn_head_down", "turn_head_up", "turn_head_left", "turn_head_right",
        "fix_facing", "remove_fixed_facing", "set_sliding", "remove_sliding",
        "step_end", "step_loop", "step_sleep", "hide_object", "show_object", "remove_object",
        *(f"step_sleep_{i}" for i in range(1, 9)),
    }


def _parse_movement_blocks(lines: List[str], commands: set[str]) -> Dict[str, MovementBlock]:
    blocks: Dict[str, MovementBlock] = {}
    offsets: Dict[str, int] = {}
    tokens: List[str] = []
    repeats: List[Tuple[int, int]] = []

    def finish() -> None:
        for label, offset in offsets.items():
            if offset < len(tokens):
                blocks[label] = MovementBlock(label, tokens[offset:])
        offsets.clear()
        tokens.clear()
        repeats.clear()

    for raw in lines:
        code = _strip_comment(raw).strip()
        if not code:
            continue
        if code.endswith(":"):
            # Adjacent labels alias the same address. A later label can also
            # start in the middle of a movement used by an earlier label.
            offsets[code[:-1]] = len(tokens)
            continue
        if not offsets:
            continue
        parts = code.split(None, 1)
        name = parts[0]
        if name.lower() == "rept" and len(parts) == 2:
            count = _numeric(parts[1])
            if count is not None and count >= 0:
                repeats.append((len(tokens), count))
                continue
        if name.lower() == "endr" and repeats:
            start, count = repeats.pop()
            tokens[start:] = tokens[start:] * count
            continue
        if name in commands:
            tokens.append(name)
            if name != "step_end" or repeats:
                continue
        finish()
    finish()
    return blocks


_SCRIPT_CMD_RE = re.compile(
    r"^(" 
    r"applymovement|applymovementlasttalked|applyonemovement|"
    r"moveobject|writeobjectxy|appear|disappear|warpfacing|warp|faceobject|turnobject|"
    r"follow|stopfollow|follownotexact|setlasttalked|"
    r"setevent|clearevent|checkevent|setflag|clearflag|checkflag|yesorno|verticalmenu|"
    r"setmapscene|setscene|checkscene|sdefer|readvar|readmem|loadmem|(?:verbose)?giveitems?(?:_unsafe)?|verbosegiveitemvar|"
    r"opentext|closetext|showtext|"
    r"sjumpfwd|sjump|farsjump|memjump|jump|priorityjump|jumpstd|stopandsjump|"
    r"scallfwd|scall|farscall|memcall|call|callasm|callstd|"
    r"end|endall|reloadend|endcallback|endtext|done|"
    r"newloadmap|reloadmap|reloadmapafterbattle|warpcheck|"
    r"if\w+"
    r")\b(.*)"
)


_ITEM_OPERANDS = {"giveitem": 1, "giveitems": 2, "verbosegiveitem": 1,
                  "verbosegiveitems": 2, "verbosegiveitemvar": 2}
_CONDITIONAL_TEXT_END = {"iffalse_endtext", "iftrue_endtext", "iffalse_jumpopenedtext", "iftrue_jumpopenedtext"}


def _script_commands(code: str, line_no: int) -> Iterable[ScriptCommand]:
    match = _SCRIPT_CMD_RE.fullmatch(code)
    if not match:
        return
    op, rest = match.groups()
    args = tuple(arg.strip() for arg in rest.split(",") if arg.strip())
    count = _ITEM_OPERANDS.get(op)
    if count is not None and len(args) > count:
        handler = ", ".join(args[count:])
        if _SCRIPT_CMD_RE.fullmatch(handler):
            # RGBDS expands the trailing arguments into a separate command.
            yield ScriptCommand(op, args[:count], line_no)
            yield from _script_commands(handler, line_no)
            return
    yield ScriptCommand(op, args, line_no)


def _parse_script_labels(lines: List[str]) -> Dict[str, ScriptLabel]:
    labels: Dict[str, ScriptLabel] = {}
    current: Optional[str] = None
    for idx, raw in enumerate(lines, start=1):
        code = _strip_comment(raw).strip()
        if not code:
            continue
        if code.endswith(":"):
            current = code[:-1]
            labels.setdefault(current, ScriptLabel(name=current))
            continue
        if current:
            labels[current].commands.extend(_script_commands(code, idx))
    return labels


def parse_map_script(path: Path) -> ParsedMapScript:
    source = path.read_text(encoding="utf-8")
    schedule = ObjectSchedule.parse(source)
    lines = list(atlas_common.scoped_map_lines(source.splitlines()))
    label = path.stem
    # Extract object constants
    object_constants: List[str] = []
    for i, raw in enumerate(lines):
        code = _strip_comment(raw).strip()
        if code.startswith("object_const_def"):
            consts, _ = _parse_object_const_block(lines, i)
            object_constants = consts
            break
    # Object spawns from object_event section
    spawns = _parse_object_events(lines, object_constants)
    coord_events = _parse_coord_events(lines)
    callbacks = _parse_callbacks(lines)
    movement_blocks = _parse_movement_blocks(lines, _movement_commands(path.parent.parent / "macros/scripts/movement.asm"))
    script_labels = _parse_script_labels(lines)
    scenes = []
    for line in lines:
        if match := re.fullmatch(r"scene_script\s+([\w.]+)(?:,\s*(\w+))?", line):
            scenes.append((match[2], match[1]))
        elif match := re.fullmatch(r"scene_const\s+(\w+)", line):
            scenes.append((match[1], None))
    # These assembly helpers return wPrevWarp minus a constant in hScriptVar.
    # Honor the exact instruction sequence, leaving other helpers unknown.
    previous_warp_checks = {
        m[1]: m[2].count("dec a") for m in re.finditer(
            r"^([\w.]+):\nld hl, wPrevWarp\nld a, \[hl\]\n((?:dec a\n)*)ldh \[hScriptVar\], a\nret$",
            "\n".join(line for line in lines if line), re.M,
        )
    }
    return ParsedMapScript(
        label=label,
        path=path,
        object_constants=object_constants,
        object_spawns=spawns,
        coord_events=coord_events,
        callbacks=callbacks,
        scenes=scenes,
        previous_warp_checks=previous_warp_checks,
        movement_blocks=movement_blocks,
        script_labels=script_labels,
        schedule=schedule,
    )


# ---------------------------- Metadata loading ----------------------------


def load_warp_metadata(path: Path) -> Tuple[dict, dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("maps", {}), data


def load_object_metadata(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def collision_grid_from_meta(map_meta: dict, aux: dict) -> Optional[CollisionGrid]:
    coll = map_meta.get("collision")
    if not coll:
        return None
    width = int(coll.get("width_cells", 0) or 0)
    height = int(coll.get("height_cells", 0) or 0)
    enc = coll.get("encoding")
    if enc != "base64":
        return None
    cells_b64 = coll.get("cells")
    if not cells_b64:
        return None
    raw = base64.b64decode(cells_b64)
    if len(raw) != width * height:
        return None
    return CollisionGrid(width_cells=width, height_cells=height, cells=raw)


def get_warp_meta(warp_maps: dict, map_label: str) -> WarpMeta:
    entry = warp_maps.get(map_label) or {}
    is_overworld = bool(entry.get("is_overworld"))
    grid = collision_grid_from_meta(entry, warp_maps)
    return WarpMeta(is_overworld=is_overworld, collision=grid)


def build_facing_profile(object_meta: dict, facing_key: Optional[str]) -> Optional[ObjectFacingProfile]:
    facings = object_meta.get("facings", {})
    if not facing_key:
        return None
    spec = facings.get(facing_key)
    if not spec:
        return None
    tiles = []
    entries = spec.get("entries") or spec.get("tiles") or []
    for t in entries:
        dx = int(t.get("dx", 0) or 0)
        dy = int(t.get("dy", 0) or 0)
        tiles.append((dx, dy))
    if not tiles:
        return None
    return ObjectFacingProfile(tiles=tiles)


def default_player_facing_key(object_meta: dict) -> Optional[str]:
    d = object_meta.get("default_facing_for_direction", {})
    return d.get("DOWN") or d.get("down") or d.get("Down") or "FACING_STEP_DOWN_0"


# ---------------------------- Sprite counting ----------------------------


def rects_intersect(ax: int, ay: int, aw: int, ah: int, bx: int, by: int, bw: int, bh: int) -> bool:
    return ax < bx + bw and ax + aw > bx and ay < by + bh and ay + ah > by


def clamp_scanline_y(y: float) -> int:
    if y < 0:
        return 0
    if y >= SCREEN_HEIGHT_PX:
        return SCREEN_HEIGHT_PX - 1
    return int(y)


def compute_viewport_for_player(cell_x: int, cell_y: int, cell_px: int) -> Tuple[int, int, int, int]:
    px_x = cell_x * cell_px
    px_y = cell_y * cell_px
    horizontal_bias = cell_px
    return (
        px_x - (CAMERA_ANCHOR_X - horizontal_bias),
        px_y - CAMERA_ANCHOR_Y,
        SCREEN_WIDTH_PX,
        SCREEN_HEIGHT_PX,
    )


def count_sprite_usage(
    map_label: str,
    player_cell: Tuple[int, int],
    moving_npc_cell: Optional[Tuple[int, int]],
    static_npcs: Optional[List[Tuple[int, int]]],
    follower_cell_override: Optional[Tuple[int, int]],
    object_meta: dict,
    warp_meta: WarpMeta,
    include_follower: bool,
    include_weather: bool,
    scanline_limit: int,
    total_limit: int,
    *,
    context: Optional[Dict[str, object]] = None,
) -> List[AuditIssue]:
    issues: List[AuditIssue] = []
    cell_px = int(object_meta.get("event_cell_pixel_size", 16) or 16)
    vx, vy, vw, vh = compute_viewport_for_player(player_cell[0], player_cell[1], cell_px)

    scanline_counts = [0] * SCREEN_HEIGHT_PX
    total_sprites = 0

    # Player
    player_facing_key = default_player_facing_key(object_meta)
    player_profile = build_facing_profile(object_meta, player_facing_key)
    if player_profile:
        ax = player_cell[0] * cell_px
        ay = player_cell[1] * cell_px
        for dx, dy in player_profile.tiles:
            tx = ax + dx
            ty = ay + dy
            if not rects_intersect(vx, vy, vw, vh, tx, ty, 8, 8):
                continue
            total_sprites += 1
            sy = clamp_scanline_y(ty - vy)
            ey = clamp_scanline_y(ty + 7 - vy)
            for y in range(sy, ey + 1):
                scanline_counts[y] += 1

    # Weather reservation (overworld only)
    if include_weather and warp_meta.is_overworld:
        total_sprites += 1
        for y in range(SCREEN_HEIGHT_PX):
            scanline_counts[y] += 1

    # Follower contribution
    if include_follower and player_profile:
        def add_profile_at(cx: int, cy: int) -> Tuple[int, List[int]]:
            added_total = 0
            added_scan = [0] * SCREEN_HEIGHT_PX
            ax = cx * cell_px
            ay = cy * cell_px
            for dx, dy in player_profile.tiles:
                tx = ax + dx
                ty = ay + dy
                if not rects_intersect(vx, vy, vw, vh, tx, ty, 8, 8):
                    continue
                added_total += 1
                sy = clamp_scanline_y(ty - vy)
                ey = clamp_scanline_y(ty + 7 - vy)
                for y in range(sy, ey + 1):
                    added_scan[y] += 1
            return added_total, added_scan

        if follower_cell_override is not None:
            add_total, add_scan = add_profile_at(follower_cell_override[0], follower_cell_override[1])
            total_sprites += add_total
            for y in range(SCREEN_HEIGHT_PX):
                scanline_counts[y] += add_scan[y]
        elif warp_meta.collision:
            # Fallback heuristic when player isn't moving: choose adjacent cell giving max visible tiles
            candidates = [
                (player_cell[0], player_cell[1] - 1),
                (player_cell[0], player_cell[1] + 1),
                (player_cell[0] - 1, player_cell[1]),
                (player_cell[0] + 1, player_cell[1]),
            ]
            def cell_ok(cx: int, cy: int) -> bool:
                return 0 <= cx < warp_meta.collision.width_cells and 0 <= cy < warp_meta.collision.height_cells

            best_total = 0
            per_scan_max = [0] * SCREEN_HEIGHT_PX
            for cx, cy in candidates:
                if not cell_ok(cx, cy):
                    continue
                add_total, add_scan = add_profile_at(cx, cy)
                if add_total > best_total:
                    best_total = add_total
                for y in range(SCREEN_HEIGHT_PX):
                    if add_scan[y] > per_scan_max[y]:
                        per_scan_max[y] = add_scan[y]
            total_sprites += best_total
            for y in range(SCREEN_HEIGHT_PX):
                scanline_counts[y] += per_scan_max[y]

    # Moving NPC at its current cell, if any. Use default facing down.
    if moving_npc_cell is not None:
        npc_profile = player_profile  # Reuse player 2x2 as a fallback; better: resolve by sprite
        if npc_profile:
            ax = moving_npc_cell[0] * cell_px
            ay = moving_npc_cell[1] * cell_px
            for dx, dy in npc_profile.tiles:
                tx = ax + dx
                ty = ay + dy
                if not rects_intersect(vx, vy, vw, vh, tx, ty, 8, 8):
                    continue
                total_sprites += 1
                sy = clamp_scanline_y(ty - vy)
                ey = clamp_scanline_y(ty + 7 - vy)
                for y in range(sy, ey + 1):
                    scanline_counts[y] += 1

    # Static NPCs: include visible non-moving objects present in the viewport
    if static_npcs and player_profile:
        npc_profile = player_profile
        for cx, cy in static_npcs:
            ax = cx * cell_px
            ay = cy * cell_px
            for dx, dy in npc_profile.tiles:
                tx = ax + dx
                ty = ay + dy
                if not rects_intersect(vx, vy, vw, vh, tx, ty, 8, 8):
                    continue
                total_sprites += 1
                sy = clamp_scanline_y(ty - vy)
                ey = clamp_scanline_y(ty + 7 - vy)
                for y in range(sy, ey + 1):
                    scanline_counts[y] += 1

    # Scanline issue
    max_scan = max(scanline_counts)
    if max_scan >= scanline_limit:
        issues.append(
            AuditIssue(
                map_label=map_label,
                file="",
                kind="scanline-limit",
                severity=("exceeds" if max_scan > scanline_limit else "at-limit"),
                details={
                    "count": max_scan,
                    "limit": scanline_limit,
                    "player_cell": list(player_cell),
                    **(context or {}),
                },
            )
        )

    if total_sprites >= total_limit:
        issues.append(
            AuditIssue(
                map_label=map_label,
                file="",
                kind="total-limit",
                severity=("exceeds" if total_sprites > total_limit else "at-limit"),
                details={
                    "count": total_sprites,
                    "limit": total_limit,
                    "player_cell": list(player_cell),
                    **(context or {}),
                },
            )
        )

    return issues


# ---------------------------- Movement simulation ----------------------------


_STEP_DELTAS = {
    # Common step tokens; extend as needed.
    "step_left": (-1, 0),
    "step_right": (1, 0),
    "step_up": (0, -1),
    "step_down": (0, 1),
    "half_step_left": (-0.5, 0),
    "half_step_right": (0.5, 0),
    "half_step_up": (0, -0.5),
    "half_step_down": (0, 0.5),
    # Turn + step tokens
    "turn_step_left": (-1, 0),
    "turn_step_right": (1, 0),
    "turn_step_up": (0, -1),
    "turn_step_down": (0, 1),
    # Fast/run/jump variations move 1 tile visually too in scripted applymovement
    "big_step_left": (-1, 0),
    "big_step_right": (1, 0),
    "big_step_up": (0, -1),
    "big_step_down": (0, 1),
    # Slow step
    "slow_step_left": (-1, 0),
    "slow_step_right": (1, 0),
    "slow_step_up": (0, -1),
    "slow_step_down": (0, 1),
    # Fast step
    "fast_step_left": (-1, 0),
    "fast_step_right": (1, 0),
    "fast_step_up": (0, -1),
    "fast_step_down": (0, 1),
    # Run step
    "run_step_left": (-1, 0),
    "run_step_right": (1, 0),
    "run_step_up": (0, -1),
    "run_step_down": (0, 1),
    "jump_step_left": (-1, 0),
    "jump_step_right": (1, 0),
    "jump_step_up": (0, -1),
    "jump_step_down": (0, 1),
    # Slow/fast jump
    "slow_jump_step_left": (-1, 0),
    "slow_jump_step_right": (1, 0),
    "slow_jump_step_up": (0, -1),
    "slow_jump_step_down": (0, 1),
    "fast_jump_step_left": (-1, 0),
    "fast_jump_step_right": (1, 0),
    "fast_jump_step_up": (0, -1),
    "fast_jump_step_down": (0, 1),
    # Slide steps
    "slide_step_left": (-1, 0),
    "slide_step_right": (1, 0),
    "slide_step_up": (0, -1),
    "slide_step_down": (0, 1),
    "slow_slide_step_left": (-1, 0),
    "slow_slide_step_right": (1, 0),
    "slow_slide_step_up": (0, -1),
    "slow_slide_step_down": (0, 1),
    "fast_slide_step_left": (-1, 0),
    "fast_slide_step_right": (1, 0),
    "fast_slide_step_up": (0, -1),
    "fast_slide_step_down": (0, 1),
    # Stairs steps
    "stairs_step_left": (-1, 0),
    "stairs_step_right": (1, 0),
    "stairs_step_up": (0, -1),
    "stairs_step_down": (0, 1),
    # Paired step (only right defined in macros)
    "paired_step_right": (1, 0),
}


def _simulate_apply_movement(tokens: Sequence[str], start_xy: Tuple[float, float]) -> List[Tuple[float, float]]:
    """Return the sequence of positions including intermediate landing cells.

    Only tokens with positional deltas are applied. Non-positional tokens are ignored.
    """
    x, y = start_xy
    out = []
    for tok in tokens:
        if tok == "step_end":
            break
        delta = _STEP_DELTAS.get(tok)
        if delta:
            x += delta[0]
            y += delta[1]
            out.append((x, y))
    return out


def follower_collision_during_path(
    player_xy: Tuple[int, int],
    npc_path: Sequence[Tuple[int, int]],
    warp_meta: WarpMeta,
) -> bool:
    """Check if npc path hits the follower, assuming player is stationary.

    We consider follower as stationary during an NPC applymovement, located at one
    of the player's adjacent cells at the time the script starts. If the NPC path
    intersects any of those plausible cells, report a collision.
    """
    plausible: List[Tuple[int, int]] = plausible_follower_cells(player_xy, warp_meta)
    plausible_set = set(plausible)
    for step_xy in npc_path:
        if step_xy in plausible_set:
            return True
    return False


def _move_synchronized_followers(followers: Iterable[str], positions: dict[str, tuple[float, float]],
                                 spawns: dict[str, tuple[int, int]], previous: tuple[float, float],
                                 current: tuple[float, float]) -> None:
    """The cart receives the leader's step in the same frame, including half steps."""
    for name in followers:
        origin = positions.get(name, spawns.get(name))
        if origin is not None:
            positions[name] = (origin[0] + current[0] - previous[0],
                               origin[1] + current[1] - previous[1])


def plausible_follower_cells(player_xy: Tuple[int, int], warp_meta: WarpMeta) -> List[Tuple[int, int]]:
    """Return plausible follower positions adjacent to player_xy, constrained by collision grid when available."""
    out: List[Tuple[int, int]] = []
    if warp_meta.collision:
        for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
            cx, cy = player_xy[0] + dx, player_xy[1] + dy
            if 0 <= cx < warp_meta.collision.width_cells and 0 <= cy < warp_meta.collision.height_cells:
                out.append((cx, cy))
    else:
        out = [
            (player_xy[0], player_xy[1] - 1),
            (player_xy[0], player_xy[1] + 1),
            (player_xy[0] - 1, player_xy[1]),
            (player_xy[0] + 1, player_xy[1]),
        ]
    return out


# ---------------------------- Trigger modeling and control flow ----------------------------


_IF_BRANCH_RE = re.compile(r"^if\w+\b.*?(?:,\s*|\s+)([\w\.]+)$", re.IGNORECASE)


def _looks_like_label(token: str) -> bool:
    if not token:
        return False
    if token.startswith('.'):
        return True
    # plain word
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_\.]*$", token))


def _map_script_indices(maps_dir: Path):
    """Collect object ordinals and arrival cells from explicit scene-setting warps."""
    ordinals = {}
    scripted_arrivals = {}
    for path in _iter_map_asm_files(maps_dir):
        source = path.read_text(encoding="utf-8")
        lines = [line.partition(";")[0].strip() for line in source.splitlines()]
        if "object_const_def" in lines:
            names, _ = _parse_object_const_block(lines, lines.index("object_const_def"))
            ordinals.update((name, i) for i, name in enumerate(names, 1))
        code = "\n".join(line for line in lines if line)
        for match in re.finditer(
            r"^setmapscene\s+(\w+),\s*(\w+)\n(?:warp\s+|warpfacing\s+\w+,\s*)\1,\s*(\d+),\s*(\d+)$",
            code, re.M,
        ):
            scripted_arrivals.setdefault((match[1], match[2]), set()).add((int(match[3]), int(match[4])))
    return ordinals, scripted_arrivals


def _is_land_passable(aux_root: dict, cell_value: int) -> bool:
    perms = aux_root.get("collision_permissions") or []
    try:
        code = perms[cell_value]
    except Exception:
        # Fallback: treat 0 as land
        return cell_value == 0
    return code == 0


# ---------------------------- Entrypoints and orchestration ----------------------------


def _iter_map_asm_files(root: Path) -> Iterable[Path]:
    return sorted(root.glob("*.asm"))


def analyze_scripts(
    polished_path: Path,
    object_meta_path: Path,
    warp_meta_path: Path,
    *,
    scope: str = "all",
    time_of_day: str = "day",
    weekday: int = 1,
    include_follower: bool = True,
    include_weather: bool = True,
    scanline_limit: int = DEFAULT_SCANLINE_LIMIT,
    total_limit: int = DEFAULT_TOTAL_LIMIT,
    debug: bool = False,
    assume_set_events: Optional[List[str]] = None,
    assume_clear_events: Optional[List[str]] = None,
    # New ergonomics
    map_filters: Optional[List[str]] = None,
    label_filters: Optional[List[str]] = None,
    scenario: Optional[str] = None,
    event_overrides_path: Optional[Path] = None,
) -> List[AuditIssue]:
    issues: List[AuditIssue] = []
    stats = {
        'maps_scanned': 0,
        'triggers_found': 0,
        'applymovement_processed': 0,
    }
    maps_dir = polished_path / "maps"
    object_ordinals, scripted_arrivals = _map_script_indices(maps_dir)
    object_meta = load_object_metadata(object_meta_path)
    warp_maps, warp_root = load_warp_metadata(warp_meta_path)
    # Build normalized label map to resolve ASM map constants (e.g., FAST_SHIP_1F) to metadata labels (e.g., FastShip1F)
    def _norm_label_key(s: str) -> str:
        return ''.join(ch for ch in s if ch not in {'_', ' '}).upper()
    warp_label_by_norm: Dict[str, str] = { _norm_label_key(lbl): lbl for lbl in warp_maps.keys() }
    has_initial_flags = (polished_path / "data/events/initialize_events.asm").is_file()
    initial_events = initial_flags(polished_path) if has_initial_flags else set()
    forced_set: set[str] = set()
    forced_clear: set[str] = set()

    def override(enabled: Iterable[str], disabled: Iterable[str]) -> None:
        forced_set.update(enabled)
        forced_set.difference_update(disabled)
        forced_clear.difference_update(enabled)
        forced_clear.update(disabled)

    files = []
    if scenario:
        files.append(atlas_common.ROOT_DIR / "scripts" / "scenarios" / f"{scenario}.json")
    if event_overrides_path:
        files.append(event_overrides_path)
    for path in files:
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
            override(state.get("set", []), state.get("clear", []))
        except (OSError, ValueError, TypeError, AttributeError) as exc:
            if debug:
                print(f"[warn] failed to load event overrides from {path}: {exc}")
    override(assume_set_events or [], assume_clear_events or [])
    initial_events = (initial_events - forced_clear) | forced_set
    constants = None

    def entry_state(path: Path, flags: set[str]) -> ParsedMapScript:
        nonlocal constants
        parsed = parse_map_script(path)
        for spawn in parsed.object_spawns.values():
            spawn.visible = spawn.hide_event not in flags
        if parsed.schedule:
            if constants is None:
                constants = gather_constants(polished_path)
            for command, (name, *args) in parsed.schedule.commands(constants, flags, weekday, time_of_day):
                if command == "moveobject":
                    spawn = parsed.object_spawns[name]
                    spawn.x, spawn.y = map(int, args)
                elif command in ("appear", "disappear"):
                    parsed.object_spawns[name].visible = command == "appear"
            for spawn in parsed.object_spawns.values():
                if spawn.hide_event in forced_set:
                    spawn.visible = False
                elif spawn.hide_event in forced_clear:
                    spawn.visible = True
            # The known entry script has already run. Replaying a flattened
            # copy here would combine positions from mutually exclusive days.
            parsed.callbacks = [cb for cb in parsed.callbacks if cb.label != parsed.schedule.entry]
        return parsed

    # Precompute inverse warp mapping: target map label -> list of (dest_x, dest_y)
    incoming_spawns: Dict[str, Dict[Tuple[int, int], set[int]]] = {}
    for src_label, src_data in warp_maps.items():
        for w in src_data.get("warps", []) or []:
            tgt = w.get("target") or {}
            tgt_label = tgt.get("map_label")
            dx = tgt.get("x_cells")
            dy = tgt.get("y_cells")
            if tgt_label and dx is not None and dy is not None:
                indices = incoming_spawns.setdefault(tgt_label, {}).setdefault((int(dx), int(dy)), set())
                if isinstance(w.get("index"), int):
                    indices.add(w["index"])

    scene_file = polished_path / "data/maps/scenes.asm"
    scene_variables = dict(re.findall(r"^\s*scene_var\s+(\w+),\s*(\w+)",
                                      scene_file.read_text(encoding="utf-8"), re.M)) if scene_file.is_file() else {}

    # Normalize filters to case-insensitive substring checks
    map_filters_norm = [s.lower() for s in (map_filters or [])]
    label_filters_norm = [s.lower() for s in (label_filters or [])]

    seen_arrivals = set()

    def scan_map(asm_path: Path, arrival: Optional[Tuple[int, int]] = None,
                 inherited_events: Optional[Dict[str, int]] = None,
                 selected_scene: Optional[str] = None, previous_warp: Optional[int] = None) -> None:
        on_arrival = arrival is not None
        first_issue = len(issues)
        flags = set(initial_events)
        for flag, value in (inherited_events or {}).items():
            if value == EV_TRUE:
                flags.add(flag)
            elif value == EV_FALSE:
                flags.discard(flag)
        map_label = asm_path.stem
        if not on_arrival and map_filters_norm:
            label_lc = map_label.lower()
            if not any(sub in label_lc for sub in map_filters_norm):
                return
        warp_meta = get_warp_meta(warp_maps, map_label)
        is_overworld = warp_meta.is_overworld
        if not on_arrival and ((scope == "overworld" and not is_overworld) or (scope == "indoor" and is_overworld)):
            return
        parsed = entry_state(asm_path, flags)
        map_constant = warp_maps.get(map_label, {}).get("map_constant")
        scene_variable = scene_variables.get(map_constant)
        local_names = {obj.index: name for name, obj in parsed.object_spawns.items()}

        def actor(name: str) -> str:
            # A script can use another map's constant for the same object slot.
            if name in parsed.object_spawns:
                return name
            return local_names.get(object_ordinals.get(name), name)

        def scene_id(token: Optional[str]) -> Optional[int]:
            if token is None:
                return None
            return next((i for i, (name, _) in enumerate(parsed.scenes) if name == token), _numeric(token))
        if not on_arrival:
            stats['maps_scanned'] += 1

        # Index source warp tiles for this map: (x,y) -> (dest_map, (dx,dy))
        warp_sources_index: Dict[Tuple[int, int], Tuple[str, Tuple[int, int]]] = {}
        warp_indices = {}
        for w in (warp_maps.get(map_label, {}).get("warps", []) or []):
            sx = w.get("x_cells")
            sy = w.get("y_cells")
            tgt = w.get("target") or {}
            dm = tgt.get("map_label")
            dx = tgt.get("x_cells")
            dy = tgt.get("y_cells")
            if sx is None or sy is None or dm is None or dx is None or dy is None:
                continue
            warp_sources_index[(int(sx), int(sy))] = (str(dm), (int(dx), int(dy)))
            warp_indices[(int(sx), int(sy))] = w.get("index")

        # optional debug header per map
        if debug:
            print(f"[map] {map_label}: coord_events={len(parsed.coord_events)} callbacks={len(parsed.callbacks)} objects={len(parsed.object_spawns)} movements={len(parsed.movement_blocks)} labels={len(parsed.script_labels)}")

        base_visible_by_name = {name: spawn.visible for name, spawn in parsed.object_spawns.items()}

        # Build triggers:
        triggers: List[Tuple[str, str, List[Tuple[int, int]], Optional[str]]] = []
        # - Coord events
        for ce in parsed.coord_events:
            if not on_arrival or (arrival == (ce.x, ce.y) and (
                selected_scene is None or ce.scene in ("-1", "SCENE_ALWAYS") or
                ce.scene == selected_scene or (
                    scene_id(selected_scene) is not None and scene_id(ce.scene) == scene_id(selected_scene)
                )
            )):
                triggers.append(("coord", ce.label, [(ce.x, ce.y)], None))
        # - Talk-to-NPC events (from object spawns with script_label present in ASM)
        grid = warp_meta.collision
        for spawn in parsed.object_spawns.values():
            if on_arrival or not spawn.script_label:
                continue
            if spawn.script_label not in parsed.script_labels:
                continue
            # Skip if hidden at initial state
            if not base_visible_by_name.get(spawn.label, True):
                continue
            # Player can stand on any adjacent land-passable cell
            candidates = [
                (spawn.x, spawn.y - 1),
                (spawn.x, spawn.y + 1),
                (spawn.x - 1, spawn.y),
                (spawn.x + 1, spawn.y),
            ]
            positions: List[Tuple[int, int]] = []
            if grid:
                for cx, cy in candidates:
                    if 0 <= cx < grid.width_cells and 0 <= cy < grid.height_cells:
                        val = grid.get(cx, cy)
                        if _is_land_passable(warp_root, val):
                            positions.append((cx, cy))
            else:
                positions = candidates
            # If none valid, still record the trigger without positions
            if positions:
                triggers.append(("talk", spawn.script_label, positions, spawn.label))
        # - Callbacks: use incoming warp destinations as plausible player cells
        arrivals = incoming_spawns.get(map_label, {})
        cb_cells = [arrival] if on_arrival else sorted(arrivals)
        for index, (scene, label) in enumerate(parsed.scenes):
            cells = cb_cells
            if not on_arrival and (map_constant, scene) in scripted_arrivals:
                cells = sorted(scripted_arrivals[map_constant, scene])
            if cells and label in parsed.script_labels and (selected_scene is None or scene_id(selected_scene) == index):
                if parsed.previous_warp_checks:
                    triggers.extend(("scene", label, [cell], None) for cell in cells)
                else:
                    triggers.append(("scene", label, cells, None))
        for cb in parsed.callbacks:
            if cb_cells:
                triggers.append(("callback", cb.label, cb_cells, None))

        # Optional label filtering on triggers
        if label_filters_norm and not on_arrival:
            def _keep_trig(t: Tuple[str, str, List[Tuple[int, int]], Optional[str]]) -> bool:
                _, lbl, _, _ = t
                return any(sub in lbl.lower() for sub in label_filters_norm)
            triggers = [t for t in triggers if _keep_trig(t)]

        stats['triggers_found'] += len(triggers)
        if debug:
            for kind, start_label, cells, obj in triggers:
                print(f"  [trigger] kind={kind} label={start_label} cells={len(cells)} obj={obj or '-'}")

        # Quick lookup of object initial positions by constant name
        object_pos: Dict[str, Tuple[int, int]] = {name: (spawn.x, spawn.y) for name, spawn in parsed.object_spawns.items()}

        def follow_arrival(target: str, xy: Tuple[int, int], ev: Dict[str, int], scenes: Dict[str, str],
                           warp_index: Optional[int] = None) -> None:
            if on_arrival:
                return
            path = maps_dir / f"{target}.asm"
            scene = scenes.get(_norm_label_key(target))
            key = (target, xy, scene, warp_index, tuple(sorted(ev.items())))
            if key not in seen_arrivals and path.is_file():
                seen_arrivals.add(key)
                scan_map(path, xy, ev, scene, warp_index)

        # Execute per trigger with symbolic event-state traversal
        for trig_kind, start_label, player_cells, trig_obj in triggers:
            if debug:
                print(f"    [symbolic] start={start_label} cells={len(player_cells)} kind={trig_kind}")

            # Build initial tri-state event map
            ev_state: Dict[str, int] = {}
            for ev in initial_events:
                _ev_set(ev_state, ev, EV_TRUE)
            # CLI explicit clears override
            for ev in forced_clear:
                _ev_set(ev_state, ev, EV_FALSE)

            ev_state.update(inherited_events or {})

            # Visibility snapshot seeded from base, but will be updated by events during traversal
            base_vis: Dict[str, bool] = dict(base_visible_by_name)

            # Worklist of execution contexts
            @dataclass
            class Ctx:
                label: str
                pc: int
                ret: List[Tuple[str, int]]
                temp_pos: Dict[str, Tuple[int, int]]
                visible: Dict[str, bool]
                player_cells: List[Tuple[int, int]]
                last_talked: Optional[str]
                ev: Dict[str, int]
                last_check: Optional[int] = None
                steps: int = 0
                # Active script-level follow relationships: follower -> leader
                follows: Dict[str, str] = field(default_factory=dict)
                follow_in_sync: bool = False
                variable_result: Optional[float] = None
                scene_writes: Dict[str, str] = field(default_factory=dict)
                deferred: Optional[str] = None

            def static_npcs_snapshot_local(visible: Dict[str, bool], temp_pos: Dict[str, Tuple[int, int]], exclude: Optional[str] = None) -> List[Tuple[int, int]]:
                out_list: List[Tuple[int, int]] = []
                for name, sp in parsed.object_spawns.items():
                    if name == exclude or name == "PLAYER":
                        continue
                    if not visible.get(name, True):
                        continue
                    pos = temp_pos.get(name) or (sp.x, sp.y)
                    out_list.append(pos)
                return out_list

            max_steps = 2000
            max_branches = 32
            branches = 0
            current_scene = selected_scene
            first_label = start_label
            returns = []
            origin_index = previous_warp
            if trig_kind == "scene":
                current_scene = next(str(i) for i, (_, label) in enumerate(parsed.scenes) if label == start_label)
                if not on_arrival and len(player_cells) == 1:
                    indices = arrivals.get(player_cells[0], set())
                    if len(indices) == 1:
                        origin_index = next(iter(indices))
                # Object callbacks position the actors before the scene runs.
                for cb in reversed(parsed.callbacks):
                    if cb.kind == "MAPCALLBACK_OBJECTS" and cb.label in parsed.script_labels:
                        returns.append((first_label, 0))
                        first_label = cb.label
            work = [Ctx(label=first_label, pc=0, ret=returns, temp_pos={}, visible=dict(base_vis),
                        player_cells=list(player_cells), last_talked=trig_obj, ev=dict(ev_state))]

            def finish_script(state: Ctx, end_all: bool = False) -> None:
                if end_all:
                    state.ret.clear()
                if state.ret:
                    state.label, state.pc = state.ret.pop()
                elif state.deferred in parsed.script_labels:
                    state.label, state.pc = state.deferred, 0
                    state.deferred = None
                else:
                    return
                work.append(state)

            while work:
                ctx = work.pop()
                if ctx.steps > max_steps:
                    continue
                block = parsed.script_labels.get(ctx.label)
                if not block:
                    continue
                if ctx.pc >= len(block.commands):
                    # fallthrough to next top-level label
                    label_order = list(parsed.script_labels.keys())
                    try:
                        idx = label_order.index(ctx.label)
                        nxt = label_order[idx + 1]
                    except Exception:
                        nxt = None
                    if not nxt:
                        continue
                    ctx.label, ctx.pc = nxt, 0
                    work.append(ctx)
                    continue
                cmd = block.commands[ctx.pc]
                ctx.steps += 1
                op = cmd.opcode
                args = cmd.args
                if args and op in {"applymovement", "applyonemovement", "moveobject", "writeobjectxy",
                                   "appear", "disappear", "turnobject", "setlasttalked"}:
                    args = (actor(args[0]), *args[1:])
                elif len(args) == 2 and op in {"follow", "follownotexact", "faceobject"}:
                    args = tuple(actor(a) for a in args)

                # Control-flow: mid-script warp terminates this path on current map
                # Cross-map ops terminate this path; reloadmap/reloadmapafterbattle continue without reporting
                if op in {"warp", "warpfacing", "newloadmap", "warpcheck"}:
                    dest_map: Optional[str] = None
                    dest_xy: Optional[Tuple[int, int]] = None
                    if op == "warp" and len(args) >= 3:
                        cand_map = args[0]
                        dx = _numeric(args[1]); dy = _numeric(args[2])
                        if cand_map in warp_maps:
                            dest_map = cand_map
                        else:
                            dest_map = warp_label_by_norm.get(_norm_label_key(cand_map))
                        if dx is not None and dy is not None:
                            dest_xy = (int(dx), int(dy))
                    elif op == "warpfacing" and len(args) >= 4:
                        cand_map = args[1]
                        dx = _numeric(args[2]); dy = _numeric(args[3])
                        if cand_map in warp_maps:
                            dest_map = cand_map
                        else:
                            dest_map = warp_label_by_norm.get(_norm_label_key(cand_map))
                        if dx is not None and dy is not None:
                            dest_xy = (int(dx), int(dy))
                    # Severity rules:
                    # - warp/warpfacing: info when destination map resolves; warn when it doesn't
                    # - newloadmap/warpcheck: informational breadcrumb only
                    if op in {"newloadmap", "warpcheck"}:
                        severity = "info"
                    else:
                        severity = ("warn" if (dest_map is None) else "info")
                    issues.append(
                        AuditIssue(
                            map_label=map_label,
                            file=str(asm_path.relative_to(atlas_common.ROOT_DIR)),
                            kind="cross-map",
                            severity=severity,
                            details={
                                "script_label": start_label,
                                "line": cmd.line_no,
                                "op": op,
                                "trigger": trig_kind,
                                "dest_map": dest_map,
                                "dest_xy": list(dest_xy) if dest_xy else None,
                            },
                        )
                    )
                    if debug:
                        print(f"    [warp] {op} from {ctx.label}:{ctx.pc} -> {dest_map or '?'} {dest_xy or ''}")
                    if dest_map and dest_xy:
                        follow_arrival(dest_map, dest_xy, ctx.ev, ctx.scene_writes)
                    # Stop this path on this map
                    continue
                if op in {"reloadmap", "reloadmapafterbattle"}:
                    # Same-map cleanup; continue traversal like a no-op
                    ctx.pc += 1
                    work.append(ctx)
                    continue

                if op == "setmapscene" and len(args) == 2:
                    ctx.scene_writes[_norm_label_key(args[0])] = args[1]
                elif op == "setscene" and args:
                    ctx.scene_writes[_norm_label_key(map_label)] = args[0]
                elif op == "sdefer" and args and trig_kind == "scene":
                    # RunSceneScript has a single pending pointer. The outer
                    # scene must finish before it starts the selected script.
                    ctx.deferred = args[0]

                # Calls and jumps
                if op in {"sjump", "sjumpfwd", "farsjump", "memjump", "jump", "priorityjump", "jumpstd", "stopandsjump"} and args:
                    tgt = args[0]
                    if tgt in parsed.script_labels:
                        ctx.label, ctx.pc = tgt, 0
                        work.append(ctx)
                    continue
                if op in {"call", "callstd", "scall", "scallfwd", "farscall", "memcall"} and args:
                    tgt = args[0]
                    if tgt in parsed.script_labels:
                        # Push return and jump
                        ctx.ret.append((ctx.label, ctx.pc + 1))
                        ctx.label, ctx.pc = tgt, 0
                        work.append(ctx)
                    continue
                if op in {"end", "endall", "reloadend", "endcallback", "endtext", "done"}:
                    finish_script(ctx, end_all=op == "endall")
                    continue

                # Variable ops
                if op in ("callasm", "checkscene", "readmem"):
                    value = None
                    if op == "checkscene" or (op == "readmem" and args and args[0] == scene_variable):
                        value = scene_id(ctx.scene_writes.get(_norm_label_key(map_label), current_scene))
                    elif op == "callasm" and args and args[0] in parsed.previous_warp_checks and origin_index is not None:
                        value = (origin_index - parsed.previous_warp_checks[args[0]]) & 255
                    ctx.variable_result = value
                    ctx.last_check = None if value is None else int(bool(value))
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op in {"yesorno", "verticalmenu"} or op.removesuffix("_unsafe") in _ITEM_OPERANDS:
                    # Inventory is not part of a map snapshot. Both pickup
                    # outcomes are possible regardless of earlier event checks.
                    ctx.last_check = None
                    ctx.variable_result = None
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op == "readvar" and len(args) >= 1:
                    # Keep the value at the time of the read, including across
                    # movement commands and successive comparisons.
                    ctx.variable_result = None
                    ctx.last_check = None
                    ctx.pc += 1
                    var = args[0]
                    npc = ctx.temp_pos.get(trig_obj) or object_pos.get(trig_obj)
                    groups = {}
                    facings = {(0, 1): 0, (0, -1): 1, (-1, 0): 2, (1, 0): 3}
                    for cell in ctx.player_cells:
                        value = None
                        if var in ("VAR_XCOORD", "VAR_YCOORD"):
                            value = cell[0 if var == "VAR_XCOORD" else 1]
                        elif var == "VAR_FACING" and trig_kind == "talk" and npc:
                            value = facings.get((npc[0] - cell[0], npc[1] - cell[1]))
                        groups.setdefault(value, []).append(cell)
                    if len(groups) <= 1:
                        ctx.variable_result = next(iter(groups), None)
                        if ctx.variable_result is not None:
                            ctx.last_check = int(bool(ctx.variable_result))
                        work.append(ctx)
                    else:
                        for value, cells in groups.items():
                            branch = deepcopy(ctx)
                            branch.variable_result = value
                            branch.last_check = int(bool(value)) if value is not None else None
                            branch.player_cells = cells
                            work.append(branch)
                    continue

                # Event state ops
                if op in {"setevent", "setflag"} and args:
                    ev = args[0]
                    _ev_set(ctx.ev, ev, EV_TRUE)
                    for name, sp in parsed.object_spawns.items():
                        if sp.hide_event == ev:
                            ctx.visible[name] = False
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op in {"clearevent", "clearflag"} and args:
                    ev = args[0]
                    _ev_set(ctx.ev, ev, EV_FALSE)
                    for name, sp in parsed.object_spawns.items():
                        if sp.hide_event == ev:
                            ctx.visible[name] = True
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op in {"checkevent", "checkflag"} and args:
                    ev = args[0]
                    ctx.last_check = _ev_get(ctx.ev, ev)
                    ctx.variable_result = None
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op.startswith("if"):
                    # Only handle iftrue/iffalse style branches with a single label target
                    target: Optional[str] = None
                    if args:
                        cand = args[-1]
                        if _looks_like_label(cand) and cand in parsed.script_labels:
                            target = cand
                    if not target:
                        m = _IF_BRANCH_RE.match(f"{op} {', '.join(args)}" if args else op)
                        if m:
                            cand = m.group(1)
                            if _looks_like_label(cand) and cand in parsed.script_labels:
                                target = cand
                    if target and op.startswith(("ifequal", "ifnotequal")) and ctx.variable_result is not None:
                        comparison = args[0]
                        value = {"DOWN": 0, "UP": 1, "LEFT": 2, "RIGHT": 3}.get(comparison, _numeric(comparison))
                        if value is not None:
                            if (value == ctx.variable_result) == op.startswith("ifequal"):
                                ctx.label, ctx.pc = target, 0
                            else:
                                ctx.pc += 1
                            work.append(ctx)
                            continue
                    ends_script = op in _CONDITIONAL_TEXT_END
                    if target or ends_script:
                        cond = ctx.last_check
                        ctx.last_check = None
                        take_jump = None
                        if op.lower().startswith("iftrue"):
                            if cond == EV_TRUE:
                                take_jump = True
                            elif cond == EV_FALSE:
                                take_jump = False
                        elif op.lower().startswith("iffalse"):
                            if cond == EV_TRUE:
                                take_jump = False
                            elif cond == EV_FALSE:
                                take_jump = True
                        if take_jump is not False and (take_jump or branches < max_branches):
                            branch = ctx if take_jump else deepcopy(ctx)
                            if take_jump is None:
                                branches += 1
                            if ends_script:
                                finish_script(branch)
                            else:
                                branch.label, branch.pc = target, 0
                                work.append(branch)
                        if take_jump is not True:
                            ctx.pc += 1
                            work.append(ctx)
                        continue
                    # If no resolvable label, just fall through
                    ctx.pc += 1
                    work.append(ctx)
                    continue

                # Positioning ops
                if op == "moveobject" and len(args) >= 3:
                    obj = args[0]
                    x = _numeric(args[1]); y = _numeric(args[2])
                    if x is not None and y is not None:
                        ctx.temp_pos[obj] = (int(x), int(y))
                        if obj == "PLAYER":
                            ctx.player_cells = [(int(x), int(y))]
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op == "writeobjectxy" and len(args) >= 3:
                    obj = args[0]
                    x = _numeric(args[1]); y = _numeric(args[2])
                    if x is not None and y is not None:
                        ctx.temp_pos[obj] = (int(x), int(y))
                        if obj == "PLAYER":
                            ctx.player_cells = [(int(x), int(y))]
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op in {"appear", "disappear"} and len(args) >= 1:
                    obj = args[0]
                    if op == "disappear":
                        ctx.visible[obj] = False
                        ctx.temp_pos.pop(obj, None)
                    else:
                        ctx.visible[obj] = True
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op == "setlasttalked" and len(args) >= 1:
                    ctx.last_talked = args[0]
                    ctx.pc += 1
                    work.append(ctx)
                    continue

                # Follow semantics
                if op == "loadmem" and len(args) == 2 and args[0] == "wFollowInSync":
                    ctx.follow_in_sync = args[1] in {"TRUE", "1"}
                if op in {"follow", "follownotexact"} and len(args) >= 2:
                    leader_obj, follower_obj = args[:2]
                    # Record the relationship
                    if op == "follow":
                        ctx.follows.clear()
                    ctx.follows[follower_obj] = leader_obj
                    # Only warn if the player will imminently move after setting an NPC to follow them
                    if leader_obj == "PLAYER" and include_follower and not ctx.follow_in_sync:
                        def _player_moves_soon(block: ScriptLabel, start_index: int, limit: int = 12) -> bool:
                            end = min(len(block.commands), start_index + limit)
                            for j in range(start_index, end):
                                c = block.commands[j]
                                if c.opcode == "applymovement" and len(c.args) >= 1 and c.args[0] == "PLAYER":
                                    return True
                                if c.opcode == "applyonemovement" and len(c.args) >= 1 and c.args[0] == "PLAYER":
                                    return True
                                if c.opcode in {"moveobject", "writeobjectxy"} and len(c.args) >= 1 and c.args[0] == "PLAYER":
                                    return True
                                if c.opcode in {"warp", "warpfacing", "newloadmap", "warpcheck"}:
                                    # Crossing maps ends the immediate context
                                    return False
                                if c.opcode in {"end", "endall", "reloadend", "endcallback", "endtext", "done"}:
                                    return False
                            return False
                        if _player_moves_soon(block, ctx.pc + 1):
                            for pstart in (ctx.player_cells or [(0, 0)]):
                                issues.append(
                                    AuditIssue(
                                        map_label=map_label,
                                        file=str(asm_path.relative_to(atlas_common.ROOT_DIR)),
                                        kind="follower-collision",
                                        severity="warn",
                                        details={
                                            "script_label": start_label,
                                            "line": cmd.line_no,
                                            "object": follower_obj,
                                            "player_cell": list(pstart),
                                            "trigger": trig_kind,
                                            "reason": "npc-following-player while pokemon follower active",
                                        },
                                    )
                                )
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op == "stopfollow":
                    ctx.follows.clear()
                    ctx.pc += 1
                    work.append(ctx)
                    continue

                # Movements
                if op in {"applymovement", "applyonemovement"} and len(args) >= 2:
                    obj = args[0]
                    mov_label = args[1]
                    block = parsed.movement_blocks.get(mov_label)
                    if op == "applyonemovement":
                        tokens = [mov_label, "step_end"]
                        movement_key = "token"
                    else:
                        tokens = block.tokens if block else []
                        movement_key = "move"
                    if tokens:
                        stats['applymovement_processed'] += 1
                        if obj == "PLAYER":
                            starts = ctx.player_cells or [(0, 0)]
                            landing_cells = []
                            for pstart in starts:
                                path = _simulate_apply_movement(tokens, pstart)
                                if not path:
                                    landing_cells.append(pstart)
                                    continue
                                prev = pstart
                                follower_cell = pstart
                                # If any NPC is currently following the PLAYER while the Pokémon follower is active,
                                # this sequence will cause both to attempt occupying the trailing cell.
                                npc_followers_of_player = [f for f, leader in ctx.follows.items() if leader == "PLAYER"]
                                if npc_followers_of_player and include_follower and not ctx.follow_in_sync:
                                    for fobj in npc_followers_of_player:
                                        issues.append(
                                            AuditIssue(
                                                map_label=map_label,
                                                file=str(asm_path.relative_to(atlas_common.ROOT_DIR)),
                                                kind="follower-collision",
                                                severity="warn",
                                                details={
                                                    "script_label": start_label,
                                                    "line": cmd.line_no,
                                                    "object": fobj,
                                                    "player_cell": list(pstart),
                                                    "follower_cell": list(follower_cell),
                                                    "trigger": trig_kind,
                                                    "reason": "npc-following-player conflicts with pokemon follower during player movement",
                                                },
                                            )
                                        )
                                for step_xy in path:
                                    if ctx.follow_in_sync:
                                        _move_synchronized_followers(npc_followers_of_player, ctx.temp_pos,
                                                                     object_pos, prev, step_xy)
                                    _tmp_issues = count_sprite_usage(
                                            map_label,
                                            player_cell=step_xy,
                                            moving_npc_cell=None,
                                            static_npcs=static_npcs_snapshot_local(ctx.visible, ctx.temp_pos, None),
                                            follower_cell_override=follower_cell,
                                            object_meta=object_meta,
                                            warp_meta=warp_meta,
                                            include_follower=include_follower,
                                            include_weather=include_weather,
                                            scanline_limit=scanline_limit,
                                            total_limit=total_limit,
                                            context={
                                                "script_label": start_label,
                                                "line": cmd.line_no,
                                                "trigger": trig_kind,
                                                "op": op,
                                                movement_key: mov_label,
                                                "phase": "arrival" if on_arrival else "main",
                                                "follower_cell": list(follower_cell),
                                            },
                                        )
                                    for _it in _tmp_issues:
                                        _it.file = str(asm_path.relative_to(atlas_common.ROOT_DIR))
                                    issues.extend(_tmp_issues)
                                    dest_info = warp_sources_index.get(step_xy)
                                    if dest_info:
                                        d_map, (dx, dy) = dest_info
                                        issues.append(
                                            AuditIssue(
                                                map_label=map_label,
                                                file=str(asm_path.relative_to(atlas_common.ROOT_DIR)),
                                                kind="cross-map",
                                                severity="info",
                                                details={
                                                    "script_label": start_label,
                                                    "line": cmd.line_no,
                                                    "op": "warp-tile",
                                                    "trigger": trig_kind,
                                                    "dest_map": d_map,
                                                    "dest_xy": [dx, dy],
                                                },
                                            )
                                        )
                                        follow_arrival(d_map, (dx, dy), ctx.ev, ctx.scene_writes,
                                                       warp_indices.get(step_xy))
                                        # terminate this path on this map after warp
                                        break
                                    follower_cell = prev
                                    prev = step_xy
                                else:
                                    landing_cells.append(path[-1])
                            if not landing_cells:
                                continue
                            ctx.player_cells = landing_cells
                        else:
                            # If moving a currently hidden NPC via applymovement, assume it should have been visible (hinted rule)
                            if not ctx.visible.get(obj, True):
                                sp = parsed.object_spawns.get(obj)
                                if sp and sp.hide_event:
                                    _ev_set(ctx.ev, sp.hide_event, EV_FALSE)
                                    ctx.visible[obj] = True
                            start_xy = ctx.temp_pos.get(obj) or object_pos.get(obj)
                            if start_xy is not None:
                                path = _simulate_apply_movement(tokens, start_xy)
                                for pstart in (ctx.player_cells or [(0, 0)]):
                                    collided = follower_collision_during_path(pstart, path, warp_meta)
                                    if collided:
                                        issues.append(
                                            AuditIssue(
                                                map_label=map_label,
                                                file=str(asm_path.relative_to(atlas_common.ROOT_DIR)),
                                                kind="follower-collision",
                                                severity="warn",
                                                details={
                                                    "script_label": start_label,
                                                    "line": cmd.line_no,
                                                    "object": obj,
                                                    movement_key: mov_label,
                                                    "player_cell": list(pstart),
                                                    "follower_candidates": [list(t) for t in plausible_follower_cells(pstart, warp_meta)],
                                                    "trigger": trig_kind,
                                                },
                                            )
                                        )
                                    for step_xy in path:
                                        _tmp_issues = count_sprite_usage(
                                                map_label,
                                                player_cell=pstart,
                                                moving_npc_cell=step_xy,
                                                static_npcs=static_npcs_snapshot_local(ctx.visible, ctx.temp_pos, obj),
                                                follower_cell_override=None,
                                                object_meta=object_meta,
                                                warp_meta=warp_meta,
                                                include_follower=include_follower,
                                                include_weather=include_weather,
                                                scanline_limit=scanline_limit,
                                                total_limit=total_limit,
                                                context={
                                                    "script_label": start_label,
                                                    "line": cmd.line_no,
                                                    "trigger": trig_kind,
                                                    "op": op,
                                                    movement_key: mov_label,
                                                    "object": obj,
                                                    "phase": "arrival" if on_arrival else "main",
                                                },
                                            )
                                        for _it in _tmp_issues:
                                            _it.file = str(asm_path.relative_to(atlas_common.ROOT_DIR))
                                        issues.extend(_tmp_issues)
                                if path:
                                    ctx.temp_pos[obj] = path[-1]
                    ctx.pc += 1
                    work.append(ctx)
                    continue

                if op == "applymovementlasttalked" and len(args) >= 1:
                    target = ctx.last_talked
                    mov_label = args[0]
                    block = parsed.movement_blocks.get(mov_label)
                    if target and block:
                        # If target is hidden, assume it should have been visible (hint applies)
                        if not ctx.visible.get(target, True):
                            sp = parsed.object_spawns.get(target)
                            if sp and sp.hide_event:
                                _ev_set(ctx.ev, sp.hide_event, EV_FALSE)
                                ctx.visible[target] = True
                        start_xy = ctx.temp_pos.get(target) or object_pos.get(target)
                        if start_xy is not None:
                            path = _simulate_apply_movement(block.tokens, start_xy)
                            for pstart in (ctx.player_cells or [(0, 0)]):
                                collided = follower_collision_during_path(pstart, path, warp_meta)
                                if collided:
                                    issues.append(
                                        AuditIssue(
                                            map_label=map_label,
                                            file=str(asm_path.relative_to(atlas_common.ROOT_DIR)),
                                            kind="follower-collision",
                                            severity="warn",
                                            details={
                                                "script_label": start_label,
                                                "line": cmd.line_no,
                                                "object": target,
                                                "move": mov_label,
                                                "player_cell": list(pstart),
                                                "follower_candidates": [list(t) for t in plausible_follower_cells(pstart, warp_meta)],
                                                "trigger": trig_kind,
                                            },
                                        )
                                    )
                                for step_xy in path:
                                    _tmp_issues = count_sprite_usage(
                                            map_label,
                                            player_cell=pstart,
                                            moving_npc_cell=step_xy,
                                            static_npcs=static_npcs_snapshot_local(ctx.visible, ctx.temp_pos, target),
                                            follower_cell_override=None,
                                            object_meta=object_meta,
                                            warp_meta=warp_meta,
                                            include_follower=include_follower,
                                            include_weather=include_weather,
                                            scanline_limit=scanline_limit,
                                            total_limit=total_limit,
                                            context={
                                                "script_label": start_label,
                                                "line": cmd.line_no,
                                                "trigger": trig_kind,
                                                "op": op,
                                                "move": mov_label,
                                                "object": target,
                                                "phase": "arrival" if on_arrival else "main",
                                            },
                                        )
                                    for _it in _tmp_issues:
                                        _it.file = str(asm_path.relative_to(atlas_common.ROOT_DIR))
                                    issues.extend(_tmp_issues)
                            if path:
                                ctx.temp_pos[target] = path[-1]
                    ctx.pc += 1
                    work.append(ctx)
                    continue

                # setlasttalked already handled; other ops we ignore but just advance
                ctx.pc += 1
                work.append(ctx)

        if on_arrival:
            for issue in issues[first_issue:]:
                issue.details["phase"] = "arrival"
                issue.details.setdefault("arrival_xy", list(arrival))

    for asm_path in _iter_map_asm_files(maps_dir):
        scan_map(asm_path)
    return issues


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Audit scripted movements for sprite limits and follower collisions.")
    p.add_argument("--polishedcrystal", type=Path, default=atlas_common.DEFAULT_POLISHED_PATH, help="Path to polishedcrystal repo")
    p.add_argument("--object-meta", type=Path, default=atlas_common.DEFAULT_MAPS_DIR / "object_metadata.json", help="Path to object_metadata.json")
    p.add_argument("--warp-meta", type=Path, default=atlas_common.DEFAULT_MAPS_DIR / "warp_metadata.json", help="Path to warp_metadata.json")
    p.add_argument("--scope", choices=["all", "overworld", "indoor"], default="all")
    p.add_argument("--time", dest="time_of_day", choices=["morn", "day", "nite", "eve"], default="day")
    p.add_argument("--weekday", type=int, choices=range(7), default=1, help="Game weekday (0=Sunday, 1=Monday)")
    p.add_argument("--no-follower", dest="include_follower", action="store_false", help="Disable follower reservation and collision checks")
    p.add_argument("--no-weather", dest="include_weather", action="store_false", help="Disable weather sprite reservation on overworld")
    p.add_argument("--scanline-limit", type=int, default=DEFAULT_SCANLINE_LIMIT)
    p.add_argument("--total-limit", type=int, default=DEFAULT_TOTAL_LIMIT)
    p.add_argument("--json", dest="json_output", type=Path, default=None, help="Write full JSON report to this path")
    p.add_argument("--debug", action="store_true", help="Print debug tracing and counters while scanning")
    p.add_argument("--assume-set-event", action="append", dest="assume_set_events", default=None, help="Assume this EVENT_* flag is set at start (can be repeated)")
    p.add_argument("--assume-clear-event", action="append", dest="assume_clear_events", default=None, help="Assume this EVENT_* flag is clear at start (can be repeated)")
    p.add_argument("--format", choices=["compact", "fix"], default="fix", help="Console output format: compact or fix-friendly")
    p.add_argument("--show-cross-map-info", dest="show_cross_map_info", action="store_true", help="Include informational cross-map breadcrumbs in console output")
    # Ergonomics: targeting and scenarios
    p.add_argument("--map", action="append", dest="map_filters", default=None, help="Restrict to maps whose labels include this substring (repeatable)")
    p.add_argument("--label", action="append", dest="label_filters", default=None, help="Restrict to script labels whose names include this substring (repeatable)")
    p.add_argument("--scenario", choices=["fresh-game", "post-rocket", "post-hof"], default=None, help="Seed event state using a preset in scripts/scenarios/<scenario>.json")
    p.add_argument("--event-overrides", dest="event_overrides_path", type=Path, default=None, help="Path to a JSON file with {set: [...], clear: [...]} to adjust event flags")
    return p.parse_args()


def main() -> None:
    args = parse_args()
    issues = analyze_scripts(
        polished_path=args.polishedcrystal.resolve(),
        object_meta_path=args.object_meta.resolve(),
        warp_meta_path=args.warp_meta.resolve(),
        scope=args.scope,
        time_of_day=args.time_of_day,
        weekday=args.weekday,
        include_follower=args.include_follower,
        include_weather=args.include_weather,
        scanline_limit=max(0, int(args.scanline_limit)),
        total_limit=max(0, int(args.total_limit)),
        debug=bool(args.debug),
        assume_set_events=args.assume_set_events,
        assume_clear_events=args.assume_clear_events,
        map_filters=args.map_filters,
        label_filters=args.label_filters,
        scenario=args.scenario,
        event_overrides_path=(args.event_overrides_path.resolve() if args.event_overrides_path else None),
    )

    # Optionally suppress non-problem informational cross-map breadcrumbs from console view
    display_issues: List[AuditIssue]
    if getattr(args, "show_cross_map_info", False):
        display_issues = issues
    else:
        display_issues = [i for i in issues if not (i.kind == "cross-map" and i.severity == "info")]

    # De-duplicate identical issues (same map, kind, count at same cell) for a compact console summary
    def issue_key(i: AuditIssue) -> Tuple:
        d = i.details
        if i.kind == "cross-map":
            # Keep cross-map issues distinct per script/op/destination to avoid confusing collapses
            return (
                i.map_label,
                i.kind,
                i.severity,
                d.get("script_label", None),
                d.get("op", None),
                d.get("trigger", None),
                d.get("dest_map", None),
                json.dumps(d.get("dest_xy", None)),
            )
        # Default: group by map/kind/severity and location/count when present
        return (
            i.map_label,
            i.kind,
            i.severity,
            d.get("script_label", None),
            d.get("op", None),
            d.get("move", None),
            d.get("token", None),
            d.get("object", None),
            json.dumps(d.get("player_cell", None)),
            json.dumps({k: d.get(k) for k in ("count", "limit")} ),
        )

    uniq: Dict[Tuple, AuditIssue] = {}
    for it in display_issues:
        uniq.setdefault(issue_key(it), it)

    print(f"Scripted movement audit: {len(uniq)} unique issues ({len(display_issues)} raw findings)")
    if args.debug:
        # A light-weight re-run of stats is non-trivial since counters live in analyze_scripts.
        # For now, rely on the per-map debug lines. If needed, we can return stats in the future.
        pass
    bucketed: Dict[str, List[AuditIssue]] = {"scanline-limit": [], "total-limit": [], "follower-collision": [], "cross-map": []}
    for it in uniq.values():
        bucketed.setdefault(it.kind, []).append(it)
    for kind in ("scanline-limit", "total-limit", "follower-collision", "cross-map"):
        arr = bucketed.get(kind, [])
        if not arr:
            continue
        print(f"- {kind}: {len(arr)}")
        # Sort deterministically: by map, script, line
        def _sort_key(it: AuditIssue):
            return (
                it.map_label,
                it.details.get("script_label") or "",
                it.details.get("line") or 0,
                it.details.get("count") or 0,
            )
        for it in sorted(arr, key=_sort_key):
            d = it.details
            if getattr(args, "format", "fix") == "compact":
                base = f"  {it.map_label}  [{it.severity}]"
                if kind in {"scanline-limit", "total-limit"}:
                    base += f" count={d.get('count')} limit={d.get('limit')}"
                if d.get("player_cell") is not None:
                    base += f" player={tuple(d['player_cell'])}"
                if d.get("follower_cell") is not None:
                    base += f" follower={tuple(d['follower_cell'])}"
                if d.get("script_label"):
                    base += f" script={d['script_label']}"
                if d.get("object"):
                    base += f" obj={d['object']}"
                # Show source location of the causing script op (e.g., applymovement), not movement token lines
                if it.file and d.get("line"):
                    base += f"  [{it.file}:{d.get('line')}]"
                if kind == "cross-map":
                    dm = d.get("dest_map"); dxy = d.get("dest_xy")
                    if dm:
                        base += f" -> {dm}"
                    if dxy:
                        base += f" at={tuple(dxy)}"
                print(base)
                continue
            # fix-friendly format
            file_line = f"{it.file}:{d.get('line')}" if it.file and d.get("line") else (it.file or "")
            script = d.get("script_label") or "?"
            trig = d.get("trigger") or "?"
            op = d.get("op")
            move = d.get("move")
            token = d.get("token")
            obj = d.get("object")
            player_cell = d.get("player_cell")
            reason = d.get("reason")
            # Header line
            header = f"  {it.map_label} [{it.severity}] ({kind})"
            if player_cell:
                header += f" at player={tuple(player_cell)}"
            if kind in {"scanline-limit", "total-limit"}:
                header += f" count={d.get('count')} limit={d.get('limit')}"
            print(header)
            # Details line
            details = f"    script={script} trigger={trig}"
            if op:
                details += f" op={op}"
            if move:
                details += f" move={move}"
            if token:
                details += f" token={token}"
            if obj:
                details += f" obj={obj}"
            if d.get("dest_map"):
                dm = d.get("dest_map"); dxy = d.get("dest_xy")
                details += f" -> {dm}"
                if dxy:
                    details += f" at={tuple(dxy)}"
            if d.get("follower_cell") is not None:
                details += f" follower={tuple(d['follower_cell'])}"
            if d.get("follower_candidates"):
                details += f" follower_candidates={[tuple(t) for t in d['follower_candidates']]}"
            if file_line:
                details += f"  [{file_line}]"
            print(details)
            # Repro hint
            repro = "    repro: "
            if trig == "coord" and player_cell:
                repro += f"stand at {tuple(player_cell)} and step/trigger the coord event"
            elif trig == "talk":
                if obj:
                    repro += f"talk to {obj} from an adjacent tile"
                else:
                    repro += f"talk to the NPC for this script"
            elif trig == "callback":
                if d.get("dest_xy"):
                    repro += f"enter the map at {tuple(d['dest_xy'])}"
                else:
                    repro += f"enter/load the map to run callbacks"
            else:
                repro += f"trigger the script label '{script}'"
            if reason:
                repro += f"; cause={reason}"
            print(repro)

    if args.json_output:
        payload = [
            {
                "map_label": it.map_label,
                "file": it.file,
                "kind": it.kind,
                "severity": it.severity,
                "details": it.details,
            }
            for it in issues
        ]
        path = args.json_output.resolve()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        print(f"Wrote JSON report: {path}")


if __name__ == "__main__":  # pragma: no cover
    main()
