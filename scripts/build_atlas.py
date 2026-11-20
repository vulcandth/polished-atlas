#!/usr/bin/env python3
"""Build one self-contained atlas from a verified upstream commit.

Generated files use the pinned source and the canvas positions of disconnected regions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent


def run(*args: str | Path, cwd: Path = ROOT, env: dict | None = None) -> None:
    print("[build-atlas] " + " ".join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=cwd, env=env, check=True)


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(
        [os.environ.get("GIT_BIN", "git"), "-C", str(repo), *args], text=True
    ).strip()


def load_source(path: Path) -> dict:
    source = json.loads(path.read_text(encoding="utf-8"))
    if source.get("channel") not in {"stable", "dev"}:
        raise ValueError("Source channel must be stable or dev")
    if not re.fullmatch(r"[0-9a-f]{40}", source.get("commit", "")):
        raise ValueError("Upstream source must pin a full lowercase commit SHA")
    for field in ("repository", "ref"):
        if not isinstance(source.get(field), str) or not source[field].strip():
            raise ValueError(f"Missing source {field}")
    return source


def ensure_source(source: dict, destination: Path) -> Path:
    """Never silently reuse or overwrite a different/modified checkout."""
    destination = destination.resolve()
    if not (destination / ".git").exists():
        if destination.exists() and any(destination.iterdir()):
            raise ValueError(f"Refusing non-Git source directory: {destination}")
        destination.mkdir(parents=True, exist_ok=True)
        executable = os.environ.get("GIT_BIN", "git")
        run(executable, "init", destination)
        run(executable, "-C", destination, "remote", "add", "origin", source["repository"])
        run(executable, "-C", destination, "fetch", "--depth=1", "origin", source["commit"])
        run(executable, "-C", destination, "checkout", "--detach", source["commit"])
    actual = git(destination, "rev-parse", "HEAD")
    if actual != source["commit"]:
        raise ValueError(f"Upstream checkout mismatch: expected {source['commit']}, found {actual}. "
                         "Choose a fresh POLISHED_DIR; existing checkouts are never reset.")
    if git(destination, "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError(f"Upstream checkout contains local changes: {destination}")
    return destination


def time_slugs(value: str) -> list[str]:
    aliases = {"0": "morn", "morning": "morn", "1": "day", "daytime": "day",
               "2": "nite", "night": "nite", "nighttime": "nite", "3": "eve", "evening": "eve"}
    slugs = []
    for part in value.split(","):
        part = part.strip().lower()
        if not part:
            continue
        slug = aliases.get(part, part)
        if slug not in {"day", "morn", "nite", "eve"}:
            raise ValueError(f"Unsupported time of day: {part}")
        if slug not in slugs:
            slugs.append(slug)
    if not slugs:
        raise ValueError("At least one time of day is required")
    return (["day"] if "day" in slugs else []) + [x for x in slugs if x != "day"]


def reset_generated(path: Path) -> None:
    owned_root = (ROOT / ".build" / "generated").resolve()
    resolved = path.resolve()
    if resolved.parent != owned_root or resolved.name not in {"stable", "dev"}:
        raise ValueError(f"Refusing to clean non-build directory: {resolved}")
    if resolved.exists():
        shutil.rmtree(resolved)
    resolved.mkdir(parents=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "atlas-source.json")
    parser.add_argument("--assets-only", action="store_true")
    parser.add_argument("--skip-install", action="store_true")
    parser.add_argument("--output", type=Path, default=ROOT / "web/atlas/dist")
    args = parser.parse_args()
    source = load_source(args.source)
    source_dir = Path(os.environ.get("POLISHED_DIR", str(ROOT / "external" / source["commit"])))
    upstream = ensure_source(source, source_dir)
    if source["channel"] == "dev":
        # Run integration tests only after the exact source is available. An
        # explicitly required corpus must fail, never skip, if unavailable.
        run(sys.executable, "-m", "unittest", "discover", "-s", ROOT / "scripts/tests",
            env=dict(os.environ, ATLAS_UPSTREAM_ROOT=str(upstream),
                     ATLAS_UPSTREAM_COMMIT=source["commit"]))
    slugs = time_slugs(os.environ.get("TIME_OF_DAY_SET") or os.environ.get("TIME_OF_DAY") or "day,morn,nite,eve")
    weekday = int(os.environ.get("WEEKDAY", "1"))
    if not 0 <= weekday <= 6:
        raise ValueError("WEEKDAY must be in 0..6")
    generated = ROOT / ".build/generated" / source["channel"]
    reset_generated(generated)
    maps = generated / "maps"
    scripts = ROOT / "scripts"
    overrides = scripts / "event_overrides.json"
    env = dict(os.environ, ATLAS_MAPS_DIR=str(maps), POLISHED_DIR=str(upstream),
               ATLAS_EVENT_OVERRIDES=str(overrides))

    def generate(script: str, *options: str | Path) -> None:
        run(sys.executable, scripts / script, "--polishedcrystal", upstream, *options, env=env)

    for index, slug in enumerate(slugs):
        options = ["--time-of-day", slug, "--weekday", str(weekday), "--format", "sheet"]
        if index:
            options.append("--skip-invariant")
        if os.environ.get("ATLAS_WORKERS"):
            options.extend(["--workers", env["ATLAS_WORKERS"]])
        generate("render_maps.py", *options)
        generate("generate_map_neighborhoods.py", "--time-of-day", slug,
                 "--attributes", upstream / "data/maps/attributes.asm",
                 "--overlay-rules", scripts / "overlay_rules.json",
                 "--overworld-exclude-file", scripts / "overworld_exclude.json")
    generate("generate_warp_metadata.py", "--weekday", str(weekday),
             "--overworld-exclude-file", scripts / "overworld_exclude.json")
    from stitch_report import stitch_report
    manifest = json.loads((maps / slugs[0] / "animated/map_neighborhoods.json").read_text(encoding="utf-8"))
    warp_maps = json.loads((maps / "warp_metadata.json").read_text(encoding="utf-8"))["maps"]
    report = stitch_report(manifest, warp_maps)
    (maps / "stitch_report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    generate("generate_object_metadata.py", "--weekday", str(weekday), "--event-overrides", overrides)
    generate("generate_weather_metadata.py")
    generate("generate_weather_state.py", "--weekday", str(weekday), "--time-of-day", slugs[0],
             "--event-overrides", overrides)
    generate("generate_bg_palette_metadata.py", "--weekday", str(weekday), "--event-overrides", overrides)
    atlas_sha = git(ROOT, "rev-parse", "HEAD")
    dirty = bool(git(ROOT, "status", "--porcelain"))
    info = dict(channel=source["channel"], atlas_commit=atlas_sha, atlas_dirty=dirty,
                upstream=source, settings=dict(weekday=weekday, times=slugs,
                event_overrides=json.loads(overrides.read_text(encoding="utf-8"))),
                public_base=env.get("VITE_PUBLIC_BASE", "/"),
                built_at=datetime.now(timezone.utc).isoformat())
    settings_hash = hashlib.sha256(json.dumps(info["settings"], sort_keys=True).encode()).hexdigest()[:12]
    # Dirty previews can change without a new commit. Give each such generation
    # a distinct cache key so force-cached metadata cannot hide local fixes.
    info["asset_version"] = f"{atlas_sha}-{source['commit']}-{settings_hash}" + (f"-dirty-{info['built_at']}" if dirty else "")
    (generated / "build-info.json").write_text(json.dumps(info, indent=2) + "\n", encoding="utf-8")
    if args.assets_only:
        return
    env.update(VITE_ATLAS_CHANNEL=source["channel"],
               VITE_POLISHED_CRYSTAL_VERSION=f"{source['ref']} ({source['commit'][:12]})",
               VITE_POLISHED_CRYSTAL_COMMIT=source["commit"],
               VITE_POLISHED_CRYSTAL_REPOSITORY=source["repository"].removesuffix(".git"),
               VITE_POLISHED_ATLAS_VERSION=info["asset_version"])
    npm = os.environ.get("NODE_BIN", "npm.cmd" if os.name == "nt" else "npm")
    if not args.skip_install:
        run(npm, "ci", cwd=ROOT / "web/atlas", env=env)
    destination = args.output.resolve()
    # Vite empties its output directory; constrain it to known build locations.
    if destination != ROOT / "web/atlas/dist" and ROOT / ".build" not in destination.parents:
        raise ValueError("--output must be web/atlas/dist or within .build")
    run(npm, "run", "build", "--", "--outDir", destination, cwd=ROOT / "web/atlas", env=env)
    shutil.copytree(maps, destination / "maps")
    shutil.copy2(generated / "build-info.json", destination / "build-info.json")
    from assemble_pages import validate_bundle
    validate_bundle(destination, source["channel"], require_clean=not dirty)
    print(f"[build-atlas] Complete: {destination}")


if __name__ == "__main__":
    main()
