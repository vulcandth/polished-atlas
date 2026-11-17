"""One event snapshot for terrain, animation, objects, palettes and weather."""
from __future__ import annotations

import json
import os
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
