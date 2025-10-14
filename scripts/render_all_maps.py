#!/usr/bin/env python3
"""Render every polishedcrystal map into PNGs using the threaded renderer."""

from __future__ import annotations

import argparse
import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable, Tuple

import render_map


def parse_args() -> argparse.Namespace:
    default_root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description="Render every polishedcrystal map into PNG images.")
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=default_root / "external/polishedcrystal",
        help="Path to the polishedcrystal repository clone.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=default_root / "maps",
        help="Directory to place rendered PNG files (defaults to ./maps).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Number of worker threads (defaults to min(32, cpu_count + 4)).",
    )
    parser.add_argument(
        "--animated",
        action="store_true",
        help="Render animated GIFs instead of PNGs.",
    )
    return parser.parse_args()


def _default_worker_count() -> int:
    cpu_count = os.cpu_count() or 1
    return min(32, cpu_count + 4)


def _render_single(
    png_module,
    polished_path: Path,
    repo_index: render_map.RepositoryIndex,
    map_label: str,
    output_dir: Path,
    animated: bool,
) -> Tuple[str, Path]:
    # Keep the heavy work in a helper so the thread pool stays focused on rendering.
    renderer = render_map._build_renderer(png_module, polished_path, repo_index, map_label)
    if animated:
        animations = render_map._load_tileset_animations(polished_path, renderer, png_module)
        period = render_map._animation_period(animations)
        frames = []
        for timer in range(period):
            animated_tiles = render_map._apply_tile_animations(renderer.bank0_tiles, animations, timer)
            frames.append(render_map._render_with_tiles(renderer, animated_tiles, renderer.bank1_tiles))
        destination = output_dir / f"{renderer.map_label}.gif"
        render_map._write_gif(destination, frames, render_map._GIF_FRAME_DURATION_MS)
    else:
        width, height, rows = render_map._render_with_tiles(renderer, renderer.bank0_tiles, renderer.bank1_tiles)
        destination = output_dir / f"{renderer.map_label}.png"
        render_map._write_png(destination, width, height, rows, png_module)
    return map_label, destination


def _render_all(
    png_module,
    polished_path: Path,
    repo_index: render_map.RepositoryIndex,
    labels: Iterable[str],
    output_dir: Path,
    workers: int,
    animated: bool,
) -> Tuple[int, Tuple[Tuple[str, Exception], ...]]:
    output_dir.mkdir(parents=True, exist_ok=True)
    errors: list[Tuple[str, Exception]] = []
    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {
            executor.submit(_render_single, png_module, polished_path, repo_index, label, output_dir, animated): label
            for label in labels
        }
        for future in as_completed(futures):
            label = futures[future]
            try:
                future.result()
            except Exception as exc:
                errors.append((label, exc))
    return (len(futures) - len(errors), tuple(errors))


def main() -> None:
    args = parse_args()
    polished_path = args.polishedcrystal.resolve()
    if not polished_path.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {polished_path}")
    output_dir = args.output_dir.resolve()
    workers = args.workers or _default_worker_count()

    sys.path.insert(0, str(polished_path / "utils"))
    import png  # type: ignore

    repo_index = render_map.RepositoryIndex(polished_path)
    labels = sorted(repo_index.maps.keys())
    total = len(labels)
    mode = "animated GIFs" if args.animated else "PNGs"
    print(f"Rendering {total} maps into {output_dir} as {mode} with {workers} worker(s)...")
    rendered, errors = _render_all(png, polished_path, repo_index, labels, output_dir, workers, args.animated)
    print(f"Rendered {rendered}/{total} maps into {output_dir} as {mode}.")
    if errors:
        print("The following maps failed:")
        for label, exc in errors:
            print(f"  {label}: {exc}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
