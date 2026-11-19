import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import generate_object_metadata as objects


class ObjectPaletteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        required = os.environ.get("ATLAS_UPSTREAM_ROOT")
        cls.root = Path(required) if required else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not cls.root.exists() and not required:
            raise unittest.SkipTest("Optional upstream checkout unavailable")
        cls.constants = objects.gather_constants(cls.root)
        cls.names = sum((list(group) for group in objects.parse_palette_definitions(cls.root)), [])
        cls.movements = objects.parse_movement_table(cls.root, cls.constants)

    def test_macro_sprites_fruit_facings_and_item_flags(self):
        flag = "EVENT_GOLDENROD_HARBOR_STAR_PIECE"
        maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements, self.names, {flag})
        entries = [obj for m in maps for obj in m.objects]
        ball, = [obj for m in maps if m.label == "Route35CoastSouth" for obj in m.objects
                 if obj.extra_payload.get("item") == "STAR_PIECE"]
        self.assertEqual((ball.sprite_constant, ball.event_flag, ball.event_flag_set),
                         ("SPRITE_BALL_CUT_TREE", flag, True))
        self.assertEqual(ball.to_payload(32, self.names)["palette_override"]["constant"], "PAL_OW_ENV_RED")
        fruits = [obj for obj in entries if obj.macro == "fruittree_event"]
        self.assertEqual({obj.sprite_constant for obj in fruits}, {"SPRITE_BLANK_FRUIT"})
        for obj in fruits:
            apricorn = "APRICORN" in obj.extra_payload["berry"]
            self.assertEqual(obj.extra_payload["fruit_facing"], "FACING_APRICORN" if apricorn else "FACING_BERRY")

    def test_complete_modern_movement_table(self):
        self.assertEqual(len(self.movements), 59)
        self.assertEqual(len(self.movements), self.constants.get("NUM_SPRITEMOVEDATA"))
        for name, movement in self.movements.items():
            self.assertEqual(movement.movement_id, self.constants.get(name))
        self.assertEqual(self.movements["SPRITEMOVEDATA_AQUARIUM_BOTTOM"].palette_flags, 0x90)
        self.assertEqual(self.movements["SPRITEMOVEDATA_BIG_HO_OH"].action, "OBJECT_ACTION_BIG_HO_OH")

    def test_packed_palette_constants_and_components(self):
        self.assertEqual(self.constants.get("PAL_MON_RED"), 0xD1)
        self.assertEqual(self.constants.get("PAL_MON_RED_BLUE"), 0x02)
        self.assertEqual(self.constants.get("PAL_MON_BLUE_RED"), 0x11)
        self.assertEqual(self.constants.get("PAL_MON_TAN"), 0xDE)
        components = objects.mon_palette_components(self.constants, self.names)
        self.assertEqual(len(components), 196)
        self.assertEqual(components["PAL_MON_RED"], {"mon_components": ["PAL_OW_TAN", "PAL_OW_RED"]})
        self.assertEqual(components["PAL_MON_TAN"], {"mon_components": ["PAL_OW_TAN", "PAL_OW_TAN"]})

    def test_priority_masks_and_arch_tree_flags(self):
        # Frontend object ordering consumes these source bits, independently of
        # terrain bit 7. Guard the contract against future upstream renumbering.
        self.assertEqual(self.constants.get("LOW_PRIORITY"), 1)
        self.assertEqual(self.constants.get("HIGH_PRIORITY"), 2)
        for side in ("LEFT", "RIGHT"):
            movement = self.movements[f"SPRITEMOVEDATA_ARCH_TREE_{side}"]
            self.assertTrue(movement.flags2 & self.constants.get("LOW_PRIORITY"))
            self.assertFalse(movement.flags2 & self.constants.get("HIGH_PRIORITY"))
            self.assertTrue(movement.flags1 & self.constants.get("EMOTE_OBJECT"))
            self.assertFalse(movement.flags1 & self.constants.get("MOVE_ANYWHERE"))

    def test_icon_palette_repeats_and_form_alignment(self):
        self.assertEqual(self.constants.get("NUM_PIKACHU"), 6)
        self.assertEqual(self.constants.get("NUM_MAGIKARP"), 20)
        entries = objects.gather_pokemon_icon_metadata(self.root, self.constants)["entries"]
        expected = {
            ("BULBASAUR", "NO_FORM"): "PAL_MON_TAN_GREEN",
            ("QWILFISH", "HISUIAN_FORM"): "PAL_MON_TAN_BLUE",
            ("URSALUNA", "URSALUNA_BLOODMOON_FORM"): "PAL_MON_TAN_RED",
        }
        definitions = objects.mon_palette_components(self.constants, self.names)
        for (species, form), name in expected.items():
            self.assertEqual(entries[species]["forms"][form]["palette"]["normal"], name)
        for entry in entries.values():
            for variant in entry["forms"].values():
                for palette in variant["palette"].values():
                    self.assertIn(palette, definitions)
                self.assertGreater(variant["tile_count"], 0)

    def test_rattata_bounce_frames_and_static_reuse(self):
        movement = self.movements["SPRITEMOVEDATA_RATTATA_BACK"]
        self.assertEqual(movement.action, "OBJECT_ACTION_BOUNCE")
        self.assertEqual(movement.function, "SPRITEMOVEFN_BOUNCE")
        self.assertEqual(movement.flags2, self.constants.get("HIGH_PRIORITY"))
        facings = {f.constant: f for f in objects.parse_facings(self.root, self.constants).values()}
        self.assertEqual([t["tile"] for t in facings["FACING_STEP_DOWN_0"].tiles], [0, 1, 2, 3])
        self.assertEqual([t["tile"] for t in facings["FACING_STEP_UP_0"].tiles], [4, 5, 6, 7])
        _, sprites = objects.parse_sprite_headers(self.root, self.constants)
        art = sprites["SPRITE_RATTATA_BACK"].tile_bytes
        self.assertGreaterEqual(len(art), 128)
        self.assertNotEqual(art[:64], art[64:128])
        maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements, self.names, set())
        uses = [(m.label, o.movement_constant) for m in maps for o in m.objects
                if o.sprite_constant == "SPRITE_RATTATA_BACK"]
        self.assertIn(("Route30", "SPRITEMOVEDATA_RATTATA_BACK"), uses)
        self.assertEqual([kind for label, kind in uses if label == "SilverCaveRoom3"],
                         ["SPRITEMOVEDATA_ARCH_TREE_LEFT"] * 2 + ["SPRITEMOVEDATA_POKECOM_NEWS"])

    def test_aquarium_uses_npc_palettes_and_source_offsets(self):
        maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements, self.names, set())
        aquarium = [o for m in maps for o in m.objects if o.sprite_constant == "SPRITE_AQUARIUM_MON"]
        self.assertEqual(len(aquarium), 15)
        for obj in aquarium:
            payload = obj.to_payload(32, self.names)
            self.assertIsNotNone(obj.species_constant)
            self.assertIsNotNone(obj.species_id)
            self.assertTrue(payload["palette_override"]["constant"].startswith("PAL_OW_"))
            if obj.movement_constant == "SPRITEMOVEDATA_AQUARIUM_TOP":
                self.assertEqual(payload["sprite_y_offset"], -8)
            elif obj.movement_constant == "SPRITEMOVEDATA_AQUARIUM_BOTTOM":
                self.assertEqual(payload["sprite_y_offset"], 4)
        moltres, = [o for o in aquarium if o.species_constant == "MOLTRES"]
        self.assertEqual(moltres.to_payload(32, self.names)["palette_override"]["constant"], "PAL_OW_MOLTRES")
        marill, = [o for m in maps if m.label == "ShamoutiIsland" for o in m.objects if o.species_constant == "MARILL"]
        self.assertEqual(marill.to_payload(32, self.names)["palette_override"]["constant"], "PAL_MON_BLUE")
        for m in maps:
            for obj in m.objects:
                self.assertIn(obj.movement_constant, self.movements, (m.label, obj.raw_text))

    def test_dual_palette_maps_and_facing_flags(self):
        pairs = objects.parse_dual_object_palettes(self.root, self.names)
        self.assertEqual(pairs, {
            "TIN_TOWER_ROOF": ["PAL_OW_RED", "PAL_OW_GREEN"],
            "WHIRL_ISLAND_LUGIA_CHAMBER": ["PAL_OW_ENV_WHITE", "PAL_OW_BLUE"],
            "SHAMOUTI_ISLAND": ["PAL_OW_GREEN", "PAL_OW_BROWN"],
        })
        facings = objects.parse_facings(self.root, self.constants)
        for family, count in [("BIG_HO_OH", 2), ("BIG_LUGIA", 2), ("ALOLAN_EXEGGUTOR", 4)]:
            start = 0 if family == "ALOLAN_EXEGGUTOR" else 1
            for i in range(start, start + count):
                tiles = next(f.tiles for f in facings.values() if f.constant == f"FACING_{family}_{i}")
                self.assertTrue(any(t["attributes"] & 8 for t in tiles))
                self.assertTrue(any(not t["attributes"] & 8 for t in tiles))

    def test_truncated_movement_table_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "data/sprites/map_objects.asm"
            path.parent.mkdir(parents=True)
            path.write_text('; SPRITEMOVEDATA_STILL\n db SPRITEMOVEFN_STANDING\n db DOWN\n')
            with self.assertRaisesRegex(ValueError, "Incomplete movement"):
                objects.parse_movement_table(root, self.constants)


if __name__ == "__main__":
    unittest.main()
