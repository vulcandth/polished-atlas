#!/usr/bin/env python3
"""Validate two channel bundles and assemble one atomic Pages deployment."""
from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path
import shutil
from animation_assets import validate_compact_animation

# GitHub Pages published sites are limited to 1 GB. Leave room for packaging.
MAX_SITE_BYTES = 950_000_000


def validate_bundle(root: Path, channel: str, *, require_clean: bool = True) -> dict:
    root = root.resolve()
    for name in ("index.html", "build-info.json", "maps/warp_metadata.json",
                 "maps/object_metadata.json", "maps/weather_metadata.json",
                 "maps/weather_state.json", "maps/bg_palette_metadata.json"):
        if not (root / name).is_file():
            raise ValueError(f"Missing {channel} bundle file: {name}")
    info = json.loads((root / "build-info.json").read_text(encoding="utf-8"))
    if info.get("channel") != channel or info.get("upstream", {}).get("channel") != channel:
        raise ValueError(f"Expected {channel} build provenance")
    if require_clean and info.get("atlas_dirty", True):
        raise ValueError(f"Cannot publish a dirty {channel} checkout")
    if set(info["settings"]["times"]) != {"day", "morn", "nite", "eve"}:
        raise ValueError(f"Published {channel} bundle must include all four time palettes")
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ValueError(f"Symlinks are not allowed in Pages artifacts: {path}")
    for slug in info["settings"]["times"]:
        manifest = root / "maps" / slug / "animated/map_neighborhoods.json"
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if not data.get("neighborhoods"):
            raise ValueError(f"Empty manifest: {manifest}")
        for entry in data["neighborhoods"]:
            graph = (manifest.parent / entry["graph"]).resolve()
            if root not in graph.parents or not graph.is_file():
                raise ValueError(f"Missing connection graph: {graph}")
            graph_data = json.loads(graph.read_text(encoding="utf-8"))
            if not graph_data.get("maps") or graph_data.get("map_count") != len(graph_data["maps"]):
                raise ValueError(f"Invalid connection graph inventory: {graph}")
            for item in graph_data["maps"].values():
                asset = (root / item["asset"]).resolve()
                if root not in asset.parents or not asset.is_file():
                    raise ValueError(f"Missing map asset: {asset}")
    for path in (root / "maps").rglob("*.animation.json"):
        animation = json.loads(path.read_text(encoding="utf-8"))
        sheet = (path.parent / animation["image"]).resolve()
        if root not in sheet.parents or not sheet.is_file():
            raise ValueError(f"Missing or invalid animation sheet: {sheet}")
        if min(animation["frameCount"], animation["frameWidth"], animation["frameHeight"]) <= 0:
            raise ValueError(f"Invalid animation dimensions: {path}")
        if animation.get("version") == 2:
            validate_compact_animation(animation, path, root)
        elif animation.get("version") != 1:
            raise ValueError(f"Unsupported animation version: {path}")
    warp_maps = json.loads((root / "maps/warp_metadata.json").read_text(encoding="utf-8")).get("maps", {})
    palette_maps = json.loads((root / "maps/bg_palette_metadata.json").read_text(encoding="utf-8")).get("maps", {})
    if not warp_maps:
        raise ValueError("Empty warp map inventory")
    for label, item in warp_maps.items():
        width, height = item["width_blocks"], item["height_blocks"]
        collision = item.get("collision")
        if not collision or collision["width_cells"] != width * 2 or collision["height_cells"] != height * 2:
            raise ValueError(f"Missing or invalid collision dimensions: {label}")
        cells = base64.b64decode(collision["cells"], validate=True)
        if len(cells) != width * height * 4:
            raise ValueError(f"Invalid collision cell count: {label}")
        for slug in info["settings"]["times"]:
            path = root / "maps" / slug / "animated" / f"{label}.animation.json"
            if not path.is_file():
                path = root / "maps/common/animated" / f"{label}.animation.json"
            if not path.is_file():
                raise ValueError(f"Missing {slug} render for {label}")
            animation = json.loads(path.read_text(encoding="utf-8"))
            if animation["frameWidth"] != width * 32 or animation["frameHeight"] != height * 32:
                raise ValueError(f"Map render dimensions do not match metadata: {path}")
            for origin, variant in palette_maps.get(label, {}).get("entrance_variants", {}).items():
                asset_label = variant["asset_label"]
                path = (root / "maps" / slug / "animated" / f"{asset_label}.animation.json").resolve()
                if root not in path.parents or not path.is_file():
                    raise ValueError(f"Missing {slug} entrance variant for {label} from {origin}")
                animation = json.loads(path.read_text(encoding="utf-8"))
                if animation["frameWidth"] != width * 32 or animation["frameHeight"] != height * 32:
                    raise ValueError(f"Entrance render dimensions do not match metadata: {path}")
                rows = variant.get("palettes", {}).get(slug, [])
                if len(rows) != 8 or any(len(row) != 4 for row in rows):
                    raise ValueError(f"Missing {slug} entrance palettes for {label} from {origin}")
    return info


def assemble(stable: Path, dev: Path, destination: Path, *, require_clean: bool = True) -> dict:
    # Validate both BEFORE producing anything deployable. Never merge into an
    # existing output: it could contain stale files from an earlier deployment.
    stable_info = validate_bundle(stable, "stable", require_clean=require_clean)
    dev_info = validate_bundle(dev, "dev", require_clean=require_clean)
    if (stable / "dev").exists():
        raise ValueError("Stable bundle already contains a dev subtree")
    size = sum(p.stat().st_size for root in (stable, dev) for p in root.rglob("*") if p.is_file())
    if size > MAX_SITE_BYTES:
        raise ValueError(f"Combined site exceeds the Pages size budget: {size:,} bytes")
    if destination.exists():
        raise ValueError(f"Assembly destination must not exist: {destination}")
    shutil.copytree(stable, destination)
    shutil.copytree(dev, destination / "dev")
    manifest = {"stable": stable_info, "dev": dev_info, "bytes": size}
    (destination / "deployment.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    (destination / ".nojekyll").touch()
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stable", type=Path)
    parser.add_argument("--dev", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify-site", type=Path, help="Validate a retained combined deployment for rollback")
    parser.add_argument("--allow-dirty", action="store_true", help="Local smoke tests only")
    args = parser.parse_args()
    if args.verify_site:
        root = args.verify_site
        manifest = json.loads((root / "deployment.json").read_text(encoding="utf-8"))
        for channel, path in (("stable", root), ("dev", root / "dev")):
            info = validate_bundle(path, channel)
            if info != manifest[channel]:
                raise ValueError(f"Retained {channel} provenance does not match deployment manifest")
        size = sum(p.stat().st_size for p in root.rglob("*") if p.is_file())
        if size > MAX_SITE_BYTES:
            raise ValueError("Retained site exceeds the Pages size budget")
        print("Verified both retained channels")
        return
    if not all((args.stable, args.dev, args.output)):
        parser.error("Specify --stable, --dev, and --output, or --verify-site")
    result = assemble(args.stable, args.dev, args.output, require_clean=not args.allow_dirty)
    print(f"Validated and assembled both channels ({result['bytes']:,} bytes)")


if __name__ == "__main__":
    main()
