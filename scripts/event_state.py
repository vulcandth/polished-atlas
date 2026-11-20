"""One event snapshot for terrain, animation, objects, palettes and weather."""
from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import re
from map_palette import TIME_NAMES


def stitch_event_flags(root: Path) -> tuple[set[str], set[str]]:
    """Read Atlas object visibility directives attached to upstream event constants."""
    enabled: set[str] = set()
    disabled: set[str] = set()
    path = root / 'constants/event_flags.asm'
    for line in path.read_text(encoding='utf-8').splitlines():
        code, _, comment = line.partition(';')
        marker = comment.strip()
        if marker in {'stitch-set', 'stitch-clear'} and (flag := re.fullmatch(r'\s*const\s+(EVENT_\w+)\s*', code)):
            target = enabled if marker == 'stitch-set' else disabled
            target.add(flag[1])
    conflicts = enabled & disabled
    if conflicts:
        raise ValueError(f'Conflicting stitch directives in {path}: {sorted(conflicts)}')
    return enabled, disabled


def initial_flags(root: Path) -> set[str]:
    flags: set[str] = set()
    section = None
    for raw in (root / 'data/events/initialize_events.asm').read_text(encoding='utf-8').splitlines():
        line = raw.split(';', 1)[0].strip()
        label = re.fullmatch(r'(\w+)::?', line)
        if label:
            section = label[1]
        elif section in {'InitialEvents', 'InitialEngineFlags'} and line.startswith('dw '):
            for token in line[3:].split(','):
                token = token.strip()
                if token.lower() in ('-1', '$ffff'):
                    section = None
                    break
                if not re.fullmatch(r'(EVENT|ENGINE)_\w+', token):
                    raise ValueError(f'Invalid initial event flag: {token}')
                flags.add(token)
    # Both approaches to the switch room run this reset before the room loads.
    # Apply it before the source's stitch directives.
    approach = root / 'maps/GoldenrodUnderground.asm'
    if approach.is_file():
        source = approach.read_text(encoding='utf-8')
        reset = re.search(r'^GoldenrodUndergroundResetSwitches:\s*\n(.*?)^\s*endcallback\b', source, re.M | re.S)
        if reset:
            for operation, flag in re.findall(r'^\s*(setevent|clearevent)\s+(EVENT_DOOR_\d+_OPEN)\b', reset[1], re.M):
                if operation == 'setevent':
                    flags.add(flag)
                else:
                    flags.discard(flag)
    # New games start with the trendy phrase "Prism". The island callback
    # reveals the island only for "Lucky". An atlas snapshot can select the
    # revealed branch by clearing its civilian flag.
    island = root / 'maps/LuckyIsland.asm'
    if island.is_file() and 'special CheckIfTrendyPhraseIsLucky' in island.read_text(encoding='utf-8'):
        flags.add('EVENT_LUCKY_ISLAND_CIVILIANS')
    enabled, disabled = stitch_event_flags(root)
    return (flags - disabled) | enabled


def _bridge_routines(lines: list[str], map_label: str) -> dict[str, list[str]]:
    """Recognize complete assembly routines that write local blocks and redraw."""
    routines = {}
    scope = name = ''
    writes = []
    for line in lines:
        if not line:
            continue
        if re.fullmatch(r'\w+::?|\.\w+:?', line):
            label = line.rstrip(':')
            if not label.startswith('.'):
                scope = label
            name = scope + label if label.startswith('.') else label
            writes = []
        elif name and (match := re.fullmatch(r'changebridgeblock\s+(.+),\s*(\w+)', line)):
            if match[2].replace('_', '') == map_label.upper():
                writes.append(f'changeblock {match[1]}')
            else:
                name = ''
        else:
            if name and writes and line == 'jmp BufferScreen':
                routines[name] = writes
            name = ''
    return routines


