import os
from pathlib import Path
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import atlas_common
from generate_bg_palette_metadata import build_payload, Options
from map_palette import palette_time, TIME_NAMES
from render_map import _build_renderer, _load_palette
from tile_animation_export import context_for_map


class MapPaletteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        required = os.environ.get("ATLAS_UPSTREAM_ROOT")
        cls.root = Path(required) if required else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not cls.root.exists():
            if required:
                raise AssertionError("Required upstream checkout unavailable")
            raise unittest.SkipTest("Optional pinned upstream checkout unavailable")
        cls.repo = atlas_common.repository(cls.root)

    def test_every_map_policy_matches_upstream_brightness_table(self):
        source = (self.root / "engine/tilesets/timeofday_pals.asm").read_text(encoding="utf-8")
        rows = re.findall(r"brightlevel\s+(\d),\s*(\d),\s*(\d),\s*(\d)\s*;\s*(PALETTE_\w+)", source)
        policies = {row[-1]: tuple(int(v) for v in row[:4][::-1]) for row in rows}
        self.assertEqual(len(policies), 5)
        constants = (self.root / "constants/map_data_constants.asm").read_text(encoding="utf-8")
        dark = int(re.search(r"DARKNESS_PALSET EQU %([01]+)", constants)[1], 2)
        for info in self.repo.maps.values():
            flags = info.palette_flags
            name, = [f for f in flags if f.startswith("PALETTE_")]
            expected = tuple((dark >> (2 * i)) & 3 for i in range(4)) if "IN_DARKNESS" in flags else policies[name]
            with self.subTest(map=info.label):
                self.assertEqual(tuple(palette_time(flags, i) for i in range(4)), expected)
                self.assertEqual(tuple(context_for_map(info, i, set()).time for i in range(4)), expected)

    def test_terrain_and_npc_background_metadata_agree_at_all_times(self):
        payload = build_payload(Options(self.root, Path("unused.json"), 1, None))
        png = atlas_common.png_module(self.root)
        # Forced night, forced day, darkness outside the old name heuristic,
        # outdoor roofs and spatial swaps are all distinct selection paths.
        for label in ("FuchsiaAquarium1F", "GoldenrodUndergroundWarehouse", "OlivinePokeCenter1F",
                      "GoldenrodUnderground", "GoldenrodUndergroundEntrances", "GoldenrodDeptStoreB1F",
                      "RockTunnel1F", "ScaryCaveShipwreck", "GoldenrodCity", "Route7", "HiddenTreeGrotto"):
            info = self.repo.map_info(label)
            exported = payload["maps"][label]
            for clock, slug in enumerate(TIME_NAMES):
                with self.subTest(map=label, time=slug):
                    renderer = _build_renderer(png, self.root, self.repo, label, weekday=1,
                                               time_of_day=clock, events=self.repo.initial_event_flags)
                    self.assertEqual(renderer.attributes.colors[:7], exported["palettes"][slug][:7])
                    self.assertEqual(exported["palette_times"][slug], TIME_NAMES[palette_time(info.palette_flags, clock)])
                    expected_swaps = self.repo.palette_swaps.resolve(label, palette_time(info.palette_flags, clock), exported["overcast"])
                    self.assertEqual(renderer.palette_swaps, expected_swaps)
            self.assertEqual(exported["darkness"], "IN_DARKNESS" in info.palette_flags)
        aquarium = payload["maps"]["FuchsiaAquarium1F"]
        self.assertEqual(set(aquarium["palette_times"].values()), {"nite"})
        self.assertEqual(aquarium["palettes"]["day"], aquarium["palettes"]["nite"])
        self.assertTrue(payload["maps"]["ScaryCaveShipwreck"]["darkness"])

    def test_judge_screen_blocks_and_palette_animation_share_the_engine_flag(self):
        info = self.repo.map_info("GoldenrodPokecomCenter1F")
        locations = [(x, y) for y in (0, 2) for x in (24, 26, 28)]
        png = atlas_common.png_module(self.root)
        blocks = {}
        for enabled in (False, True):
            flags = {"ENGINE_JUDGE_MACHINE"} if enabled else set()
            renderer = _build_renderer(png, self.root, self.repo, info.label, events=flags)
            self.assertEqual(renderer.block_indices, self.repo.map_blocks(info, flags))
            self.assertEqual(context_for_map(info, 1, flags).judge_active, enabled)
            blocks[enabled] = renderer.block_indices
        indices = [(y // 2) * info.width + x // 2 for x, y in locations]
        self.assertEqual([blocks[True][i] for i in indices], list(range(0x49, 0x4f)))
        changes = {i for i, (a, b) in enumerate(zip(blocks[False], blocks[True])) if a != b}
        self.assertEqual(changes, set(indices))

    def test_special_palette_inventory_and_all_declared_variants(self):
        source = (self.root / "data/maps/palettes.asm").read_text(encoding="utf-8")
        declarations = re.findall(r"^\s*special_bg_pal ", source, re.M)
        self.assertEqual(len(self.repo._special_bg_palettes), len(declarations))
        self.assertGreater(len(declarations), 80)
        for entry in self.repo._special_bg_palettes:
            self.assertTrue(entry.subset)
            if entry.palette_type == "PAL_SPECIAL" or entry.source.startswith("wBGPals1 "):
                continue
            variants = {"PAL_SINGLE": 1, "PAL_TIMEOFDAY": 4, "PAL_TIMEWEATHER": 8}[entry.palette_type]
            with self.subTest(source=entry.source):
                data = self.repo._load_palette_by_label(entry.source)
                self.assertGreaterEqual(len(data), entry.count * variants)
                for time in range(4):
                    for overcast in (False, True):
                        info = self.repo.map_info("GoldenrodCity")
                        result = self.repo._subset_background_palette(entry, info, time, overcast)
                        self.assertEqual(len(result), 7)

    def test_known_rom_colors_offsets_aliases_and_special_cases(self):
        def rgb(*values):
            return [tuple(c * 8 for c in values[i:i + 3]) for i in range(0, len(values), 3)]
        def colors(label, time=1):
            info = self.repo.map_info(label)
            return self.repo.special_background_palette(info, palette_time(info.palette_flags, time), weekday=1)
        aquarium = colors("FuchsiaAquarium1F")
        self.assertEqual(aquarium[2], rgb(12,18,13, 8,13,5, 5,9,4, 0,0,0))
        self.assertEqual(aquarium[0], self.repo.environment_palette(self.repo.map_info("FuchsiaAquarium1F"), 2)[0])
        self.assertEqual(colors("RockTunnel1F")[0], rgb(1,1,2, 0,0,0, 0,0,0, 0,0,0))
        self.assertEqual(colors("DragonShrine")[1], rgb(26,8,7, 17,7,7, 10,3,5, 0,0,0))
        self.assertEqual(colors("HiddenTreeGrotto", 2)[0], rgb(17,11,19, 13,7,14, 11,4,8, 0,0,0))
        self.assertEqual(colors("HiddenTreeGrotto", 1)[0], rgb(31,22,25, 25,14,18, 22,8,10, 3,1,2))
        self.assertEqual(colors("VermilionGym")[4], self.repo._load_palette_by_label("GameCornerPalette")[0])
        for label, roof_slot in (("OlivinePokeCenter1F", 1), ("PewterPokeCenter1F", 3)):
            pals = colors(label)
            self.assertEqual(pals[6], pals[roof_slot])
        self.assertEqual(colors("CherrygroveMart")[2], self.repo._load_palette_by_label("MartBluePalette")[0])
        self.assertEqual(colors("IvysLab")[5], colors("IvysLab")[0])
        entry = next(e for e in self.repo._special_bg_palettes if e.source == "VioletEcruteakPalette")
        info = self.repo.map_info("VioletCity")
        regular = self.repo._subset_background_palette(entry, info, 0, False)
        overcast = self.repo._subset_background_palette(entry, info, 0, True)
        self.assertEqual(regular[1], rgb(28,31,16, 23,12,13, 15,8,9, 7,7,7))
        self.assertEqual(overcast[1], rgb(21,22,16, 15,10,10, 10,7,7, 6,5,5))
        # Overcast roofs use map group, not the old weather-table index.
        group = self.repo.map_info("AzaleaTown").group
        self.assertEqual(self.repo.overcast_roof_palette(1, 1, group=group), ((15*8,14*8,9*8), (11*8,10*8,4*8)))
        for label in ("YellowForest", "FarawayIslandSouth", "SnowtopMountainOutside"):
            self.assertFalse(self.repo.uses_roof_palette(self.repo.map_info(label)))

    def test_nested_reference_palettes_are_not_loaded(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "test.pal"
            path.write_text("if !DEF(MONOCHROME)\nif 0\nRGB 31,31,31\nendc\nRGB 1,2,3, 4,5,6, 7,8,9, 10,11,12\nelse\nRGB 0,0,0\nendc\n")
            self.assertEqual(_load_palette(path), [[(8,16,24), (32,40,48), (56,64,72), (80,88,96)]])
            path.write_text("if SOMETHING_UNKNOWN\nRGB 0,0,0\nendc\n")
            with self.assertRaisesRegex(ValueError, "Unsupported palette condition"):
                _load_palette(path)

    def test_hidden_grotto_origin_colors_match_terrain_and_object_metadata(self):
        # Expected RGB5 colors are from the pinned source, independent of the
        # copy routine. ROOF color 0 must survive all three variants.
        expected = {
            "BELLCHIME_TRAIL": ((31,21,14), (24,15,14)),
            "CHERRYGROVE_BAY": ((31,22,25), (17,11,19)),
            "YELLOW_FOREST": ((31,31,10), (15,16,9)),
        }
        png = atlas_common.png_module(self.root)
        payload = build_payload(Options(self.root, Path("unused.json"), 1, None))
        variant_maps = {label for label, entry in payload["maps"].items() if entry.get("entrance_variants")}
        self.assertEqual(variant_maps, {"HiddenTreeGrotto", "HiddenCaveGrotto"})
        for label in variant_maps:
            info = self.repo.map_info(label)
            entry = payload["maps"][label]
            for time, slug in enumerate(TIME_NAMES):
                generic = self.repo.special_background_palette(info, time)
                for origin, colors in expected.items():
                    with self.subTest(map=label, time=slug, origin=origin):
                        variant = entry["entrance_variants"][origin]
                        self.assertEqual(variant["asset_label"], f"{label}--{origin}")
                        rows = variant["palettes"][slug]
                        self.assertEqual(rows[2][0], tuple(c * 8 for c in colors[time == 2]))
                        self.assertEqual(rows[6][0], generic[6][0])
                        self.assertEqual(rows[6][1:], rows[2][1:])
                        renderer = _build_renderer(png, self.root, self.repo, label,
                                                   time_of_day=time, entrance_map=origin)
                        self.assertEqual(renderer.attributes.colors[:7], rows[:7])
                self.assertEqual(self.repo.special_background_palette(info, time), generic)
                self.assertEqual(self.repo.special_background_palette(info, time, entrance_map="ROUTE_32"), generic)


if __name__ == "__main__":
    unittest.main()
