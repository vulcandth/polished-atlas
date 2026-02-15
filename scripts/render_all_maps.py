#!/usr/bin/env python3
"""Render polishedcrystal maps into image assets using the threaded renderer."""

from __future__ import annotations

import argparse
import os
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Tuple

import render_map

import atlas_common


@dataclass(frozen=True)
class _RenderTask:
    map_label: str
    output_dir: str
    format_choice: str
    time_of_day: int
    weekday: int
    polished_path: str
    skip_darkness: bool = True


_WORKER_STATE: dict[str, object] = {
    "polished_path": None,
    "repo_index": None,
    "png_module": None,
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Render every polishedcrystal map into visual assets.")
    parser.add_argument(
        "--polishedcrystal",
        type=Path,
        default=atlas_common.DEFAULT_POLISHED_PATH,
        help="Path to the polishedcrystal repository clone.",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=None,
        help="Directory to place rendered assets (defaults to ./maps/<time>/animated).",
    )
    parser.add_argument(
        "--common-output-dir",
        type=Path,
        default=None,
        help="Directory for time-invariant map assets (defaults to ./maps/common/animated).",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=None,
        help="Number of worker processes/threads (defaults to min(32, cpu_count + 4)).",
    )
    parser.add_argument(
        "--animated",
        action="store_true",
        help="Deprecated alias for --format gif.",
    )
    parser.add_argument(
        "--format",
        choices=("sheet", "gif", "png"),
        default="sheet",
        help="Select output format: sprite sheet metadata (sheet), animated GIF (gif), or static PNG (png).",
    )
    parser.add_argument(
        "--time-of-day",
        type=render_map.parse_time_of_day,
        default=1,
        help="Time of day palette (0-3 or morn/day/nite/eve).",
    )
    parser.add_argument(
        "--weekday",
        type=render_map.parse_weekday,
        default=1,
        help="Game weekday (0=Sunday ... 6=Saturday). Accepts names like Monday.",
    )
    parser.add_argument(
        "--executor",
        choices=("process", "thread"),
        default="process",
        help="Parallelism model to use (process for CPU-bound workloads, thread for legacy behaviour).",
    )
    parser.add_argument(
        "--flash-lit",
        action="store_true",
        default=True,
        help="Render dark caves as lit (as if Flash has been used). Enabled by default for visibility.",
    )
    parser.add_argument(
        "--no-flash-lit",
        action="store_false",
        dest="flash_lit",
        help="Render dark caves in their natural dark state.",
    )
    return parser.parse_args()


def _default_worker_count() -> int:
    cpu_count = os.cpu_count() or 1
    return min(32, cpu_count + 4)


def _ensure_worker_state(polished_path: Path) -> Tuple[object, render_map.RepositoryIndex]:
    resolved = polished_path.resolve()
    cached_path = _WORKER_STATE.get("polished_path")
    repo_index = _WORKER_STATE.get("repo_index")
    png_module = _WORKER_STATE.get("png_module")
    if (
        isinstance(repo_index, render_map.RepositoryIndex)
        and cached_path == resolved
        and png_module is not None
    ):
        return png_module, repo_index

    png = atlas_common.png_module(resolved)
    repo = atlas_common.repository(resolved)
    _WORKER_STATE["polished_path"] = resolved
    _WORKER_STATE["png_module"] = png
    _WORKER_STATE["repo_index"] = repo
    return png, repo


def _render_single(
    png_module,
    polished_path: Path,
    repo_index: render_map.RepositoryIndex,
    map_label: str,
    output_dir: Path,
    format_choice: str,
    time_of_day: int,
    weekday: int,
    skip_darkness: bool = True,
) -> Tuple[str, Path]:
    # Keep the heavy work in a helper so the thread pool stays focused on rendering.
    events = repo_index.initial_event_flags
    renderer = render_map._build_renderer(
        png_module,
        polished_path,
        repo_index,
        map_label,
        weekday=weekday,
        time_of_day=time_of_day,
        events=events,
        skip_darkness=skip_darkness,
    )
    if format_choice == "gif":
        animations = render_map._load_tileset_animations(polished_path, renderer, png_module)
        period = render_map._animation_period(animations)
        frames = []
        for timer in range(period):
            animated_tiles = render_map._apply_tile_animations(renderer.bank0_tiles, animations, timer)
            frames.append(render_map._render_with_tiles(renderer, animated_tiles, renderer.bank1_tiles))
        destination = output_dir / f"{renderer.map_label}.gif"
        render_map._write_gif(destination, frames, render_map._GIF_FRAME_DURATION_MS)
        return map_label, destination

    if format_choice == "png":
        width, height, rows = render_map._render_with_tiles(renderer, renderer.bank0_tiles, renderer.bank1_tiles)
        destination = output_dir / f"{renderer.map_label}.png"
        render_map._write_png(destination, width, height, rows, png_module)
        return map_label, destination

    animations = render_map._load_tileset_animations(polished_path, renderer, png_module)
    period = render_map._animation_period(animations)
    frames = []
    for timer in range(period):
        animated_tiles = render_map._apply_tile_animations(renderer.bank0_tiles, animations, timer)
        frames.append(render_map._render_with_tiles(renderer, animated_tiles, renderer.bank1_tiles))
    if not frames:
        frames.append(render_map._render_with_tiles(renderer, renderer.bank0_tiles, renderer.bank1_tiles))
    frame_durations = [render_map._ANIMATION_FRAME_DURATION_MS for _ in frames]
    metadata_path = output_dir / f"{renderer.map_label}.animation.json"
    image_path = metadata_path.with_suffix(".png")
    render_map._write_animation_sheet(metadata_path, image_path, frames, frame_durations, png_module)
    return map_label, metadata_path


def _render_single_task(task: _RenderTask) -> Tuple[str, Path]:
    polished_path = Path(task.polished_path)
    png_module, repo_index = _ensure_worker_state(polished_path)
    return _render_single(
        png_module,
        polished_path,
        repo_index,
        task.map_label,
        Path(task.output_dir),
        task.format_choice,
        task.time_of_day,
        task.weekday,
        task.skip_darkness,
    )


def _render_all(
    png_module,
    polished_path: Path,
    repo_index: render_map.RepositoryIndex,
    labels: Iterable[str],
    output_directories: Dict[str, Path],
    workers: int,
    format_choice: str,
    time_of_day: int,
    weekday: int,
    executor_mode: str,
    skip_darkness: bool = True,
) -> Tuple[int, Tuple[Tuple[str, Exception], ...]]:
    unique_dirs = {path.resolve() for path in output_directories.values()}
    for directory in unique_dirs:
        directory.mkdir(parents=True, exist_ok=True)
    label_list = list(labels)
    errors: List[Tuple[str, Exception]] = []

    if executor_mode == "thread":
        with ThreadPoolExecutor(max_workers=workers) as executor:
            futures: Dict[object, str] = {}
            for label in label_list:
                try:
                    target_dir = output_directories[label]
                except KeyError as exc:
                    raise KeyError(f"No output directory configured for map '{label}'") from exc
                future = executor.submit(
                    _render_single,
                    png_module,
                    polished_path,
                    repo_index,
                    label,
                    target_dir,
                    format_choice,
                    time_of_day,
                    weekday,
                    skip_darkness,
                )
                futures[future] = label
            for future in as_completed(futures):
                label = futures[future]
                try:
                    future.result()
                except Exception as exc:
                    errors.append((label, exc))
        return (len(label_list) - len(errors), tuple(errors))

    tasks: List[_RenderTask] = []
    for label in label_list:
        try:
            target_dir = output_directories[label]
        except KeyError as exc:
            raise KeyError(f"No output directory configured for map '{label}'") from exc
        tasks.append(
            _RenderTask(
                map_label=label,
                output_dir=str(target_dir),
                format_choice=format_choice,
                time_of_day=time_of_day,
                weekday=weekday,
                polished_path=str(polished_path),
                skip_darkness=skip_darkness,
            )
        )
    with ProcessPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(_render_single_task, task): task.map_label for task in tasks}
        for future in as_completed(futures):
            label = futures[future]
            try:
                future.result()
            except Exception as exc:
                errors.append((label, exc))
    return (len(label_list) - len(errors), tuple(errors))


