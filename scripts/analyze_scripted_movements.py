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
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import atlas_common


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
    movement_blocks: Dict[str, MovementBlock]
    script_labels: Dict[str, ScriptLabel]


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
    idx_by_name: Dict[str, int] = {name: i + 1 for i, name in enumerate(constants)}
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
        if in_section and code.startswith("def_"):
            break
        if not in_section:
            continue
        if code.startswith("object_event ") or code.startswith("pokemon_event "):
            payload = code.split(None, 1)[1]
            parts = [p.strip() for p in payload.split(",") if p.strip()]
            if len(parts) < 2:
                continue
            x = _numeric(parts[0])
            y = _numeric(parts[1])
            script_label: Optional[str] = None
            hide_event: Optional[str] = None
            # Heuristic: the penultimate argument is usually the script label when OBJECTTYPE_SCRIPT,
            # and last is an event flag (or -1). If the penultimate token looks like an identifier and
            # not a macro like jumptextfaceplayer, capture it.
            if len(parts) >= 2:
                penult = parts[-2]
                last = parts[-1]
                if not _numeric(penult) and not penult.startswith("BGEVENT_") and not penult.startswith("EVENT_"):
                    # Exclude common inline commands to avoid bogus labels
                    if not penult.lower().endswith("faceplayer") and not penult.lower().startswith("jumptext"):
                        script_label = penult
                # Last argument is often an event that hides the object when set
                if last and last not in {"-1", "0"} and last.startswith("EVENT_"):
                    hide_event = last
            decls.append((int(x) if x is not None else None, int(y) if y is not None else None, script_label, hide_event))
    # Associate by order with constants
    for i, const_name in enumerate(constants):
        if i < len(decls):
            x, y, script_label, hide_event = decls[i]
            if x is None or y is None:
                continue
            spawns[const_name] = ObjectSpawn(
                label=const_name,
                index=idx_by_name.get(const_name),
                x=x,
                y=y,
                script_label=script_label,
                visible=True,
                hide_event=hide_event,
            )
    return spawns


_COORD_EVENT_RE = re.compile(r"^coord_event\s+(\d+)\s*,\s*(\d+)\s*,\s*[^,]+\s*,\s*([\w\.]+)")


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
            out.append(MapCoordEvent(x=int(m.group(1)), y=int(m.group(2)), label=m.group(3)))
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


def _parse_movement_blocks(lines: List[str]) -> Dict[str, MovementBlock]:
    blocks: Dict[str, MovementBlock] = {}
    current: Optional[str] = None
    tokens: List[str] = []
    pending_label: Optional[str] = None  # label we saw most recently; start block only if next line looks like movement

    def _is_movement_token_name(name: str) -> bool:
        if not name:
            return False
        if name == "step_end":
            return True
        if name in _STEP_DELTAS:
            return True
        if name.startswith("turn_head_"):
            return True
        if name in {
            "fix_facing",
            "remove_fixed_facing",
            "step_sleep",
            "step_sleep_1",
            "step_sleep_2",
            "step_sleep_3",
            "step_loop",
            "hide_object",
            "show_object",
            "remove_object",
        }:
            return True
        return False

    for raw in lines:
        code = _strip_comment(raw).rstrip()
        if not code:
            continue

        # Any new label (top-level or local) terminates an in-progress block
        if code.endswith(":"):
            if current and tokens:
                blocks[current] = MovementBlock(name=current, tokens=list(tokens))
            current = None
            tokens = []
            pending_label = code[:-1]
            continue

        # If we have a pending label, decide whether to start a movement block based on the first token after it
        if pending_label and not current:
            name = code.strip().split()[0]
            if _is_movement_token_name(name):
                current = pending_label
                tokens = []
                # fall through to collect this line as a token below
            # Whether or not we started a block, clear the pending label decision now
            pending_label = None

        if current:
            # Collect movement tokens until step_end
            tok = code.strip()
            if not tok:
                continue
            name = tok.split()[0]
            # Only record recognizable movement tokens; ignore stray lines inside for robustness
            if _is_movement_token_name(name):
                tokens.append(name)
                if name == "step_end":
                    blocks[current] = MovementBlock(name=current, tokens=list(tokens))
                    current = None
                    tokens = []
            else:
                # Unexpected content inside a movement block; terminate what we gathered so far
                if tokens:
                    blocks[current] = MovementBlock(name=current, tokens=list(tokens))
                current = None
                tokens = []
            continue

        # Not in a movement block; ignore regular script lines
        continue

    # Flush trailing
    if current and tokens:
        blocks[current] = MovementBlock(name=current, tokens=list(tokens))
    return blocks


_SCRIPT_CMD_RE = re.compile(
    r"^(" 
    r"applymovement|applymovementlasttalked|applyonemovement|"
    r"moveobject|writeobjectxy|appear|disappear|warpfacing|warp|faceobject|turnobject|"
    r"follow|stopfollow|follownotexact|setlasttalked|"
    r"setevent|clearevent|checkevent|"
    r"opentext|closetext|showtext|"
    r"sjumpfwd|sjump|farsjump|memjump|jump|priorityjump|jumpstd|stopandsjump|"
    r"scallfwd|scall|farscall|memcall|call|callasm|callstd|"
    r"end|endall|reloadend|endcallback|endtext|done|"
    r"newloadmap|reloadmap|reloadmapafterbattle|warpcheck|"
    r"if\w+"
    r")\b(.*)"
)


