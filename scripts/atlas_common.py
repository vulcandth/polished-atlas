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
from typing import Dict, Optional

import render_map

ROOT_DIR: Path = Path(__file__).resolve().parent.parent
DEFAULT_POLISHED_PATH: Path = ROOT_DIR / "external" / "polishedcrystal"
DEFAULT_MAPS_DIR: Path = ROOT_DIR / "maps"

_repo_cache: Dict[Path, render_map.RepositoryIndex] = {}
_png_cache: Dict[Path, ModuleType] = {}


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