def main() -> None:
    args = parse_args()
    polished_path = args.polishedcrystal.resolve()
    if not polished_path.exists():
        raise FileNotFoundError(f"polishedcrystal repo not found at {polished_path}")
    time_of_day = args.time_of_day
    time_slug = render_map.time_of_day_slug(time_of_day)
    output_dir = (args.output_dir or atlas_common.maps_output_dir(time_slug)).resolve()
    common_output_dir = (args.common_output_dir or atlas_common.maps_output_dir("common")).resolve()
    workers = args.workers or _default_worker_count()
    format_choice = args.format
    if args.animated:
        format_choice = "gif"
    weekday = args.weekday
    executor_mode = args.executor

    png = atlas_common.png_module(polished_path)

    repo_index = atlas_common.repository(polished_path)
    invariant_labels = atlas_common.time_invariant_maps(repo_index)
    labels = sorted(repo_index.maps.keys())
    label_output_dirs: Dict[str, Path] = {
        label: (common_output_dir if label in invariant_labels else output_dir)
        for label in labels
    }
    total = len(labels)
    invariant_count = sum(1 for label in labels if label in invariant_labels)
    variant_count = total - invariant_count
    mode = {
        "gif": "animated GIFs",
        "png": "PNGs",
        "sheet": "sprite sheets",
    }[format_choice]
    if invariant_count and variant_count:
        print(
            f"Rendering {variant_count} time-varying map(s) into {output_dir} and {invariant_count} invariant map(s) into {common_output_dir} as {mode} with {workers} {executor_mode} worker(s)..."
        )
    elif invariant_count:
        print(
            f"Rendering {invariant_count} invariant map(s) into {common_output_dir} as {mode} with {workers} {executor_mode} worker(s)..."
        )
    else:
        print(
            f"Rendering {total} maps into {output_dir} as {mode} with {workers} {executor_mode} worker(s)..."
        )
    rendered, errors = _render_all(
        png,
        polished_path,
        repo_index,
        labels,
        label_output_dirs,
        workers,
        format_choice,
        time_of_day,
        weekday,
        executor_mode,
        skip_darkness=args.flash_lit,
    )
    if invariant_count and variant_count:
        print(
            f"Rendered {rendered}/{total} maps ({variant_count} time-varying, {invariant_count} invariant) into {output_dir} and {common_output_dir} as {mode}."
        )
    elif invariant_count:
        print(f"Rendered {rendered}/{total} maps into {common_output_dir} as {mode}.")
    else:
        print(f"Rendered {rendered}/{total} maps into {output_dir} as {mode}.")
    if errors:
        print("The following maps failed:")
        for label, exc in errors:
            print(f"  {label}: {exc}")
        raise SystemExit(1)


if __name__ == "__main__":
    main()
