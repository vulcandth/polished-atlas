"""One event snapshot for terrain, animation, objects, palettes and weather."""
from __future__ import annotations

import json
import os
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
                if token == '-1':
                    section = None
                    break
                if not re.fullmatch(r'(EVENT|ENGINE)_\w+', token):
                    raise ValueError(f'Invalid initial event flag: {token}')
                flags.add(token)
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
def conditional_block_changes(script: Path) -> tuple[tuple[str | None, int, int, int], ...]:
    """Read straight-line changeblock commands and forward, flag-guarded groups in source order."""
    if not script.is_file():
        return ()
    lines = [raw.partition(';')[0].strip() for raw in script.read_text(encoding='utf-8').splitlines()]
    source = '\n'.join(line for line in lines if line)
    callbacks = re.findall(r'^callback\s+MAPCALLBACK_TILES,\s*(\w+)$', source, re.M)
    if len(callbacks) != 1:
        return ()
    number = r'(?:\$[0-9a-fA-F]+|\d+)'
    block = rf'changeblock\s+({number}),\s*({number}),\s*({number})'
    body = re.search(rf'^{callbacks[0]}::?\n(.*?)^endcallback$', source, re.M | re.S)
    if not body:
        return ()
    guarded = re.compile(rf'check(?:event|flag) (?P<flag>\w+)\niffalse(?:fwd)? (?P<skip>\.\w+)\n'
                         rf'(?P<blocks>(?:{block}\n)+)(?P=skip):?\n')
    plain = re.compile(block + r'\n')

    def value(token: str) -> int:
        return int(token[1:], 16) if token.startswith('$') else int(token)

    commands = body[1]
    changes = []
    pos = 0
    while pos < len(commands):
        if group := guarded.match(commands, pos):
            changes.extend((group['flag'], value(x), value(y), value(tile))
                           for x, y, tile in plain.findall(group['blocks']))
            pos = group.end()
        elif direct := plain.match(commands, pos):
            changes.append((None, *(value(arg) for arg in direct.groups())))
            pos = direct.end()
        else:
            # A jump or unrecognized command can change which writes execute.
            return ()
    return tuple(changes)
