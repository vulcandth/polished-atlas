import copy
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import atlas_common
import render_map
from animation_assets import validate_compact_animation
from palette_swaps import PaletteSwap, ResolvedSwap
from tile_animation import Command, Context, Machine, capture_cycle, encode_tiles
from tile_animation_export import compact_track, write_animation


class TileAnimationExportTests(unittest.TestCase):
    def test_track_compression_retains_phase_and_blank_ticks(self):
        self.assertEqual(compact_track([1, 1, 2, 1, 1, 2]), ((1, 2), (2, 1)))
        self.assertEqual(compact_track([1, 2, 1]), ((1, 1), (2, 1), (1, 1)))

    def test_every_exported_frame_matches_raster_rendering(self):
        # One block exercises both banks, both flips and spatial palette swaps.
        root = Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        import os
        if os.environ.get("ATLAS_UPSTREAM_ROOT"):
            root = Path(os.environ["ATLAS_UPSTREAM_ROOT"])
        if not root.exists():
            if os.environ.get("ATLAS_UPSTREAM_ROOT"):
                self.fail("Required upstream checkout unavailable")
            self.skipTest("Optional upstream PNG decoder unavailable")
        png = atlas_common.png_module(root)
        colors = [[(slot * 24, shade * 64, 0) for shade in range(4)] for slot in range(8)]
        tile = [(x + y) % 4 for y in range(8) for x in range(8)]
        banks = ([tile] * 128, [list(reversed(tile))] * 128)
        attributes = bytes([0, 0x20, 0x40, 0x60, 0x08, 0x28, 0x48, 0x68] * 2)
        swapped = ((1, 2, 3), (20, 40, 60), (90, 120, 150), (180, 210, 240))
        renderer = SimpleNamespace(width=1, height=1, block_indices=[0], metatile_data=bytes([0, 0, 0, 0, 1, 2, 3, 4] * 2),
                                   bank0_tiles=banks[0], bank1_tiles=banks[1], attributes=render_map.Attributes(attributes, colors),
                                   palette_swaps=(ResolvedSwap(PaletteSwap(0, 1, 0, 2, 0, None, "Swap"), None, swapped),),
                                   tileset_label="TilesetTest")
        commands = (Command("AnimateWaterTile", 0, 0), Command("ScrollFourTilesUpDownLeftRight", 1, 1),
                    Command("StandingTileFrame8"), Command("DoneTileAnimation"))
        sources = {"water_johto": encode_tiles([[i] * 64 for i in range(4)])}
        cycle = capture_cycle(Machine(commands, tuple(encode_tiles(bank) for bank in banks), sources, colors), Context(0, 0))
        with tempfile.TemporaryDirectory() as temp, patch("tile_animation_export._sources", return_value=(sources, {"TilesetTest": commands})), patch("tile_animation_export.judge_palette", return_value=()):
            path = Path(temp) / "Map.animation.json"
            payload = write_animation(root, renderer, png, path, Context(0, 0))
            validate_compact_animation(payload, path, Path(temp))
            def read_image(name):
                _, _, data, _ = png.Reader(bytes=(path.parent / name).read_bytes()).read_flat()
                return bytes(data)
            base = read_image(payload["image"])
            metadata = payload["tileAnimation"]
            atlas = read_image(metadata["image"])
            atlas_width = metadata["sheetColumns"] * 8
            state = [bytearray(bank) for bank in cycle.banks]
            for tick, (changes, _) in enumerate(cycle.changes):
                for (bank, index), data in changes.items():
                    state[bank][index * 16:(index + 1) * 16] = data
                pixels = bytearray(base)
                for track in metadata["tracks"]:
                    remaining = tick % sum(track["durations"])
                    for image, duration in zip(track["frames"], track["durations"]):
                        if remaining < duration:
                            break
                        remaining -= duration
                    ax, ay = (image % metadata["sheetColumns"]) * 8, (image // metadata["sheetColumns"]) * 8
                    for x, y in track["positions"]:
                        for row in range(8):
                            start = ((ay + row) * atlas_width + ax) * 3
                            dest = ((y + row) * 32 + x) * 3
                            pixels[dest:dest + 24] = atlas[start:start + 24]
                _, _, rows = render_map._render_with_tiles(renderer, *[render_map._decode_2bpp_tiles(bytes(bank)) for bank in state])
                self.assertEqual(pixels, bytes(value for row in rows for value in row), f"VBlank {tick}")
            for mutate in (lambda p: p["tileAnimation"].update(image="missing.png"),
                           lambda p: p["tileAnimation"]["tracks"][0]["frames"].__setitem__(0, 999999),
                           lambda p: p["tileAnimation"]["tracks"][0]["positions"].append([32, 0]),
                           lambda p: p["tileAnimation"]["tracks"][0]["durations"].__setitem__(0, 0)):
                broken = copy.deepcopy(payload)
                mutate(broken)
                with self.assertRaises(ValueError):
                    validate_compact_animation(broken, path, Path(temp))


if __name__ == "__main__":
    unittest.main()