@lru_cache(maxsize=1024)
def _tile_callback(script: Path) -> tuple[list[str], dict[str, int]]:
    if not script.is_file():
        return [], {}
    lines = [raw.partition(';')[0].strip() for raw in script.read_text(encoding='utf-8').splitlines()]
    callbacks = [m[1] for line in lines if (m := re.fullmatch(r'callback\s+MAPCALLBACK_TILES,\s*(\w+)', line))]
    if len(callbacks) != 1:
        return [], {}
    entry = next((i for i, line in enumerate(lines) if line.rstrip(':') == callbacks[0]), None)
    if entry is None:
        return [], {}
    commands = []
    labels = {}
    if callbacks[0] == 'GoldenrodUndergroundSwitchRoomUpdateDoorPositions':
        # Its assembler loop expands one flag check per ugdoor_def. Closed
        # doors retain the block from the .ablk, just as on map entry.
        doors = [line.split(None, 1)[1] for line in lines if line.startswith('ugdoor_def ')]
        for door, definition in enumerate(doors, start=1):
            _, *fields = [field.strip() for field in definition.split(',')]
            if not fields or len(fields) % 4:
                raise ValueError(f'Invalid ugdoor_def in {script}: {definition}')
            skip = f'.door_{door}_closed'
            commands.extend((f'checkevent EVENT_DOOR_{door}_OPEN', f'iffalsefwd {skip}'))
            for i in range(0, len(fields), 4):
                x, y, _, opened = fields[i:i+4]
                commands.append(f'changeblock {x}, {y}, {opened}')
            labels[skip] = len(commands)
        commands.append('endcallback')
        return commands, labels
    bridges = _bridge_routines(lines, script.stem) if any(line.startswith('changebridgeblock ') for line in lines) else {}
    for line in lines[entry + 1:]:
        if re.fullmatch(r'\w+::?', line):
            break
        if re.fullmatch(r'\.\w+:?', line):
            labels[line.rstrip(':')] = len(commands)
        elif line.startswith('callasm '):
            target = line.split()[1]
            if target.startswith('.'):
                target = callbacks[0] + target
            commands.extend(bridges.get(target, [line]))
        elif line:
            commands.append(line)
    return commands, labels


@dataclass
class TileCallbackResult:
    flags: set[str]
    block_label: str | None = None
    changes: tuple[tuple[int, int, int], ...] = ()


def has_clock_tile_callback(script: Path) -> bool:
    commands, _ = _tile_callback(script)
    return any(line.startswith('checktime ') for line in commands)


def evaluate_tile_callback(script: Path, events: set[str], *, scene_id: int = 0,
                           clock_time: int = 1) -> TileCallbackResult:
    """Commit map-local flags and block writes together when the callback returns."""
    commands, labels = _tile_callback(script)
    flags = set(events)
    if script.stem in {"HiddenTreeGrotto", "HiddenCaveGrotto"}:
        # HiddenGrottoCallback reveals exactly one kind of content. The
        # first-visit Pokémon snapshot also suppresses the hidden-item tile.
        flags.discard("EVENT_TEMPORARY_UNTIL_MAP_RELOAD_1")
        flags.update(("EVENT_TEMPORARY_UNTIL_MAP_RELOAD_2", "EVENT_TEMPORARY_UNTIL_MAP_RELOAD_3"))
    changes = []
    block_label = None
    pos = 0
    checked = None
    visited = set()
    number = r'(?:\$[0-9a-fA-F]+|\d+)'
    while pos < len(commands) and pos not in visited:
        visited.add(pos)
        line = commands[pos]
        pos += 1
        if line == 'endcallback':
            return TileCallbackResult(flags, block_label, tuple(changes))
        if m := re.fullmatch(r'check(?:event|flag)\s+((?:EVENT|ENGINE)_\w+)', line):
            checked = m[1] in flags
        elif line == 'checkscene':
            checked = bool(scene_id)
        elif m := re.fullmatch(r'checktime\s+1\s*<<\s*(MORN|DAY|NITE|EVE)', line):
            checked = TIME_NAMES[clock_time] == m[1].lower()
        elif line == 'special CheckIfTrendyPhraseIsLucky':
            checked = 'EVENT_LUCKY_ISLAND_CIVILIANS' not in events
        elif m := re.fullmatch(r'(setevent|clearevent)\s+(EVENT_\w+)', line):
            if m[1] == 'setevent':
                flags.add(m[2])
            else:
                flags.discard(m[2])
        elif m := re.fullmatch(r'(iftrue|iffalse|sjump)(?:fwd)?\s+(\.\w+)', line):
            if m[1] != 'sjump' and checked is None:
                break
            if m[1] == 'sjump' or checked == (m[1] == 'iftrue'):
                if m[2] not in labels:
                    break
                pos = labels[m[2]]
        elif m := re.fullmatch(r'changemapblocks\s+(\w+_BlockData)', line):
            block_label = m[1]
            changes.clear()
        elif m := re.fullmatch(rf'changeblock\s+({number}),\s*({number}),\s*({number})', line):
            x, y, block = (int(v[1:], 16) if v.startswith('$') else int(v) for v in m.groups())
            changes.append((x, y, block))
        else:
            break
    return TileCallbackResult(events)