def _parse_script_labels(lines: List[str]) -> Dict[str, ScriptLabel]:
    labels: Dict[str, ScriptLabel] = {}
    current: Optional[str] = None
    for idx, raw in enumerate(lines, start=1):
        code = _strip_comment(raw).rstrip()
        if not code:
            continue
        if code.endswith(":"):
            current = code[:-1]
            labels.setdefault(current, ScriptLabel(name=current))
            continue
        if current:
            m = _SCRIPT_CMD_RE.match(code)
            if m:
                op = m.group(1)
                rest = m.group(2).strip()
                args: Tuple[str, ...] = tuple(a.strip() for a in rest.split(",") if a.strip()) if rest else tuple()
                labels[current].commands.append(ScriptCommand(opcode=op, args=args, line_no=idx))
        
        # Try matching opcodes with leading indentation as well
        if current and not m:
            s = code.lstrip()
            m2 = _SCRIPT_CMD_RE.match(s)
            if m2:
                op = m2.group(1)
                rest = m2.group(2).strip()
                args: Tuple[str, ...] = tuple(a.strip() for a in rest.split(",") if a.strip()) if rest else tuple()
                labels[current].commands.append(ScriptCommand(opcode=op, args=args, line_no=idx))
    return labels


def parse_map_script(path: Path) -> ParsedMapScript:
    lines = path.read_text(encoding="utf-8").splitlines()
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
    movement_blocks = _parse_movement_blocks(lines)
    script_labels = _parse_script_labels(lines)
    return ParsedMapScript(
        label=label,
        path=path,
        object_constants=object_constants,
        object_spawns=spawns,
        coord_events=coord_events,
        callbacks=callbacks,
        movement_blocks=movement_blocks,
        script_labels=script_labels,
    )


# ---------------------------- Metadata loading ----------------------------


def load_warp_metadata(path: Path) -> Tuple[dict, dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return data.get("maps", {}), data


def load_object_metadata(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_initial_events(polished_root: Path) -> Tuple[set[str], set[str]]:
    """Parse InitialEvents and InitialEngineFlags from polishedcrystal ASM.

    Returns (initial_events, initial_engine_flags) as sets of symbol names.
    """
    events_file = polished_root / "data" / "events" / "initialize_events.asm"
    initial: set[str] = set()
    engines: set[str] = set()
    if not events_file.exists():
        return initial, engines
    lines = events_file.read_text(encoding="utf-8").splitlines()
    mode = None
    for raw in lines:
        line = _strip_comment(raw).strip()
        if not line:
            continue
        if line.endswith(":"):
            tag = line[:-1]
            if tag in {"InitialEvents", "InitialEngineFlags"}:
                mode = tag
            else:
                mode = None
            continue
        if mode in {"InitialEvents", "InitialEngineFlags"}:
            if not line.lower().startswith("dw"):
                continue
            parts = [p.strip() for p in line.split()[1:]]
            if not parts:
                continue
            sym = parts[0].rstrip(',')
            if sym in {"-1", "$ffff"}:
                mode = None
                continue
            if mode == "InitialEvents":
                initial.add(sym)
            else:
                engines.add(sym)
    return initial, engines


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


def clamp_scanline_y(y: int) -> int:
    if y < 0:
        return 0
    if y >= SCREEN_HEIGHT_PX:
        return SCREEN_HEIGHT_PX - 1
    return y


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


def _simulate_apply_movement(tokens: Sequence[str], start_xy: Tuple[int, int]) -> List[Tuple[int, int]]:
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
    plausible: List[Tuple[int, int]] = []
    if warp_meta.collision:
        for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0)):
            cx, cy = player_xy[0] + dx, player_xy[1] + dy
            if 0 <= cx < warp_meta.collision.width_cells and 0 <= cy < warp_meta.collision.height_cells:
                plausible.append((cx, cy))
    else:
        plausible = [
            (player_xy[0], player_xy[1] - 1),
            (player_xy[0], player_xy[1] + 1),
            (player_xy[0] - 1, player_xy[1]),
            (player_xy[0] + 1, player_xy[1]),
        ]
    plausible_set = set(plausible)
    for step_xy in npc_path:
        if step_xy in plausible_set:
            return True
    return False


# ---------------------------- Trigger modeling and control flow ----------------------------


_IF_BRANCH_RE = re.compile(r"^if\w+\b.*?(?:,\s*|\s+)([\w\.]+)$", re.IGNORECASE)


def _looks_like_label(token: str) -> bool:
    if not token:
        return False
    if token.startswith('.'):
        return True
    # plain word
    return bool(re.match(r"^[A-Za-z_][A-Za-z0-9_\.]*$", token))


