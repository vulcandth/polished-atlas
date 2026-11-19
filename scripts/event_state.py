"""One event snapshot for terrain, animation, objects, palettes and weather."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
import re
from typing import Iterable


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
    # Apply it to the starting snapshot so explicit set/clear overrides still win.
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
    return flags


def parse_overrides(path: Path | None = None) -> tuple[set[str], set[str]]:
    """Explicit path takes priority over the build's inherited snapshot settings."""
    if path is None:
        configured = os.environ.get('ATLAS_EVENT_OVERRIDES')
        path = Path(configured) if configured else None
    if path is None:
        return set(), set()
    payload = json.loads(path.read_text(encoding='utf-8'))
    if isinstance(payload, list):
        payload = {'set': payload}
    if not isinstance(payload, dict) or set(payload) - {'set', 'clear'}:
        raise ValueError(f'Invalid event override object: {path}')
    result = []
    for key in ('set', 'clear'):
        values = payload.get(key, [])
        if not isinstance(values, list) or any(
            not isinstance(v, str) or not re.fullmatch(r'(EVENT|ENGINE)_\w+', v) for v in values
        ):
            raise ValueError(f'Invalid {key} event flags: {path}')
        result.append(set(values))
    if result[0] & result[1]:
        raise ValueError(f'Event flags both set and cleared: {path}')
    return result[0], result[1]


def effective_flags(initial: Iterable[str], path: Path | None = None) -> set[str]:
    enabled, disabled = parse_overrides(path)
    return (set(initial) - disabled) | enabled


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
    for line in lines[entry + 1:]:
        if re.fullmatch(r'\w+::?', line):
            break
        if re.fullmatch(r'\.\w+:?', line):
            labels[line.rstrip(':')] = len(commands)
        elif line:
            commands.append(line)
    return commands, labels


@dataclass
class TileCallbackResult:
    flags: set[str]
    block_label: str | None = None
    changes: tuple[tuple[int, int, int], ...] = ()


def evaluate_tile_callback(script: Path, events: set[str]) -> TileCallbackResult:
    """Commit map-local flags and block writes together when the callback returns."""
    commands, labels = _tile_callback(script)
    flags = set(events)
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
