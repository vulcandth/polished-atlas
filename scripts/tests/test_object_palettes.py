import os
from itertools import product
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import generate_object_metadata as objects
from object_schedule import ObjectSchedule


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

    def test_local_callback_positions_and_weekday_visibility(self):
        maps = {m.label: m for m in objects.parse_map_objects(
            self.root, self.constants, {}, self.movements, self.names, set())}
        def at(name, day, flags):
            original = maps[name].objects
            source = (self.root / "maps" / f"{name}.asm").read_text(encoding="utf8")
            return objects.scheduled_objects(source, original, self.constants, flags, day,
                                             ("day",), set(), set()).get("day", original)

        for flags, x in [(set(), 13), ({"EVENT_RESTORED_POWER_TO_KANTO"}, 14)]:
            officer, = [o for o in at("SilphCo1F", 1, flags) if o.sprite_constant == "SPRITE_OFFICER"]
            self.assertEqual((officer.x_tiles, officer.y_tiles), (x, 1))
        for day in range(7):
            for flags in (set(), {"ENGINE_UNION_CAVE_LAPRAS"}):
                lapras, = [o for o in at("UnionCaveB2F", day, flags) if o.event_flag == "EVENT_UNION_CAVE_B2F_LAPRAS"]
                self.assertEqual(lapras.event_flag_set, bool(flags) or day != 5)

    def test_eusine_visibility_follows_permanent_milestones_across_respawns(self):
        maps = {m.label: m for m in objects.parse_map_objects(
            self.root, self.constants, {}, self.movements, self.names, set())}
        milestones = ("EVENT_FOUGHT_SUICUNE", "EVENT_EUSINE_LEFT_CELADON",
                      "EVENT_EUSINE_HO_OH_ENCOUNTER", "EVENT_EUSINE_HO_OH_FAREWELL", "EVENT_FOUGHT_HO_OH")
        for label in ("EusinesHouse", "TinTower1F"):
            source = (self.root / "maps" / f"{label}.asm").read_text(encoding="utf8")
            original = maps[label].objects
            for fought, left, encounter, farewell, ho_oh in product((False, True), repeat=5):
                flags = {flag for flag, active in zip(milestones, (fought, left, encounter, farewell, ho_oh)) if active}
                rows = objects.scheduled_objects(source, original, self.constants, flags, 1, ("day",),
                                                 set(), set()).get("day", original)
                eusine, = (o for o in rows if o.sprite_constant == "SPRITE_EUSINE")
                at_home = fought and not (left or encounter or farewell)
                in_tower = encounter and not farewell
                with self.subTest(label=label, flags=flags):
                    self.assertEqual(not eusine.event_flag_set, at_home if label == "EusinesHouse" else in_tower)

    def test_unknown_branch_prevents_partial_object_schedule(self):
        source = ("Map:\ncallback MAPCALLBACK_OBJECTS, .setup\nobject_const_def\nconst ACTOR\n"
                  ".setup:\ncheckevent EVENT_OPEN\niffalsefwd .closed\nmoveobject ACTOR, 2, 3\n"
                  "endcallback\n.closed:\ncallasm UnmodeledPlacement\nendcallback\n")
        self.assertIsNone(ObjectSchedule.parse(source))

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

    def test_dojo_and_valerie_schedules(self):
        all_maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements, self.names, set())
        maps = {m.label: m for m in all_maps}
        def schedule(name, weekday, flags):
            rows = maps[name].objects
            source = (self.root / "maps" / (name + ".asm")).read_text(encoding="utf-8")
            variants = objects.scheduled_objects(source, rows, self.constants, flags, weekday,
                                                 objects.TIME_OF_DAY_SLUGS, set(), set())
            return {time: [obj for obj in variants.get(time, rows) if not obj.event_flag_set]
                    for time in objects.TIME_OF_DAY_SLUGS}

        # Morning, day, evening/night. Each late leader also requires their own victory flag.
        expected = (
            ("JASMINE ERIKA", "JASMINE ERIKA", "SABRINA"),
            ("FALKNER JANINE", "FALKNER JANINE", "WALKER"),
            ("PRYCE BLAINE", "PRYCE BLAINE", "LORELEI"),
            ("BROCK MISTY", "BROCK MISTY BLUE", "BLUE"),
            ("BUGSY", "PALMER", "MORTY"),
            ("SURGE", "YELLOW", "CLAIR"),
            ("WHITNEY", "WHITNEY CHUCK", "AGATHA"),
        )
        optional = {"WALKER", "LORELEI", "PALMER", "YELLOW", "AGATHA"}
        flags = {"EVENT_BEAT_" + name for name in ("BLUE", "WALKER", "LORELEI_AGAIN", "PALMER", "YELLOW", "AGATHA")}
        book = ("PINK", "BROWN", "RED", "BLUE", "GREEN", "ENV_YELLOW", "PURPLE")
        for day, (morning, daytime, night) in enumerate(expected):
            for progress in (set(), {"EVENT_BEAT_BLUE"}, flags):
                dojo = schedule("FightingDojo", day, progress)
                for time, names in zip(("morn", "day", "eve", "nite"), (morning, daytime, night, night)):
                    expected_guests = [n for n in names.split() if progress and (n not in optional or progress == flags)]
                    guests = [obj for obj in dojo[time] if obj.resolved_sprite]
                    self.assertEqual([obj.resolved_sprite for obj in guests],
                                     ["SPRITE_" + n for n in expected_guests])
                    for obj in guests:
                        self.assertGreater(obj.x_tiles, 0)
                        self.assertGreater(obj.palette_value, 0)
                        self.assertEqual(obj.movement_id, self.constants.get(obj.movement_constant))
                    if day == 1 and time == "day" and progress:
                        self.assertEqual([(o.x_tiles, o.y_tiles, o.movement_constant, o.palette_value) for o in guests],
                                         [(3, 5, "SPRITEMOVEDATA_STANDING_RIGHT", self.constants.get("PAL_NPC_BLUE")),
                                          (6, 5, "SPRITEMOVEDATA_STANDING_LEFT", self.constants.get("PAL_NPC_PURPLE"))])
            for progress in (set(), {"EVENT_FOUGHT_SUICUNE", "EVENT_BEAT_VALERIE"},
                             {"EVENT_FOUGHT_SUICUNE", "EVENT_BEAT_VALERIE", "ENGINE_VALERIE_MORNING_WALK"}):
                for time, rows in schedule("ValeriesHouse", day, progress).items():
                    fairy_book, = [o for o in rows if o.sprite_constant == "SPRITE_BOOK_PAPER_POKEDEX"]
                    self.assertEqual(fairy_book.palette_value, self.constants.get("PAL_NPC_" + book[day]))
                    self.assertEqual(any(o.sprite_constant == "SPRITE_VALERIE" for o in rows),
                                     bool(progress) and (time != "morn" or "ENGINE_VALERIE_MORNING_WALK" in progress))

    def test_initial_variable_sprites_use_their_assigned_graphics(self):
        maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements, self.names, set())
        _, headers = objects.parse_sprite_headers(self.root, self.constants)
        appearances = {}
        for map_data in maps:
            for obj in map_data.objects:
                sprite = obj.to_payload(32, self.names)["sprite"]
                if "resolved_constant" in sprite:
                    appearances[map_data.label, sprite["constant"]] = sprite["resolved_constant"]
                    self.assertTrue(headers[sprite["resolved_constant"]].tile_bytes)
                    self.assertEqual(sprite["id"], self.constants.get(sprite["constant"]))
        self.assertEqual(appearances, {
            ("CopycatsHouse2F", "SPRITE_COPYCAT"): "SPRITE_LASS",
            ("FuchsiaPokeCenter1F", "SPRITE_JANINE_IMPERSONATOR"): "SPRITE_CUTE_GIRL",
            **{("FuchsiaGym", f"SPRITE_FUCHSIA_GYM_{i}"): "SPRITE_JANINE" for i in range(1, 5)},
        })

    def test_aquarium_weekday_callback_applies_to_both_floors_only(self):
        weekday_exhibits = {"GOLDEEN", "TENTACOOL", "SQUIRTLE", "SHELLDER"}
        weekend_exhibits = {"QWILFISH", "HORSEA", "SEEL", "KRABBY"}
        permanent = {"MAGIKARP", "CORSOLA", "CHINCHOU", "REMORAID", "MANTINE", "STARYU"}
        for day in range(7):
            maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements,
                                             self.names, set(), weekday=day)
            fish = {obj.species_constant for m in maps if m.label.startswith("FuchsiaAquarium")
                    for obj in m.objects if obj.sprite_constant == "SPRITE_AQUARIUM_MON"
                    and not obj.event_flag_set}
            with self.subTest(day=day):
                self.assertEqual(fish, permanent | (weekend_exhibits if day in (0, 6) else weekday_exhibits))
                shrine_elders = [obj for m in maps if m.label == "DragonShrine" for obj in m.objects
                                 if obj.event_flag == "EVENT_TEMPORARY_UNTIL_MAP_RELOAD_1"]
                self.assertEqual(len(shrine_elders), 3)
                self.assertFalse(any(obj.event_flag_set for obj in shrine_elders))

    def test_underground_vendors_follow_the_game_clock(self):
        expected = [
            {"YOUNGER_HAIRCUT_BROTHER", "GRANNY"}, {"GRAMPS"}, {"OLDER_HAIRCUT_BROTHER"},
            {"YOUNGER_HAIRCUT_BROTHER"}, {"OLDER_HAIRCUT_BROTHER"}, {"YOUNGER_HAIRCUT_BROTHER"},
            {"OLDER_HAIRCUT_BROTHER", "GRANNY"},
        ]
        prefix = "EVENT_GOLDENROD_UNDERGROUND_"
        for day in range(7):
            maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements, self.names, set(), weekday=day)
            underground = next(m for m in maps if m.label == "GoldenrodUnderground")
            vendors = underground.objects[:4]
            for time in objects.TIME_OF_DAY_SLUGS:
                visible = {obj.event_flag.removeprefix(prefix) for obj in vendors if not obj.event_flag_set
                           and time in obj.to_payload(32, self.names)["time_of_day"]["slots"]}
                self.assertEqual(visible, set() if day == 1 and time != "morn" else expected[day], (day, time))

    def test_lucky_island_shares_civilian_egg_and_tree_state(self):
        hidden = "EVENT_LUCKY_ISLAND_CIVILIANS"
        collected = "EVENT_GOT_LUCKY_EGG_FROM_LUCKY_ISLAND"
        for flags in ({hidden}, set(), {collected}):
            maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements, self.names, flags)
            island = next(m for m in maps if m.label == "LuckyIsland")
            egg, = [o for o in island.objects if o.event_flag == "EVENT_LUCKY_ISLAND_LUCKY_EGG"]
            self.assertEqual(egg.event_flag_set, bool(flags))
            civilians = [o for o in island.objects if o.event_flag == hidden]
            self.assertEqual(len(civilians), 11)
            self.assertTrue(all(o.event_flag_set == (hidden in flags) for o in civilians))
            for time, berry in zip(objects.TIME_OF_DAY_SLUGS, ("JABOCA_BERRY", "ROWAP_BERRY", "MARANGABERRY", "KEE_BERRY")):
                visible = [o.extra_payload["berry"] for o in civilians if o.macro == "fruittree_event"
                           and not o.event_flag_set and time in objects.decode_time_mask(o.time_mask)]
                self.assertEqual(visible, [] if hidden in flags else [berry])

    def test_chuck_and_gym_boulders_match_the_waterfall_state(self):
        for solved in (False, True):
            flags = {"EVENT_BOULDERS_IN_CIANWOOD_GYM"} if solved else set()
            maps = objects.parse_map_objects(self.root, self.constants, {}, self.movements, self.names, flags)
            gym = next(m for m in maps if m.label == "CianwoodGym")
            visible = [o for o in gym.objects if not o.event_flag_set]
            chuck, = [o for o in visible if (o.x_tiles, o.y_tiles) == (12, 11)]
            self.assertEqual(chuck.sprite_constant, "SPRITE_CHUCK" if solved else "SPRITE_BIG_HO_OH")
            self.assertEqual({(o.x_tiles, o.y_tiles) for o in visible if o.y_tiles == 4},
                             {(12, 4), (13, 4)} if solved else {(9, 4), (16, 4)})

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