def _collect_label_flow(parsed: ParsedMapScript, start_label: str, max_depth: int = 64, stats: Optional[dict] = None) -> List[ScriptCommand]:
    """Traverse basic control-flow starting at label, following unconditional jumps and simple if-branches.

    Returns a flattened list of commands in a plausible execution order. This is conservative and not exhaustive.
    """
    out: List[ScriptCommand] = []
    visited: set[Tuple[str, int]] = set()

    # Build linear order of labels to support simple fallthrough between adjacent labels
    label_order: List[str] = list(parsed.script_labels.keys())
    next_label_by_name: Dict[str, Optional[str]] = {}
    for i, name in enumerate(label_order):
        next_label_by_name[name] = label_order[i + 1] if i + 1 < len(label_order) else None

    def walk(label: str, depth: int) -> None:
        if depth > max_depth:
            return
        key = (label, depth)
        if key in visited:
            return
        visited.add(key)
        block = parsed.script_labels.get(label)
        if not block:
            return
        i = 0
        while i < len(block.commands):
            cmd = block.commands[i]
            out.append(cmd)
            op = cmd.opcode
            args = cmd.args
            # Follow unconditional jumps and stop linear flow
            if op in {"sjump", "sjumpfwd", "farsjump", "memjump", "jump", "priorityjump", "jumpstd", "stopandsjump"} and args:
                if stats is not None:
                    stats['jumps_followed'] = stats.get('jumps_followed', 0) + 1
                walk(args[0], depth + 1)
                return
            # Inline subroutine calls and continue linear flow afterwards
            if op in {"call", "callstd", "scall", "scallfwd", "farscall", "memcall"} and args:
                if stats is not None:
                    stats['calls_followed'] = stats.get('calls_followed', 0) + 1
                walk(args[0], depth + 1)
                # continue to next command after call
            # Simple conditional forward branch: also explore target label but continue linear flow
            if op.startswith('if'):
                # try last arg as label when plausible
                target: Optional[str] = None
                if args:
                    candidate = args[-1]
                    if _looks_like_label(candidate) and candidate in parsed.script_labels:
                        target = candidate
                if not target:
                    m = _IF_BRANCH_RE.match(f"{op} {', '.join(args)}" if args else op)
                    if m:
                        cand = m.group(1)
                        if _looks_like_label(cand) and cand in parsed.script_labels:
                            target = cand
                if target:
                    if stats is not None:
                        stats['branches_followed'] = stats.get('branches_followed', 0) + 1
                    walk(target, depth + 1)
            # Stop at explicit terminators
            if op in {"end", "endall", "reloadend", "endcallback", "endtext", "done"}:
                return
            i += 1

        # Reached end of block without an explicit jump or end; allow simple fallthrough
        nxt = next_label_by_name.get(label)
        if nxt:
            walk(nxt, depth + 1)

    walk(start_label, 0)
    return out


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
        'jumps_followed': 0,
        'branches_followed': 0,
    }
    maps_dir = polished_path / "maps"
    object_meta = load_object_metadata(object_meta_path)
    warp_maps, warp_root = load_warp_metadata(warp_meta_path)
    # Build normalized label map to resolve ASM map constants (e.g., FAST_SHIP_1F) to metadata labels (e.g., FastShip1F)
    def _norm_label_key(s: str) -> str:
        return ''.join(ch for ch in s if ch not in {'_', ' '}).upper()
    warp_label_by_norm: Dict[str, str] = { _norm_label_key(lbl): lbl for lbl in warp_maps.keys() }
    initial_events, initial_engine_flags = load_initial_events(polished_path / "external" / "polishedcrystal")
    # Apply CLI overrides
    if assume_set_events:
        initial_events = set(initial_events) | set(assume_set_events)
    if assume_clear_events:
        initial_events = set(e for e in initial_events if e not in set(assume_clear_events))

    # Apply scenario presets and/or event override file
    # Scenario presets are simple JSON files at scripts/scenarios/<name>.json with shape {"set": [], "clear": []}
    if scenario:
        scen_path = (atlas_common.ROOT_DIR / "scripts" / "scenarios" / f"{scenario}.json")
        if scen_path.exists():
            try:
                scen = json.loads(scen_path.read_text(encoding="utf-8"))
                scen_set = set(scen.get("set", []) or [])
                scen_clear = set(scen.get("clear", []) or [])
                initial_events = (set(initial_events) | scen_set) - scen_clear
            except Exception as e:
                if debug:
                    print(f"[warn] failed to load scenario '{scenario}' from {scen_path}: {e}")
        else:
            if debug:
                print(f"[info] scenario '{scenario}' not found at {scen_path}; skipping")
    if event_overrides_path:
        try:
            ov = json.loads(event_overrides_path.read_text(encoding="utf-8"))
            ov_set = set(ov.get("set", []) or [])
            ov_clear = set(ov.get("clear", []) or [])
            initial_events = (set(initial_events) | ov_set) - ov_clear
        except Exception as e:
            if debug:
                print(f"[warn] failed to load event overrides from {event_overrides_path}: {e}")

    # Precompute inverse warp mapping: target map label -> list of (dest_x, dest_y)
    incoming_spawns: Dict[str, List[Tuple[int, int]]] = {}
    for src_label, src_data in warp_maps.items():
        for w in src_data.get("warps", []) or []:
            tgt = w.get("target") or {}
            tgt_label = tgt.get("map_label")
            dx = tgt.get("x_cells")
            dy = tgt.get("y_cells")
            if tgt_label and dx is not None and dy is not None:
                incoming_spawns.setdefault(tgt_label, []).append((int(dx), int(dy)))

    # Normalize filters to case-insensitive substring checks
    map_filters_norm = [s.lower() for s in (map_filters or [])]
    label_filters_norm = [s.lower() for s in (label_filters or [])]

    for asm_path in _iter_map_asm_files(maps_dir):
        parsed = parse_map_script(asm_path)
        map_label = parsed.label
        if map_filters_norm:
            label_lc = map_label.lower()
            if not any(sub in label_lc for sub in map_filters_norm):
                continue
        warp_meta = get_warp_meta(warp_maps, map_label)
        is_overworld = warp_meta.is_overworld
        if scope == "overworld" and not is_overworld:
            continue
        if scope == "indoor" and is_overworld:
            continue
        stats['maps_scanned'] += 1

        # Index source warp tiles for this map: (x,y) -> (dest_map, (dx,dy))
        warp_sources_index: Dict[Tuple[int, int], Tuple[str, Tuple[int, int]]] = {}
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

        # optional debug header per map
        if debug:
            print(f"[map] {map_label}: coord_events={len(parsed.coord_events)} callbacks={len(parsed.callbacks)} objects={len(parsed.object_spawns)} movements={len(parsed.movement_blocks)} labels={len(parsed.script_labels)}")

        # Compute base visibility from initial events: objects with a hide_event set are hidden when that event is set
        base_visible_by_name: Dict[str, bool] = {}
        for name, spawn in parsed.object_spawns.items():
            if spawn.hide_event and spawn.hide_event in initial_events:
                base_visible_by_name[name] = False
            else:
                base_visible_by_name[name] = spawn.visible

        # Build triggers:
        triggers: List[Tuple[str, str, List[Tuple[int, int]], Optional[str]]] = []
        # - Coord events
        for ce in parsed.coord_events:
            triggers.append(("coord", ce.label, [(ce.x, ce.y)], None))
        # - Talk-to-NPC events (from object spawns with script_label present in ASM)
        grid = warp_meta.collision
        for spawn in parsed.object_spawns.values():
            if not spawn.script_label:
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
        cb_cells = list({xy for xy in incoming_spawns.get(map_label, [])})
        for cb in parsed.callbacks:
            if cb_cells:
                triggers.append(("callback", cb.label, cb_cells, None))

        # Optional label filtering on triggers
        if label_filters_norm:
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

        # Helper: run immediate arrival sequence on a destination map at dest_xy
        def _run_arrival_on_map(dest_map_label: str, dest_xy: Tuple[int, int]) -> None:
            dest_asm = maps_dir / f"{dest_map_label}.asm"
            if not dest_asm.exists():
                return
            dest_parsed = parse_map_script(dest_asm)
            dest_warp_meta = get_warp_meta(warp_maps, dest_map_label)
            # Build narrow triggers: callbacks on load, plus coord events matching dest_xy
            arrival_triggers: List[Tuple[str, str, List[Tuple[int, int]], Optional[str]]] = []
            if dest_parsed.callbacks:
                for cb in dest_parsed.callbacks:
                    arrival_triggers.append(("callback", cb.label, [dest_xy], None))
            for ce in dest_parsed.coord_events:
                if ce.x == dest_xy[0] and ce.y == dest_xy[1]:
                    arrival_triggers.append(("coord", ce.label, [dest_xy], None))
            if debug:
                print(f"    [arrival] {dest_map_label} triggers={len(arrival_triggers)} at={dest_xy}")
            # State for destination map processing
            dest_object_pos: Dict[str, Tuple[int, int]] = {name: (sp.x, sp.y) for name, sp in dest_parsed.object_spawns.items()}
            for trig_kind2, start_label2, player_cells2, trig_obj2 in arrival_triggers:
                flow2 = _collect_label_flow(dest_parsed, start_label2, stats=stats)
                if debug:
                    print(f"      [flow] start={start_label2} cmds={len(flow2)}")
                temp_pos2: Dict[str, Tuple[int, int]] = {}
                visible2: Dict[str, bool] = {name: sp.visible for name, sp in dest_parsed.object_spawns.items()}
                current_player_cells2: List[Tuple[int, int]] = [dest_xy]
                # On arrival: follower is spawned overlapping the player; first player move keeps follower at warp cell
                arrival_follow_suppress = True
                last_talked2: Optional[str] = trig_obj2 if trig_kind2 == "talk" else None
                follows2: Dict[str, str] = {}
                follow_stack2: List[Tuple[str, str]] = []

                def static_npcs_snapshot2(exclude: Optional[str] = None) -> List[Tuple[int, int]]:
                    o: List[Tuple[int, int]] = []
                    for name, sp in dest_parsed.object_spawns.items():
                        if name == exclude or name == "PLAYER":
                            continue
                        if not visible2.get(name, True):
                            continue
                        pos = temp_pos2.get(name) or (sp.x, sp.y)
                        o.append(pos)
                    return o

                player_warped2 = False
                for cmd2 in flow2:
                    op2 = cmd2.opcode
                    args2 = cmd2.args
                    # Cross-map ops during arrival: annotate and stop. reloadmap/reloadmapafterbattle continue.
                    if op2 in {"warp", "warpfacing", "newloadmap", "warpcheck"}:
                        issues.append(
                            AuditIssue(
                                map_label=dest_map_label,
                                file=str(dest_asm.relative_to(atlas_common.ROOT_DIR)),
                                kind="cross-map",
                                severity="info",
                                details={
                                    "script_label": start_label2,
                                    "line": cmd2.line_no,
                                    "op": op2,
                                    "trigger": trig_kind2,
                                },
                            )
                        )
                        if debug:
                            print("      [warp] encountered in arrival; annotating and stopping at depth 1")
                        player_warped2 = True
                        break
                    if op2 in {"reloadmap", "reloadmapafterbattle"}:
                        # Same-map cleanup; do not annotate or stop. Continue to next command.
                        continue
                    if op2 == "moveobject" and len(args2) >= 3:
                        obj = args2[0]
                        x = _numeric(args2[1])
                        y = _numeric(args2[2])
                        if x is not None and y is not None:
                            temp_pos2[obj] = (int(x), int(y))
                            if obj == "PLAYER":
                                current_player_cells2 = [(int(x), int(y))]
                    elif op2 == "setlasttalked" and len(args2) >= 1:
                        last_talked2 = args2[0]
                    elif op2 == "writeobjectxy" and len(args2) >= 3:
                        obj = args2[0]
                        x = _numeric(args2[1])
                        y = _numeric(args2[2])
                        if x is not None and y is not None:
                            temp_pos2[obj] = (int(x), int(y))
                            if obj == "PLAYER":
                                current_player_cells2 = [(int(x), int(y))]
                    elif op2 == "applymovement" and len(args2) >= 2:
                        obj = args2[0]
                        mov_label = args2[1]
                        block = dest_parsed.movement_blocks.get(mov_label)
                        if not block:
                            continue
                        stats['applymovement_processed'] += 1
                        if debug:
                            print(f"      [apply] obj={obj} move={mov_label} tokens={len(block.tokens)} (arrival)")
                        if obj == "PLAYER":
                            starts2 = current_player_cells2 or [(0, 0)]
                            for pstart2 in starts2:
                                path2 = _simulate_apply_movement(block.tokens, pstart2)
                                if debug:
                                    print(f"        [path] player start={pstart2} len={len(path2)} (arrival)")
                                follower_cell = pstart2  # overlap on arrival
                                suppress = arrival_follow_suppress
                                prev = pstart2
                                # If any NPC is currently following the PLAYER while the Pokémon follower is active, warn
                                npc_followers_of_player2 = [f for f, leader in follows2.items() if leader == "PLAYER"]
                                if npc_followers_of_player2 and include_follower:
                                    for fobj in npc_followers_of_player2:
                                        issues.append(
                                            AuditIssue(
                                                map_label=dest_map_label,
                                                file=str(dest_asm.relative_to(atlas_common.ROOT_DIR)),
                                                kind="follower-collision",
                                                severity="warn",
                                                details={
                                                    "script_label": start_label2,
                                                    "line": cmd2.line_no,
                                                    "object": fobj,
                                                    "player_cell": list(pstart2),
                                                    "trigger": trig_kind2,
                                                    "reason": "npc-following-player conflicts with pokemon follower during player movement",
                                                },
                                            )
                                        )
                                for step_xy2 in path2:
                                    _tmp_issues = count_sprite_usage(
                                            dest_map_label,
                                            player_cell=step_xy2,
                                            moving_npc_cell=None,
                                            static_npcs=static_npcs_snapshot2(None),
                                            follower_cell_override=follower_cell,
                                            object_meta=object_meta,
                                            warp_meta=dest_warp_meta,
                                            include_follower=include_follower,
                                            include_weather=include_weather,
                                            scanline_limit=scanline_limit,
                                            total_limit=total_limit,
                                            context={
                                                "script_label": start_label2,
                                                "line": cmd2.line_no,
                                                "trigger": trig_kind2,
                                                "op": op2,
                                                "move": mov_label,
                                                "phase": "arrival",
                                            },
                                        )
                                    for _it in _tmp_issues:
                                        _it.file = str(dest_asm.relative_to(atlas_common.ROOT_DIR))
                                    issues.extend(_tmp_issues)
                                    # Update follower per-step
                                    if suppress:
                                        suppress = False
                                    else:
                                        follower_cell = prev
                                    prev = step_xy2
                                if path2:
                                    current_player_cells2 = [path2[-1]]
                        else:
                            start_xy2 = temp_pos2.get(obj) or dest_object_pos.get(obj)
                            if start_xy2 is None:
                                continue
                            path2 = _simulate_apply_movement(block.tokens, start_xy2)
                            if debug:
                                print(f"        [path] npc obj={obj} start={start_xy2} len={len(path2)} (arrival)")
                            starts2 = current_player_cells2 or [(0, 0)]
                            for pstart2 in starts2:
                                collided2 = follower_collision_during_path(pstart2, path2, dest_warp_meta)
                                if collided2:
                                    issues.append(
                                        AuditIssue(
                                            map_label=dest_map_label,
                                            file=str(dest_asm.relative_to(atlas_common.ROOT_DIR)),
                                            kind="follower-collision",
                                            severity="warn",
                                            details={
                                                "script_label": start_label2,
                                                "line": cmd2.line_no,
                                                "object": obj,
                                                "move": mov_label,
                                                "player_cell": list(pstart2),
                                                "trigger": trig_kind2,
                                            },
                                        )
                                    )
                                for step_xy2 in path2:
                                    _tmp_issues = count_sprite_usage(
                                            dest_map_label,
                                            player_cell=pstart2,
                                            moving_npc_cell=step_xy2,
                                            static_npcs=static_npcs_snapshot2(obj),
                                            follower_cell_override=None,
                                            object_meta=object_meta,
                                            warp_meta=dest_warp_meta,
                                            include_follower=include_follower,
                                            include_weather=include_weather,
                                            scanline_limit=scanline_limit,
                                            total_limit=total_limit,
                                            context={
                                                "script_label": start_label2,
                                                "line": cmd2.line_no,
                                                "trigger": trig_kind2,
                                                "op": op2,
                                                "move": mov_label,
                                                "object": obj,
                                                "phase": "arrival",
                                            },
                                        )
                                    for _it in _tmp_issues:
                                        _it.file = str(dest_asm.relative_to(atlas_common.ROOT_DIR))
                                    issues.extend(_tmp_issues)
                            if path2:
                                temp_pos2[obj] = path2[-1]
                    elif op2 == "applymovementlasttalked" and len(args2) >= 1:
                        target2 = last_talked2
                        if not target2:
                            continue
                        mov_label = args2[0]
                        block = dest_parsed.movement_blocks.get(mov_label)
                        if not block:
                            continue
                        stats['applymovement_processed'] += 1
                        if debug:
                            print(f"      [apply] obj={target2} move={mov_label} tokens={len(block.tokens)} (arrival lasttalked)")
                        start_xy2 = temp_pos2.get(target2) or dest_object_pos.get(target2)
                        if start_xy2 is None:
                            continue
                        path2 = _simulate_apply_movement(block.tokens, start_xy2)
                        starts2 = current_player_cells2 or [(0, 0)]
                        for pstart2 in starts2:
                            collided2 = follower_collision_during_path(pstart2, path2, dest_warp_meta)
                            if collided2:
                                issues.append(
                                    AuditIssue(
                                        map_label=dest_map_label,
                                        file=str(dest_asm.relative_to(atlas_common.ROOT_DIR)),
                                        kind="follower-collision",
                                        severity="warn",
                                        details={
                                            "script_label": start_label2,
                                            "line": cmd2.line_no,
                                            "object": target2,
                                            "move": mov_label,
                                            "player_cell": list(pstart2),
                                            "trigger": trig_kind2,
                                        },
                                    )
                                )
                            for step_xy2 in path2:
                                _tmp_issues = count_sprite_usage(
                                        dest_map_label,
                                        player_cell=pstart2,
                                        moving_npc_cell=step_xy2,
                                        static_npcs=static_npcs_snapshot2(target2),
                                        follower_cell_override=None,
                                        object_meta=object_meta,
                                        warp_meta=dest_warp_meta,
                                        include_follower=include_follower,
                                        include_weather=include_weather,
                                        scanline_limit=scanline_limit,
                                        total_limit=total_limit,
                                        context={
                                            "script_label": start_label2,
                                            "line": cmd2.line_no,
                                            "trigger": trig_kind2,
                                            "op": op2,
                                            "move": mov_label,
                                            "object": target2,
                                            "phase": "arrival",
                                        },
                                    )
                                for _it in _tmp_issues:
                                    _it.file = str(dest_asm.relative_to(atlas_common.ROOT_DIR))
                                issues.extend(_tmp_issues)
                        if path2:
                            temp_pos2[target2] = path2[-1]
                    elif op2 == "applyonemovement" and len(args2) >= 2:
                        obj = args2[0]
                        token = args2[1]
                        # If moving a currently hidden NPC, assume it should have been visible (same heuristic as applymovement)
                        if not visible2.get(obj, True):
                            sp = dest_parsed.object_spawns.get(obj)
                            if sp and sp.hide_event:
                                _ev_set(ev_state, sp.hide_event, EV_FALSE)
                                visible2[obj] = True
                        start_xy2 = temp_pos2.get(obj) or dest_object_pos.get(obj) or dest_xy
                        path2 = _simulate_apply_movement([token, "step_end"], start_xy2)
                        if debug:
                            print(f"      [apply1] obj={obj} token={token} len={len(path2)} (arrival)")
                        starts2 = current_player_cells2 or [(0, 0)]
                        for pstart2 in starts2:
                            # Collision check against follower for the one-step path
                            if path2 and follower_collision_during_path(pstart2, path2, dest_warp_meta):
                                issues.append(
                                    AuditIssue(
                                        map_label=dest_map_label,
                                        file=str(dest_asm.relative_to(atlas_common.ROOT_DIR)),
                                        kind="follower-collision",
                                        severity="warn",
                                        details={
                                            "script_label": start_label2,
                                            "line": cmd2.line_no,
                                            "object": obj,
                                            "player_cell": list(pstart2),
                                            "trigger": trig_kind2,
                                        },
                                    )
                                )
                            # If player moves one step while an NPC is following PLAYER and Pokémon follower is active, warn
                            if obj == "PLAYER":
                                npc_followers_of_player2 = [f for f, leader in follows2.items() if leader == "PLAYER"]
                                if npc_followers_of_player2 and include_follower:
                                    for fobj in npc_followers_of_player2:
                                        issues.append(
                                            AuditIssue(
                                                map_label=dest_map_label,
                                                file=str(dest_asm.relative_to(atlas_common.ROOT_DIR)),
                                                kind="follower-collision",
                                                severity="warn",
                                                details={
                                                    "script_label": start_label2,
                                                    "line": cmd2.line_no,
                                                    "object": fobj,
                                                    "player_cell": list(pstart2),
                                                    "trigger": trig_kind2,
                                                    "reason": "npc-following-player conflicts with pokemon follower during player movement",
                                                },
                                            )
                                        )
                            for step_xy2 in path2:
                                _tmp_issues = count_sprite_usage(
                                        dest_map_label,
                                        player_cell=pstart2,
                                        moving_npc_cell=step_xy2,
                                        static_npcs=static_npcs_snapshot2(obj),
                                        follower_cell_override=None,
                                        object_meta=object_meta,
                                        warp_meta=dest_warp_meta,
                                        include_follower=include_follower,
                                        include_weather=include_weather,
                                        scanline_limit=scanline_limit,
                                        total_limit=total_limit,
                                        context={
                                            "script_label": start_label2,
                                            "line": cmd2.line_no,
                                            "trigger": trig_kind2,
                                            "op": op2,
                                            "token": token,
                                            "object": obj,
                                            "phase": "arrival",
                                        },
                                    )
                                for _it in _tmp_issues:
                                    _it.file = str(dest_asm.relative_to(atlas_common.ROOT_DIR))
                                issues.extend(_tmp_issues)
                        if path2:
                            temp_pos2[obj] = path2[-1]
                    elif op2 in {"appear", "disappear"} and len(args2) >= 1:
                        obj = args2[0]
                        if op2 == "disappear":
                            visible2[obj] = False
                            temp_pos2.pop(obj, None)
                        else:
                            visible2[obj] = True
                    elif op2 in {"follow", "follownotexact"} and len(args2) >= 2:
                        follower_obj2 = args2[0]
                        leader_obj2 = args2[1]
                        follows2[follower_obj2] = leader_obj2
                        follow_stack2.append((follower_obj2, leader_obj2))
                        if leader_obj2 == "PLAYER" and include_follower:
                            for pstart2 in (current_player_cells2 or [(0, 0)]):
                                issues.append(
                                    AuditIssue(
                                        map_label=dest_map_label,
                                        file=str(dest_asm.relative_to(atlas_common.ROOT_DIR)),
                                        kind="follower-collision",
                                        severity="warn",
                                        details={
                                            "script_label": start_label2,
                                            "line": cmd2.line_no,
                                            "object": follower_obj2,
                                            "player_cell": list(pstart2),
                                            "trigger": trig_kind2,
                                            "reason": "npc-following-player while pokemon follower active",
                                        },
                                    )
                                )
                    elif op2 == "stopfollow":
                        if follow_stack2:
                            last_follower2, _ = follow_stack2.pop()
                            follows2.pop(last_follower2, None)
                        else:
                            follows2.clear()
                    if player_warped2:
                        break

        # Execute per trigger with symbolic event-state traversal
        for trig_kind, start_label, player_cells, trig_obj in triggers:
            if debug:
                print(f"    [symbolic] start={start_label} cells={len(player_cells)} kind={trig_kind}")

            # Build initial tri-state event map
            ev_state: Dict[str, int] = {}
            for ev in initial_events:
                _ev_set(ev_state, ev, EV_TRUE)
            # CLI explicit clears override
            if assume_clear_events:
                for ev in assume_clear_events:
                    _ev_set(ev_state, ev, EV_FALSE)

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
                # Stack of follow pairs to support conservative stopfollow behavior
                follow_stack: List[Tuple[str, str]] = field(default_factory=list)

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
            work: List[Ctx] = [
                Ctx(label=start_label, pc=0, ret=[], temp_pos={}, visible=dict(base_vis), player_cells=list(player_cells), last_talked=(trig_obj if trig_kind == "talk" else None), ev=dict(ev_state))
            ]

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
                    # Stop this path on this map
                    continue
                if op in {"reloadmap", "reloadmapafterbattle"}:
                    # Same-map cleanup; continue traversal like a no-op
                    ctx.pc += 1
                    work.append(ctx)
                    continue

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
                    # Return if possible
                    if ctx.ret:
                        ctx.label, ctx.pc = ctx.ret[-1]
                        ctx.ret = ctx.ret[:-1]
                        work.append(ctx)
                    continue

                # Event state ops
                if op == "setevent" and len(args) >= 1:
                    ev = args[0]
                    _ev_set(ctx.ev, ev, EV_TRUE)
                    for name, sp in parsed.object_spawns.items():
                        if sp.hide_event == ev:
                            ctx.visible[name] = False
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op == "clearevent" and len(args) >= 1:
                    ev = args[0]
                    _ev_set(ctx.ev, ev, EV_FALSE)
                    for name, sp in parsed.object_spawns.items():
                        if sp.hide_event == ev:
                            ctx.visible[name] = True
                    ctx.pc += 1
                    work.append(ctx)
                    continue
                if op == "checkevent" and len(args) >= 1:
                    ev = args[0]
                    ctx.last_check = _ev_get(ctx.ev, ev)
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
                    if target:
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
                        if take_jump is None:
                            # Unknown: fork
                            if branches < max_branches:
                                branches += 1
                                # jump branch
                                work.append(Ctx(label=target, pc=0, ret=list(ctx.ret), temp_pos=dict(ctx.temp_pos), visible=dict(ctx.visible), player_cells=list(ctx.player_cells), last_talked=ctx.last_talked, ev=dict(ctx.ev)))
                                # fallthrough branch
                                ctx2 = Ctx(label=ctx.label, pc=ctx.pc + 1, ret=list(ctx.ret), temp_pos=dict(ctx.temp_pos), visible=dict(ctx.visible), player_cells=list(ctx.player_cells), last_talked=ctx.last_talked, ev=dict(ctx.ev))
                                work.append(ctx2)
                            # else drop both to cap explosion
                        else:
                            if take_jump:
                                ctx.label, ctx.pc = target, 0
                            else:
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
                if op in {"follow", "follownotexact"} and len(args) >= 2:
                    follower_obj = args[0]
                    leader_obj = args[1]
                    # Record the relationship
                    ctx.follows[follower_obj] = leader_obj
                    ctx.follow_stack.append((follower_obj, leader_obj))
                    # If an NPC begins following the player while Pokémon follower is active, warn immediately
                    if leader_obj == "PLAYER" and include_follower:
                        # Use each plausible player cell to annotate risk locations
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
                    # Conservatively clear the most recent follow, or all if unknown
                    if ctx.follow_stack:
                        last_follower, _ = ctx.follow_stack.pop()
                        ctx.follows.pop(last_follower, None)
                    else:
                        ctx.follows.clear()
                    ctx.pc += 1
                    work.append(ctx)
                    continue

                # Movements
                if op == "applymovement" and len(args) >= 2:
                    obj = args[0]
                    mov_label = args[1]
                    block = parsed.movement_blocks.get(mov_label)
                    if block:
                        stats['applymovement_processed'] += 1
                        if obj == "PLAYER":
                            starts = ctx.player_cells or [(0, 0)]
                            for pstart in starts:
                                path = _simulate_apply_movement(block.tokens, pstart)
                                prev = pstart
                                follower_cell = pstart
                                # If any NPC is currently following the PLAYER while the Pokémon follower is active,
                                # this sequence will cause both to attempt occupying the trailing cell.
                                npc_followers_of_player = [f for f, leader in ctx.follows.items() if leader == "PLAYER"]
                                if npc_followers_of_player and include_follower:
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
                                                    "trigger": trig_kind,
                                                    "reason": "npc-following-player conflicts with pokemon follower during player movement",
                                                },
                                            )
                                        )
                                for step_xy in path:
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
                                                "move": mov_label,
                                                "phase": "main",
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
                                        _run_arrival_on_map(d_map, (dx, dy))
                                        # terminate this path on this map after warp
                                        path = []
                                        break
                                    follower_cell = prev
                                    prev = step_xy
                                if path:
                                    ctx.player_cells = [path[-1]]
                        else:
                            # If moving a currently hidden NPC via applymovement, assume it should have been visible (hinted rule)
                            if not ctx.visible.get(obj, True):
                                sp = parsed.object_spawns.get(obj)
                                if sp and sp.hide_event:
                                    _ev_set(ctx.ev, sp.hide_event, EV_FALSE)
                                    ctx.visible[obj] = True
                            start_xy = ctx.temp_pos.get(obj) or object_pos.get(obj)
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
                                                    "object": obj,
                                                    "move": mov_label,
                                                    "player_cell": list(pstart),
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
                                                    "move": mov_label,
                                                    "object": obj,
                                                    "phase": "main",
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
                                                "phase": "main",
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

                if op == "applyonemovement" and len(args) >= 2:
                    obj = args[0]
                    token = args[1]
                    # If moving a hidden NPC, assume it should have been visible (same heuristic as applymovement)
                    if not ctx.visible.get(obj, True):
                        sp = parsed.object_spawns.get(obj)
                        if sp and sp.hide_event:
                            _ev_set(ctx.ev, sp.hide_event, EV_FALSE)
                            ctx.visible[obj] = True
                    start_xy = ctx.temp_pos.get(obj) or object_pos.get(obj)
                    if start_xy is not None:
                        path = _simulate_apply_movement([token, "step_end"], start_xy)
                        for pstart in (ctx.player_cells or [(0, 0)]):
                            # Collision check for the one-step path
                            if path and follower_collision_during_path(pstart, path, warp_meta):
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
                                            "player_cell": list(pstart),
                                            "trigger": trig_kind,
                                        },
                                    )
                                )
                            # If player moves one step while an NPC is following PLAYER and Pokémon follower is active, warn
                            if obj == "PLAYER":
                                npc_followers_of_player = [f for f, leader in ctx.follows.items() if leader == "PLAYER"]
                                if npc_followers_of_player and include_follower:
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
                                                    "trigger": trig_kind,
                                                    "reason": "npc-following-player conflicts with pokemon follower during player movement",
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
                                            "token": token,
                                            "object": obj,
                                            "phase": "main",
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

                # setlasttalked already handled; other ops we ignore but just advance
                ctx.pc += 1
                work.append(ctx)

    return issues


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Audit scripted movements for sprite limits and follower collisions.")
    p.add_argument("--polishedcrystal", type=Path, default=atlas_common.DEFAULT_POLISHED_PATH, help="Path to polishedcrystal repo")
    p.add_argument("--object-meta", type=Path, default=atlas_common.DEFAULT_MAPS_DIR / "object_metadata.json", help="Path to object_metadata.json")
    p.add_argument("--warp-meta", type=Path, default=atlas_common.DEFAULT_MAPS_DIR / "warp_metadata.json", help="Path to warp_metadata.json")
    p.add_argument("--scope", choices=["all", "overworld", "indoor"], default="all")
    p.add_argument("--time", dest="time_of_day", choices=["morn", "day", "nite", "eve"], default="day")
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
