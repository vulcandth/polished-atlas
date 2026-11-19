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
            self.assertEqual([c.opcode for c in commands[:4]], ["giveitem", "iffalsefwd", "disappear", "setevent"])
            self.assertEqual(commands[1].args, (script + target,))
            self.assertEqual(commands[0].line_no, commands[1].line_no)
            self.assertEqual(commands[2].args, (obj,))
            failure = parsed.script_labels[script + target].commands
            self.assertEqual(failure[-1].opcode, "endtext")
            self.assertFalse(any(c.opcode in {"disappear", "setevent"} for c in failure))
