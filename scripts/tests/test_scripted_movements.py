import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import analyze_scripted_movements as movement


class ItemBranchTests(unittest.TestCase):
    def test_item_result_controls_failure_jump_and_text_return(self):
        # A caller can distinguish the two pickup outcomes even when a handler
        # only ends its callee's text. A stale event check must not decide it.
        source = """
Header:
    def_coord_events
    coord_event 1, 1, 0, Start
    def_bg_events
Start:
    setevent EVENT_PREVIOUS
    clearevent EVENT_COLLECTED
    checkevent EVENT_PREVIOUS
    scall Gift
    checkevent EVENT_COLLECTED
    iffalsefwd .NoRoom
    warp Room, 3, 4
.NoRoom:
    warp Room, 5, 6
Gift:
    {gift}
    setevent EVENT_COLLECTED
    end
.NoRoom:
    end
"""
        inputs = (
            "giveitem LUCKY_EGG, iffalsefwd .NoRoom",
            "verbosegiveitems POTION, 2, iffalse_endtext",
            "verbosegiveitemvar LEVEL_BALL, VAR_COINS, iffalse_jumpopenedtext .NoRoom",
            "giveitem_unsafe LUCKY_EGG\n    iffalsefwd .NoRoom",
            "giveitem LUCKY_EGG, 1\n    iffalsefwd .NoRoom",
        )
        with tempfile.TemporaryDirectory() as temp, patch.object(movement.atlas_common, "ROOT_DIR", Path(temp)):
            root = Path(temp)
            (root / "maps").mkdir()
            meta = root / "meta.json"
            meta.write_text(json.dumps({"maps": {"Room": {}}}))
            for gift in inputs:
                with self.subTest(gift=gift):
                    (root / "maps/Room.asm").write_text(source.format(gift=gift))
                    issues = movement.analyze_scripts(root, meta, meta)
                    self.assertCountEqual([i.details["dest_xy"] for i in issues], [[3, 4], [5, 6]])

    def test_pinned_item_handlers_precede_visibility_changes(self):
        configured = os.environ.get("ATLAS_UPSTREAM_ROOT")
        root = Path(configured) if configured else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not configured and not root.exists():
            self.skipTest("Optional upstream checkout unavailable")
        for name, script, target, obj in [
            ("LuckyIsland", "LuckyIslandLuckyEgg", ".NoRoom", "LUCKYISLAND_POKE_BALL"),
            ("HiddenTreeGrotto", "HiddenGrottoItemScript", ".PackFull", "HIDDENTREEGROTTO_ITEM"),
        ]:
            parsed = movement.parse_map_script(root / "maps" / f"{name}.asm")
            commands = parsed.script_labels[script].commands
            if name == "HiddenTreeGrotto":
                self.assertEqual((commands[0].opcode, commands[0].args), ("special", ("GetHiddenGrottoContents",)))
                commands = commands[1:]
            self.assertEqual([c.opcode for c in commands[:4]], ["giveitem", "iffalsefwd", "disappear", "setevent"])
            self.assertEqual(commands[1].args, (script + target,))
            self.assertEqual(commands[0].line_no, commands[1].line_no)
            self.assertEqual(commands[2].args, (obj,))
            failure = parsed.script_labels[script + target].commands
            self.assertEqual(failure[-1].opcode, "endtext")
            self.assertFalse(any(c.opcode in {"disappear", "setevent"} for c in failure))


class SceneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configured = os.environ.get("ATLAS_UPSTREAM_ROOT")
        cls.source = Path(configured) if configured else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not configured and not cls.source.is_dir():
            raise unittest.SkipTest("Optional upstream checkout unavailable")

    def test_table_call_returns_after_inline_text_and_preserves_caller(self):
        source = """
Header:
    def_coord_events
    coord_event 1, 1, 0, Start
    def_bg_events
Start:
    {value}
    scalltable .Table
    checkevent EVENT_SECOND
    iftruefwd .Second
    warp Room, 1, 4
.Second:
    warp Room, 2, 4
.Table:
    dw .First, .Next
.First:
    clearevent EVENT_SECOND
    jumpthisopenedtext
.Next:
    setevent EVENT_SECOND
    checkevent EVENT_SECOND
    iftrue_jumptextfaceplayer OutsideText
    warp Room, 99, 99
"""
        with tempfile.TemporaryDirectory() as temp, patch.object(movement.atlas_common, "ROOT_DIR", Path(temp)):
            root = Path(temp)
            (root / "maps").mkdir()
            meta = root / "meta.json"
            meta.write_text(json.dumps({"maps": {"Room": {}}}))
            for value, expected in [("setval 0", [1]), ("readvar VAR_WEEKDAY", [2]),
                                    ("readvar VAR_PLAYERGENDER", [1, 2])]:
                with self.subTest(value=value):
                    (root / "maps/Room.asm").write_text(source.format(value=value))
                    issues = movement.analyze_scripts(root, meta, meta, weekday=1)
                    self.assertCountEqual([i.details["dest_xy"] for i in issues], [[x, 4] for x in expected])

    def test_scientist_escorts_player_through_door_before_research_center_scene(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(movement.atlas_common, "ROOT_DIR", Path(temp)):
            root = Path(temp)
            (root / "maps").mkdir()
            for name in ("RuinsOfAlphOutside", "RuinsOfAlphResearchCenter"):
                (root / f"maps/{name}.asm").write_bytes((self.source / f"maps/{name}.asm").read_bytes())
            macros = root / "macros/scripts"
            macros.mkdir(parents=True)
            (macros / "movement.asm").write_bytes((self.source / "macros/scripts/movement.asm").read_bytes())
            meta = root / "meta.json"
            door = {"index": 7, "x_cells": 23, "y_cells": 17, "target": {
                "map_label": "RuinsOfAlphResearchCenter", "x_cells": 4, "y_cells": 7}}
            meta.write_text(json.dumps({"maps": {
                "RuinsOfAlphOutside": {"warps": [door]},
                "RuinsOfAlphResearchCenter": {"map_constant": "RUINS_OF_ALPH_RESEARCH_CENTER"}}}))
            steps = []
            def observe(name, **args):
                context = args["context"]
                if context.get("phase") == "arrival" and context.get("move") == "RuinsOfAlphResearchCenterApproachesComputerMovement":
                    steps.append((args["player_cell"], args["moving_npc_cell"]))
                return []
            with patch.object(movement, "count_sprite_usage", side_effect=observe):
                issues = movement.analyze_scripts(root, meta, meta, map_filters=["RuinsOfAlphOutside"],
                    label_filters=["RuinsOfAlphOutsideScientistScript"],
                    assume_clear_events=["EVENT_RUINS_OF_ALPH_OUTSIDE_SCIENTIST"])
            self.assertTrue(any(i.details.get("op") == "warpcheck" and i.details["dest_xy"] == [4, 7] for i in issues))
            self.assertEqual(steps[:3], [((4, 7), (5, 6)), ((4, 7), (5, 5)), ((4, 7), (4, 5))])

    def test_only_the_front_shrine_entrance_starts_the_deferred_walk(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(movement.atlas_common, "ROOT_DIR", Path(temp)):
            root = Path(temp)
            (root / "maps").mkdir()
            (root / "maps/DragonShrine.asm").write_bytes((self.source / "maps/DragonShrine.asm").read_bytes())
            arrivals = [(2, 4, 13), (3, 4, 1), (4, 5, 1)]
            meta = root / "meta.json"
            meta.write_text(json.dumps({"maps": {"DragonShrine": {}, "DragonsDenB1F": {"warps": [
                {"index": i, "target": {"map_label": "DragonShrine", "x_cells": x, "y_cells": y}}
                for i, x, y in arrivals]}}}))
            # Load the normal movement macro declarations for this pinned map.
            macros = root / "macros/scripts"
            macros.mkdir(parents=True)
            (macros / "movement.asm").write_bytes((self.source / "macros/scripts/movement.asm").read_bytes())
            walk = []
            def observe(*args, **kwargs):
                if kwargs["context"].get("move") == "DragonShrinePlayerWalkInMovement":
                    walk.append(kwargs["player_cell"])
                return []
            with patch.object(movement, "count_sprite_usage", side_effect=observe):
                movement.analyze_scripts(root, meta, meta, label_filters=["DragonShrineTakeTestScene"])
            self.assertEqual(walk, [(4, y) for y in range(12, 6, -1)])

    def test_lighthouse_exit_steps_down_only_on_its_doorway(self):
        with tempfile.TemporaryDirectory() as temp, patch.object(movement.atlas_common, "ROOT_DIR", Path(temp)):
            root = Path(temp)
            (root / "maps").mkdir()
            (root / "maps/OlivineCity.asm").write_bytes((self.source / "maps/OlivineCity.asm").read_bytes())
            meta = root / "meta.json"
            cells = [(33, 21), (33, 20), (10, 21)]
            meta.write_text(json.dumps({"maps": {"OlivineCity": {}, "Origin": {"warps": [
                {"index": i, "target": {"map_label": "OlivineCity", "x_cells": x, "y_cells": y}}
                for i, (x, y) in enumerate(cells, 1)]}}}))
            steps = []

            def observe(name, **kwargs):
                if kwargs["context"].get("token") == "step_down":
                    steps.append(kwargs["player_cell"])
                return []

            with patch.object(movement, "count_sprite_usage", side_effect=observe):
                movement.analyze_scripts(root, meta, meta, label_filters=["OlivineCityStepDownScene"])
            self.assertEqual(steps, [(33, 22)])

    def test_cable_car_arrivals_in_both_directions(self):
        stations = {"Route3CableCarGate": "ROUTE_3_CABLE_CAR_GATE",
                    "MountMoonSquareCableCarGate": "MOUNT_MOON_SQUARE_CABLE_CAR_GATE"}
        with tempfile.TemporaryDirectory() as temp, patch.object(movement.atlas_common, "ROOT_DIR", Path(temp)):
            root = Path(temp)
            (root / "maps").mkdir()
            for directory, file in [("macros/scripts", "movement.asm"), ("data/maps", "scenes.asm")]:
                (root / directory).mkdir(parents=True)
                (root / directory / file).write_bytes((self.source / directory / file).read_bytes())
            for station in stations:
                source = (self.source / "maps" / f"{station}.asm").read_text(encoding="utf8")
                # Observe the attendant after the upstream reset, with a one-step probe.
                reset = "moveobject ROUTE3CABLECARGATE_RECEPTIONIST, 6, 6"
                self.assertEqual(source.count(reset), 1)
                source = source.replace(reset, reset + "\n\tapplyonemovement " + station.upper() + "_RECEPTIONIST, step_right")
                (root / "maps" / f"{station}.asm").write_text(source, encoding="utf8")
            meta = root / "meta.json"
            meta.write_text(json.dumps({"maps": {n: {"map_constant": c} for n,c in stations.items()}}))
            for start, end in (tuple(stations), tuple(reversed(stations))):
                steps, reset_steps = [], []
                def observe(name, **kwargs):
                    ctx = kwargs["context"]
                    if name == end and ctx["trigger"] == "scene":
                        if ctx.get("move", "").endswith(".LeaveCableCarMovement"):
                            steps.append(kwargs["player_cell"])
                        if ctx.get("token") == "step_right":
                            reset_steps.append(kwargs["moving_npc_cell"])
                    return []
                with self.subTest(start=start), patch.object(movement, "count_sprite_usage", side_effect=observe):
                    issues = movement.analyze_scripts(root, meta, meta, map_filters=[start],
                                                      label_filters=[start + "ReceptionistScript"])
                    self.assertIn((end, [6, 4]), [(i.details.get("dest_map"), i.details.get("dest_xy")) for i in issues])
                    self.assertEqual(steps, [(6, 5), (6, 6), (6, 7)])
                    self.assertEqual(reset_steps, [(7, 6)])


class CartMovementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        configured = os.environ.get("ATLAS_UPSTREAM_ROOT")
        root = Path(configured) if configured else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not configured and not root.exists():
            raise unittest.SkipTest("Optional upstream checkout unavailable")
        cls.gym = root / "maps/AzaleaGym.asm"

    def test_repeats_half_steps_and_shared_tails(self):
        parsed = movement.parse_map_script(self.gym)
        blocks = parsed.movement_blocks
        self.assertEqual(len(parsed.object_spawns), 11)
        refs = {c.args[1] for label in parsed.script_labels.values() for c in label.commands
                if c.opcode == "applymovement"}
        self.assertEqual(len(refs), 30)
        self.assertEqual(refs, set(blocks))
        crawl = blocks["SpinarakCart1Script.CrawlUpMovement"].tokens
        path = movement._simulate_apply_movement(crawl, (2, 18))
        self.assertEqual(path[5:11], [(6, 16.5), (7, 16.5), (8, 16.5), (9, 16.5), (10, 16.5), (11, 16.5)])
        self.assertEqual(path[-1], (6, 15))
        fourth = "SpinarakCart4Script.CrawlUpMiddleMovement"
        self.assertEqual(blocks[fourth + "1"].tokens, ["step_up"] + ["step_right"] * 5 + ["step_up", "step_end"])
        self.assertEqual(blocks[fourth + "2_BlueDisabled"].tokens, blocks[fourth + "3_BlueEnabled_RedDisabled"].tokens)

    def test_fourth_cart_round_trips_with_each_switch_combination(self):
        source = self.gym.read_text(encoding="utf-8")
        positions = (2, 6, 11)
        flags = ("EVENT_TEMPORARY_UNTIL_MAP_RELOAD_1", "EVENT_TEMPORARY_UNTIL_MAP_RELOAD_2")
        # Northern terminal reached from each of the three southern terminals.
        routes = {
            (False, False): (11, 2, 6), (True, False): (11, 6, 2),
            (False, True): (2, 11, 6), (True, True): (6, 11, 2),
        }
        with tempfile.TemporaryDirectory() as temp, patch.object(movement.atlas_common, "ROOT_DIR", Path(temp)):
            root = Path(temp)
            (root / "maps").mkdir()
            meta = root / "meta.json"
            meta.write_text(json.dumps({"maps": {"AzaleaGym": {}}}))
            for disabled, destinations in routes.items():
                for south, north in zip(positions, destinations):
                    for start, finish in [((south, 9), (north, 5)), ((north, 6), (south, 10))]:
                        with self.subTest(disabled=disabled, start=start, finish=finish):
                            line = "object_event  6,  9, SPRITE_SPINARAK_CART"
                            self.assertEqual(source.count(line), 1)
                            fixture = source.replace(line, f"object_event {start[0]}, {start[1]}, SPRITE_SPINARAK_CART")
                            (root / "maps/AzaleaGym.asm").write_text(fixture, encoding="utf-8")
                            ride = []
                            landings = []
                            direction = "Up" if start[1] == 9 else "Down"
                            def observe(*args, **kwargs):
                                label = kwargs["context"]["move"]
                                pos = kwargs["player_cell"]
                                if f".Crawl{direction}" in label:
                                    ride.append(pos)
                                    self.assertIn(pos, kwargs["static_npcs"])
                                if label == f"SpinarakCartFinish{direction}Script.Movement":
                                    landings.append(pos)
                                return []
                            with patch.object(movement, "count_sprite_usage", side_effect=observe):
                                issues = movement.analyze_scripts(
                                    root, meta, meta, label_filters=["SpinarakCart4Script"],
                                    assume_set_events=[f for f, on in zip(flags, disabled) if on],
                                    assume_clear_events=[f for f, on in zip(flags, disabled) if not on],
                                )
                            self.assertTrue(ride)
                            self.assertEqual(landings, [finish])
                            self.assertFalse(any(i.kind == "follower-collision" for i in issues))
