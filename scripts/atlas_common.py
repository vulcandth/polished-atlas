#!/usr/bin/env python3
"""Shared helpers for polished-atlas command line tools.

This module centralises common path resolution, repository loading, and
module caching logic so individual scripts do not need to reimplement the
same plumbing. Keeping the helpers here makes it easier to avoid repeated
parsing of the polishedcrystal repository state within a single process.
"""
from __future__ import annotations

import importlib
import os
import re
import sys
from functools import lru_cache
from pathlib import Path
from types import ModuleType
from typing import Dict, Iterable, Optional, Set, Tuple

import render_map
from map_palette import palette_time
from event_state import has_clock_tile_callback


def scoped_map_lines(lines: Iterable[str]) -> Iterable[str]:
    """Qualify RGBDS local labels and references while preserving source line numbers."""
    scope = ""
    for raw in lines:
        code = raw.partition(";")[0].strip()
        definition = re.fullmatch(r"(\w+)::?", code)
        if definition:
            scope = definition[1]
            yield scope + ":"
            continue
        if re.fullmatch(r"\.\w+:{0,2}", code):
            yield scope + code.rstrip(":") + ":"
            continue
        # A period in a quoted dialogue line or an already-qualified label
        # does not introduce a local reference.
        yield re.sub(r'"[^"]*"|(?<![\w.])(\.\w+)', lambda m: scope + m[1] if m[1] else m[0], code)


ROOT_DIR: Path = Path(__file__).resolve().parent.parent
DEFAULT_POLISHED_PATH: Path = Path(os.environ.get("POLISHED_DIR", str(ROOT_DIR / "external/polishedcrystal")))
DEFAULT_MAPS_DIR: Path = Path(os.environ.get("ATLAS_MAPS_DIR", str(ROOT_DIR / "maps")))

_repo_cache: Dict[Path, render_map.RepositoryIndex] = {}
_png_cache: Dict[Path, ModuleType] = {}
_time_invariant_cache: Dict[tuple[Path, frozenset[str]], Set[str]] = {}


def resolve_path(candidate: Optional[Path], fallback: Path) -> Path:
    """Return the resolved candidate path or the resolved fallback."""
    return (candidate or fallback).resolve()


def repository(polished_path: Path) -> render_map.RepositoryIndex:
    """Return a cached :class:`render_map.RepositoryIndex` for *polished_path*."""
    root = polished_path.resolve()
    cached = _repo_cache.get(root)
    if cached is None:
        cached = render_map.RepositoryIndex(root)
        _repo_cache[root] = cached
    return cached


def png_module(polished_path: Path) -> ModuleType:
    """Return the ``png`` module for *polished_path*, ensuring utils on ``sys.path``."""
    root = polished_path.resolve()
    cached = _png_cache.get(root)
    if cached is None:
        utils_path = root / "utils"
        utils_str = str(utils_path)
        if utils_str not in sys.path:
            sys.path.insert(0, utils_str)
        cached = importlib.import_module("png")
        _png_cache[root] = cached
    return cached


def block_pixel_size() -> int:
    """Return the pixel dimension of a single block."""
    return render_map.MetatileSet.METATILE_DIM * render_map.Tileset.TILE_SIZE


def maps_output_dir(time_slug: Optional[str] = None) -> Path:
    """Return the default output directory for generated map assets."""
    if not time_slug:
        return DEFAULT_MAPS_DIR
    return DEFAULT_MAPS_DIR / time_slug / "animated"


_TIME_OF_DAY_VALUES: Tuple[int, ...] = (0, 1, 2, 3)
_WEEKDAY_VALUES: Tuple[int, ...] = tuple(range(7))


def _palette_signature(
    repo_index: render_map.RepositoryIndex,
    map_info: render_map.MapInfo,
    *,
    time_of_day: int,
    weekday: int,
    events: Set[str],
) -> Tuple[Optional[int], Tuple[Tuple[Tuple[int, int, int], ...], ...]]:
    effective_time = palette_time(map_info.palette_flags, time_of_day)

    overcast_index = repo_index.get_overcast_index(map_info, weekday=weekday, events=events)
    palette = repo_index.special_background_palette(
        map_info,
        effective_time,
        weekday=weekday,
        events=events,
    )
    if palette is None:
        palette = repo_index.environment_palette(map_info, effective_time)
    palette_copy = [list(row) for row in palette]
    render_map._ensure_palette_rows(palette_copy)
    if repo_index.uses_roof_palette(map_info):
        if overcast_index is not None:
            roof_override = repo_index.overcast_roof_palette(overcast_index, time_of_day=effective_time, group=map_info.group)
        else:
            roof_override = repo_index.roof_palette(map_info.group, time_of_day=effective_time)
        render_map._apply_roof_color_override(palette_copy, roof_override)
    signature = tuple(
        tuple(tuple(int(channel) for channel in color) for color in row)
        for row in palette_copy
    )
    return overcast_index, signature


@lru_cache(maxsize=4)
def _time_sensitive_animation_tilesets(root: Path) -> set[str]:
    path = root / "data/tileset_anims.asm"
    if not path.exists():
        return set()
    from tile_animation import parse_tables
    return {label for label, commands in parse_tables(path).items()
            if any(command.function == "AnimateLampLightTiles" for command in commands)}


def _is_time_invariant_map(
    repo_index: render_map.RepositoryIndex,
    map_info: render_map.MapInfo,
    *,
    events: Set[str],
) -> bool:
    # Swap palette tables have independent time/weather variants. Conservatively
    # render each palette rather than reusing a common sheet based on base colors.
    if repo_index.palette_swaps.maps.get(map_info.label):
        return False
    if has_clock_tile_callback(Path(repo_index.root) / "maps" / f"{map_info.label}.asm"):
        return False
    if repo_index.tileset_label(map_info.tileset) in _time_sensitive_animation_tilesets(Path(repo_index.root)):
        from tile_animation_export import context_for_map
        if len({context_for_map(map_info, time, events).time >= 2 for time in _TIME_OF_DAY_VALUES}) > 1:
            return False
    baseline: Optional[Tuple[Optional[int], Tuple[Tuple[Tuple[int, int, int], ...], ...]]] = None
    for weekday in _WEEKDAY_VALUES:
        for time_of_day in _TIME_OF_DAY_VALUES:
            signature = _palette_signature(
                repo_index,
                map_info,
                time_of_day=time_of_day,
                weekday=weekday,
                events=events,
            )
            if baseline is None:
                baseline = signature
            elif signature != baseline:
                return False
    return True


def time_invariant_maps(repo_index: render_map.RepositoryIndex) -> Set[str]:
    """Return the set of maps whose rendering is unaffected by time-of-day or weekday."""
    root = Path(repo_index.root).resolve()
    event_flags = repo_index.initial_event_flags
    cache_key = (root, frozenset(event_flags))
    cached = _time_invariant_cache.get(cache_key)
    if cached is not None:
        return set(cached)
    invariant_labels: Set[str] = set()
    for map_info in repo_index.maps.values():
        variants = [map_info]
        if "IN_DARKNESS" in map_info.palette_flags:
            variants.append(map_info.with_flash())
        if all(_is_time_invariant_map(repo_index, info, events=event_flags) for info in variants):
            invariant_labels.add(map_info.label)
    _time_invariant_cache[cache_key] = set(invariant_labels)
    return set(invariant_labels)
