#!/usr/bin/env python3
"""Shared helpers for polished-atlas command line tools.

This module centralises common path resolution, repository loading, and
module caching logic so individual scripts do not need to reimplement the
same plumbing. Keeping the helpers here makes it easier to avoid repeated
parsing of the polishedcrystal repository state within a single process.
"""
from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType
from typing import Dict, Optional, Set, Tuple

import render_map

ROOT_DIR: Path = Path(__file__).resolve().parent.parent
DEFAULT_POLISHED_PATH: Path = ROOT_DIR / "external" / "polishedcrystal"
DEFAULT_MAPS_DIR: Path = ROOT_DIR / "maps"

_repo_cache: Dict[Path, render_map.RepositoryIndex] = {}
_png_cache: Dict[Path, ModuleType] = {}
_time_invariant_cache: Dict[Path, Set[str]] = {}


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
    overcast_index = repo_index.get_overcast_index(map_info, weekday=weekday, events=events)
    palette = repo_index.special_background_palette(
        map_info,
        time_of_day,
        weekday=weekday,
        events=events,
    )
    if palette is None:
        palette = repo_index.environment_palette(map_info, time_of_day)
    palette_copy = [list(row) for row in palette]
    render_map._ensure_palette_rows(palette_copy)
    allows_roof_palette = map_info.map_type in {"TOWN", "ROUTE", "ISOLATED"}
    if (
        allows_roof_palette
        and map_info.tileset != "TILESET_SNOWTOP_MOUNTAIN"
    ):
        if overcast_index is not None:
            roof_override = repo_index.overcast_roof_palette(overcast_index, time_of_day=time_of_day)
        else:
            roof_override = repo_index.roof_palette(map_info.group, time_of_day=time_of_day)
        render_map._apply_roof_color_override(palette_copy, roof_override)
    signature = tuple(
        tuple(tuple(int(channel) for channel in color) for color in row)
        for row in palette_copy
    )
    return overcast_index, signature


def _is_time_invariant_map(
    repo_index: render_map.RepositoryIndex,
    map_info: render_map.MapInfo,
    *,
    events: Set[str],
) -> bool:
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
    cached = _time_invariant_cache.get(root)
    if cached is not None:
        return set(cached)
    event_flags = set(repo_index.initial_event_flags)
    invariant_labels: Set[str] = set()
    for map_info in repo_index.maps.values():
        if _is_time_invariant_map(repo_index, map_info, events=event_flags):
            invariant_labels.add(map_info.label)
    _time_invariant_cache[root] = set(invariant_labels)
    return set(invariant_labels)
