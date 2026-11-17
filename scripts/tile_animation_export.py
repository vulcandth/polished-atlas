"""Export a map image plus compact, independently timed 8px tile tracks."""
from functools import lru_cache
import json
from pathlib import Path

from map_palette import palette_time
from tile_animation import Context, FRAME_MS, Machine, capture_cycle, encode_tiles, judge_palette, parse_tables, repository_sources


@lru_cache(maxsize=4)
def _sources(root: Path):
    return repository_sources(root), parse_tables(root / "data/tileset_anims.asm")


def context_for_map(map_info, time: int, events: set[str]) -> Context:
    time = palette_time(map_info.palette_flags, time)
    return Context(0, 0, time=time,
                   forest_restless="EVENT_FOREST_IS_RESTLESS" in events,
                   judge_active="ENGINE_JUDGE_MACHINE" in events,
                   darkness="IN_DARKNESS" in map_info.palette_flags)


def compact_track(frames: list[int]) -> tuple[tuple[int, int], ...]:
    """Keep exact frame timing, reducing only mathematically repeating cycles."""
    for length in range(1, len(frames) + 1):
        if len(frames) % length == 0 and all(value == frames[i % length] for i, value in enumerate(frames)):
            frames = frames[:length]
            break
    runs = []
    for frame in frames:
        if runs and runs[-1][0] == frame:
            runs[-1] = (frame, runs[-1][1] + 1)
        else:
            runs.append((frame, 1))
    return tuple(runs)


def _tile_rgb(data: bytes, attribute: int, colors) -> bytes:
    pixels = []
    for y in range(8):
        row = 7 - y if attribute & 0x40 else y
        low, high = data[row * 2:row * 2 + 2]
        for x in range(8):
            bit = x if attribute & 0x20 else 7 - x
            shade = ((low >> bit) & 1) | (((high >> bit) & 1) << 1)
            pixels.extend(colors[shade])
    return bytes(pixels)


def write_animation(root: Path, renderer, png, metadata_path: Path, context: Context) -> dict:
    import palette_swaps
    from render_map import _write_png

    root = root.resolve()
    sources, tables = _sources(root)
    colors = tuple(tuple(tuple(color) for color in row) for row in renderer.attributes.colors)
    judge = tuple(tuple(tuple(channel * 8 for channel in color) for color in row) for row in judge_palette(root))
    machine = Machine(tables[renderer.tileset_label],
                      (encode_tiles(renderer.bank0_tiles), encode_tiles(renderer.bank1_tiles)),
                      sources, [list(row) for row in colors], judge)
    cycle = capture_cycle(machine, context)

    # Group all occurrences with the same graphics, transforms and local palette.
    # Palette swap coordinates are 16px cells; tile positions here are 8px pixels.
    groups = {}
    metatiles = renderer.metatile_data
    for by in range(renderer.height):
        for bx in range(renderer.width):
            block = renderer.block_indices[by * renderer.width + bx]
            for ty in range(4):
                for tx in range(4):
                    index = ty * 4 + tx
                    tile = metatiles[block * 16 + index]
                    attr = renderer.attributes.data[block][index]
                    local = palette_swaps.evaluate(colors, renderer.palette_swaps, bx * 2 + tx // 2, by * 2 + ty // 2)
                    key = (1 if attr & 8 else 0, tile, attr, tuple(local[attr & 7]))
                    groups.setdefault(key, []).append([bx * 32 + tx * 8, by * 32 + ty * 8])
    keys = list(groups)
    history = [[] for _ in keys]
    current = [-1] * len(keys)
    banks = [bytearray(bank) for bank in cycle.banks]
    active_colors = [list(row) for row in cycle.palette]
    animated_colors = {key for _, changes in cycle.changes for key in changes}
    images = []
    image_ids = {}
    for frame, (tiles, changed_colors) in enumerate(cycle.changes):
        for (bank, tile), data in tiles.items():
            banks[bank][tile * 16:(tile + 1) * 16] = data
        for (slot, color), value in changed_colors.items():
            active_colors[slot][color] = value
        changed_slots = {slot for slot, _ in changed_colors}
        for index, (bank, tile, attr, palette) in enumerate(keys):
            if frame == 0 or (bank, tile) in tiles or (attr & 7) in changed_slots:
                palette = list(palette)
                for color in range(4):
                    if (attr & 7, color) in animated_colors:
                        palette[color] = active_colors[attr & 7][color]
                rgb = _tile_rgb(banks[bank][tile * 16:(tile + 1) * 16], attr, palette)
                image_id = image_ids.get(rgb)
                if image_id is None:
                    image_id = len(images)
                    images.append(rgb)
                    image_ids[rgb] = image_id
                current[index] = image_id
            history[index].append(current[index])

    width, height = renderer.width * 32, renderer.height * 32
    rows = [bytearray(width * 3) for _ in range(height)]
    tracks = {}
    for key, frames in zip(keys, history):
        positions = groups[key]
        first = images[frames[0]]
        for x, y in positions:
            for row in range(8):
                rows[y + row][x * 3:(x + 8) * 3] = first[row * 24:(row + 1) * 24]
        compact = compact_track(frames)
        if len(compact) > 1:
            tracks.setdefault(compact, []).extend(positions)

    metadata_path.parent.mkdir(parents=True, exist_ok=True)
    image_path = metadata_path.with_suffix(".png")
    _write_png(image_path, width, height, rows, png)
    # Only animated images belong in the patch atlas; static tiles stay in base.
    used = sorted({tile for track in tracks for tile, _ in track})
    remap = {tile: index for index, tile in enumerate(used)}
    columns = min(128, max(1, len(used)))
    tile_rows = max(1, (len(used) + columns - 1) // columns)
    patch_rows = [bytearray(columns * 8 * 3) for _ in range(tile_rows * 8)]
    for index, tile in enumerate(used):
        x, y = (index % columns) * 8, (index // columns) * 8
        for row in range(8):
            patch_rows[y + row][x * 3:(x + 8) * 3] = images[tile][row * 24:(row + 1) * 24]
    if tile_rows * 8 > 4096:
        raise ValueError(f"Animated tile atlas exceeds texture limit: {metadata_path}")
    payload = {"version": 2, "image": image_path.name, "frameWidth": width, "frameHeight": height,
               "frameCount": 1, "sheetColumns": 1, "frameDurationsMs": [FRAME_MS], "loopDurationMs": FRAME_MS}
    if used:
        tile_path = metadata_path.with_suffix(".tiles.png")
        _write_png(tile_path, columns * 8, tile_rows * 8, patch_rows, png)
        payload["tileAnimation"] = {
            "image": tile_path.name, "tileCount": len(used), "sheetColumns": columns, "frameMs": FRAME_MS,
            "tracks": [{"positions": positions, "frames": [remap[tile] for tile, _ in track],
                        "durations": [duration for _, duration in track]} for track, positions in tracks.items()]}
    metadata_path.write_text(json.dumps(payload, separators=(",", ":")) + "\n", encoding="utf-8")
    return payload
