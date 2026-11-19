"""Validate compact animation assets before publishing a Pages bundle."""
import base64
import math
from pathlib import Path
import struct


def _positive_int(value):
    return type(value) is int and value > 0


def validate_compact_animation(animation: dict, metadata_path: Path, root: Path) -> None:
    if animation.get("version") != 2 or animation.get("frameCount") != 1:
        raise ValueError(f"Invalid compact animation version/base frame count: {metadata_path}")
    width, height = animation.get("frameWidth"), animation.get("frameHeight")
    if not _positive_int(width) or not _positive_int(height):
        raise ValueError(f"Invalid compact animation dimensions: {metadata_path}")

    def png_size(name, *, require_alpha=False):
        if not isinstance(name, str) or not name:
            raise ValueError("Missing compact animation image name")
        path = (metadata_path.parent / name).resolve()
        if root.resolve() not in path.parents or not path.is_file():
            raise ValueError(f"Missing or invalid compact animation image: {path}")
        with path.open("rb") as handle:
            header = handle.read(26)
        if len(header) != 26 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
            raise ValueError(f"Invalid PNG: {path}")
        if require_alpha and (header[24] != 8 or header[25] != 6):
            raise ValueError(f"Terrain priority atlas must use 8-bit RGBA: {path}")
        dimensions = struct.unpack(">II", header[16:24])
        if max(dimensions) > 4096:
            raise ValueError(f"Texture exceeds 4096px: {path}")
        return dimensions

    if png_size(animation.get("image")) != (width, height):
        raise ValueError("Compact map image dimensions do not match metadata")
    if (coverage := animation.get("backgroundCoverage")) is not None:
        tile_count = animation.get("tileAnimation", {}).get("tileCount", 0)
        if not isinstance(coverage, dict) or type(tile_count) is not int or width % 8:
            raise ValueError("Invalid background coverage")
        for key, size in (("base", width // 8 * height), ("frames", tile_count * 8)):
            value = coverage.get(key)
            if not isinstance(value, str) or len(base64.b64decode(value, validate=True)) != size:
                raise ValueError(f"Invalid background coverage {key}")
    for field in ("tileAnimation", "terrainPriority"):
        tiles = animation.get(field)
        if tiles is None:
            continue
        count, columns, frame_ms = tiles.get("tileCount"), tiles.get("sheetColumns"), tiles.get("frameMs")
        if not _positive_int(count) or not _positive_int(columns) or not isinstance(frame_ms, (float, int)) or not math.isfinite(frame_ms) or frame_ms <= 0:
            raise ValueError("Invalid compact tile atlas metadata")
        if png_size(tiles.get("image"), require_alpha=field == "terrainPriority") != (columns * 8, ((count + columns - 1) // columns) * 8):
            raise ValueError("Compact tile atlas dimensions do not match metadata")
        tracks = tiles.get("tracks")
        if not isinstance(tracks, list) or not tracks:
            raise ValueError("Missing compact animation tracks")
        occupied = set()
        for track in tracks:
            frames, durations, positions = track.get("frames"), track.get("durations"), track.get("positions")
            if not isinstance(frames, list) or not frames or not isinstance(durations, list) or len(durations) != len(frames):
                raise ValueError("Invalid compact track frames/durations")
            if any(type(frame) is not int or not 0 <= frame < count for frame in frames) or any(not _positive_int(duration) for duration in durations):
                raise ValueError("Invalid compact track frame index or duration")
            if not isinstance(positions, list) or not positions:
                raise ValueError("Missing compact track positions")
            for position in positions:
                if not isinstance(position, list) or len(position) != 2 or any(type(value) is not int or value < 0 or value % 8 for value in position):
                    raise ValueError("Invalid compact track position")
                x, y = position
                if x + 8 > width or y + 8 > height or (x, y) in occupied:
                    raise ValueError("Out-of-bounds or overlapping compact track position")
                occupied.add((x, y))
