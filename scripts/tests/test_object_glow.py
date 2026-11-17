import os
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from object_glow import load_object_glow
from generate_object_metadata import read_sprite_graphics, gather_constants, parse_sprite_headers


class ObjectGlowTests(unittest.TestCase):
    def test_pinned_glow_tables(self):
        required = os.environ.get("ATLAS_UPSTREAM_ROOT")
        root = Path(required) if required else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not root.exists() and not required:
            self.skipTest("Optional upstream checkout unavailable")
        rules = load_object_glow(root)
        self.assertEqual(rules["fade_steps"], 15)
        self.assertEqual(rules["fade_step_frames"], 2)
        self.assertEqual(len(rules["collision_types"]), 9)
        self.assertEqual(rules["collision_types"]["3"], "OBJ_GLOW_DAY")
        self.assertEqual(rules["collision_types"]["116"], "OBJ_GLOW_NITE")
        self.assertEqual(rules["collision_types"]["117"], "OBJ_GLOW_LAVA")
        self.assertEqual(rules["adjustments"], {
            "OBJ_GLOW_AQUARIUM": [2, 5, 9], "OBJ_GLOW_LANTERN": [5, 4, 2],
            "OBJ_GLOW_DRAGON_SHRINE": [0, 4, 4], "OBJ_GLOW_LAVA": [8, 1, 0],
        })

    def test_upstream_sprite_sources_are_decoded(self):
        required = os.environ.get("ATLAS_UPSTREAM_ROOT")
        root = Path(required) if required else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not root.exists() and not required:
            self.skipTest("Optional upstream checkout unavailable")
        headers, _ = parse_sprite_headers(root, gather_constants(root))
        real = [header for header in headers if header.tile_path]
        self.assertGreater(len(real), 200)
        for header in real:
            self.assertGreater(len(header.tile_bytes), 0, header.sprite_constant)
            self.assertEqual(len(header.tile_bytes) % 16, 0, header.sprite_constant)
        with self.assertRaisesRegex(FileNotFoundError, "Missing sprite source"):
            read_sprite_graphics(root, "gfx/sprites/missing-atlas-test.2bpp.lzp")


if __name__ == "__main__":
    unittest.main()
