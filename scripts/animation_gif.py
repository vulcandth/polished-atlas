"""Write a looping GIF from the same tile tracks used by the interactive atlas."""
from bisect import bisect_right
from itertools import accumulate
from math import lcm
from pathlib import Path


def write_track_gif(metadata, directory: Path, destination: Path):
    try:
        from PIL import GifImagePlugin, Image
    except ImportError as exc:
        raise RuntimeError("Animated GIF output requires Pillow (pip install pillow)") from exc

    with Image.open(directory / metadata["image"]) as image:
        canvas = image.convert("RGB")
    animation = metadata.get("tileAnimation")
    if not animation:
        canvas.save(destination, format="GIF")
        return

    frame_ms = animation["frameMs"]
    with Image.open(directory / animation["image"]) as sheet:
        cols = animation["sheetColumns"]
        tiles = []
        for index in range(animation["tileCount"]):
            x, y = index % cols * 8, index // cols * 8
            tiles.append(sheet.crop((x, y, x + 8, y + 8)).convert("RGB"))

    tracks = [(track, list(accumulate(track["durations"]))) for track in animation["tracks"]]
    period = lcm(*(ends[-1] for _, ends in tracks))
    tick = 0
    # Keep a single composite in memory, even for long independent track cycles.
    with destination.open("wb") as output:
        while tick < period:
            next_tick = period
            for track, ends in tracks:
                phase = tick % ends[-1]
                index = bisect_right(ends, phase)
                if tick and (phase == 0 or phase == ends[index - 1]):
                    tile = tiles[track["frames"][index]]
                    for x, y in track["positions"]:
                        canvas.paste(tile, (x, y))
                next_tick = min(next_tick, tick + ends[index] - phase)

            frame = canvas.convert("P", palette=Image.Palette.ADAPTIVE)
            if tick == 0:
                header, _ = GifImagePlugin.getheader(frame, info={"loop": 0})
                output.writelines(header)
            # Round cumulative time to GIF centiseconds so a long loop does not drift.
            duration = 10 * (round(next_tick * frame_ms / 10) - round(tick * frame_ms / 10))
            output.writelines(GifImagePlugin.getdata(frame, duration=duration, include_color_table=bool(tick)))
            tick = next_tick
        output.write(b";")
