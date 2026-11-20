from pathlib import Path
import os
import subprocess
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from palette_swaps import PaletteSwap, PaletteSwapIndex, ResolvedSwap, evaluate


def palette(n):
    return ((n, n, n),) * 4


class PaletteSwapTests(unittest.TestCase):
    def test_bounds_are_min_inclusive_max_exclusive(self):
        rect = PaletteSwap(2, 5, 7, 10, 3, None, "Roof")
        for x, y in ((2, 7), (4, 9)):
            self.assertTrue(rect.contains(x, y))
        for x, y in ((1, 7), (5, 7), (2, 6), (2, 10)):
            self.assertFalse(rect.contains(x, y))

    def test_declaration_order_and_null_keep_previous_selection(self):
        base = tuple(palette(n) for n in range(8))
        first = ResolvedSwap(PaletteSwap(2, 8, 2, 8, 3, "water", "museum"), palette(10), palette(11))
        second = ResolvedSwap(PaletteSwap(5, 9, 5, 9, 3, None, "bike"), None, palette(12))
        other = ResolvedSwap(PaletteSwap(0, 9, 0, 9, 2, None, "green"), None, palette(13))
        swaps = (first, second, other)
        self.assertEqual(evaluate(base, swaps, 3, 3)[3], palette(11))
        self.assertEqual(evaluate(base, swaps, 6, 6)[3], palette(12))
        self.assertEqual(evaluate(base, swaps, 9, 9)[3], palette(10))
        self.assertEqual(evaluate(base, swaps, 3, 3)[2], palette(13))
        self.assertEqual(base[3], palette(3))

    def test_scoped_local_table_and_terminator(self):
        lines = ["Map_Header:", "callback MAPCALLBACK_CMDQUEUE, Setup", "Setup:",
                 "usepaletteswap .Table", "endcallback", ".Table:",
                 "paletteswap 0, 5, 0, 255, PAL_BG_WATER, Regular, Roof", "db -1",
                 "Unrelated:", ".Table:", "db 123"]
        swaps = PaletteSwapIndex.parse_map(lines, {"PAL_BG_WATER": 3}, "Map")
        self.assertEqual(len(swaps), 1)
        self.assertEqual(swaps[0].inside, "Roof")
        with self.assertRaisesRegex(ValueError, "control flow"):
            PaletteSwapIndex.parse_map(lines[:3] + ["checkevent EVENT_FOO"] + lines[3:], {"PAL_BG_WATER": 3}, "Map")

    def test_time_and_overcast_selection(self):
        index = object.__new__(PaletteSwapIndex)
        index.maps = {"Test": (PaletteSwap(0, 1, 0, 1, 3, None, "Roof"),)}
        index.palettes = {"Roof": tuple(palette(i) for i in range(8))}
        for time in range(4):
            self.assertEqual(index.resolve("Test", time, False)[0].inside, palette(time))
            self.assertEqual(index.resolve("Test", time, True)[0].inside, palette(time + 4))

    def test_upstream_eight_entry_limit_and_required_terminator(self):
        header = ["Map_Header:", "callback MAPCALLBACK_CMDQUEUE, Setup", "Setup:",
                  "usepaletteswap .Table", "endcallback", ".Table:"]
        entry = "paletteswap 0, 5, 0, 255, PAL_BG_WATER, NULL, Roof"
        slots = {"PAL_BG_WATER": 3}
        self.assertEqual(len(PaletteSwapIndex.parse_map(header + [entry] * 8 + ["db -1"], slots, "Map")), 8)
        for table in ([entry] * 9 + ["db -1"], [entry], ["db -1"]):
            with self.assertRaisesRegex(ValueError, "Invalid palette-swap list"):
                PaletteSwapIndex.parse_map(header + table, slots, "Map")

    def test_composite_renders_each_16px_cell_and_each_animation_frame(self):
        from render_map import Attributes, RendererData, _render_with_tiles
        colors = [tuple((value, value, value) for value in range(4)) for _ in range(8)]
        replacement = tuple((value + 10, value + 10, value + 10) for value in range(4))
        swap = ResolvedSwap(PaletteSwap(1, 2, 0, 1, 3, None, "Roof"), None, replacement)
        renderer = RendererData([0], 1, 1, Attributes(bytes([3] * 16), colors),
                                bytes([0] * 16), [[1] * 64], [], "Test", "Test", "Test", (swap,))
        for shade in (1, 2):
            width, height, rows = _render_with_tiles(renderer, [[shade] * 64], [])
            self.assertEqual((width, height), (32, 32))
            self.assertEqual(rows[0][15 * 3:16 * 3], [shade] * 3)
            self.assertEqual(rows[0][16 * 3:17 * 3], [shade + 10] * 3)
            self.assertEqual(rows[15][31 * 3:32 * 3], [shade + 10] * 3)
            self.assertEqual(rows[16][16 * 3:17 * 3], [shade] * 3)

    def test_pinned_upstream_corpus_when_available(self):
        required_root = os.environ.get("ATLAS_UPSTREAM_ROOT")
        root = Path(required_root) if required_root else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not root.exists():
            if required_root:
                self.fail(f"Required upstream corpus does not exist: {root}")
            self.skipTest("Pinned upstream corpus is not checked out at the optional local test path")
        expected = os.environ.get("ATLAS_UPSTREAM_COMMIT", "c99ae06bb9250bceff01a55204a6afa9a4ba9c7a")
        actual = subprocess.check_output([os.environ.get("GIT_BIN", "git"), "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        self.assertEqual(actual, expected, "Corpus must be the exact pinned upstream revision")
        from render_map import _load_palette
        index = PaletteSwapIndex(root, _load_palette)
        declared = {path.stem for path in (root / "maps").glob("*.asm")
                    if "\tusepaletteswap " in path.read_text(encoding="utf-8")}
        self.assertEqual(set(index.maps), declared)
        self.assertEqual(len(index.maps), 17)
        swaps = index.resolve("GoldenrodCity", 1, False)
        base = tuple(palette(n) for n in range(8))
        self.assertEqual(evaluate(base, swaps, 23, 8)[3], index.palettes["GoldenrodMuseumRoofPalettes"][1])
        self.assertEqual(evaluate(base, swaps, 27, 22)[3], index.palettes["GoldenrodBikeShopRoofPalettes"][1])
        self.assertEqual(evaluate(base, swaps, 0, 0)[3], index.palettes["OverworldWaterPalettes"][1])


if __name__ == "__main__":
    unittest.main()
