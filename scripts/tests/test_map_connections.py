from pathlib import Path
import os
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generate_map_connections import AttributesParser, _augment_with_repo
from generate_map_neighborhoods import _build_adjacency, _component_members
import atlas_common


class MapConnectionTests(unittest.TestCase):
    def parse(self, source):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "attributes.asm"
            path.write_text(source, encoding="utf-8")
            return AttributesParser(path).parse()

    def test_legacy_and_derived_flags_produce_same_graph(self):
        legacy = """map_attributes Town, TOWN, $0, NORTH | EAST
connection north, Route, ROUTE, -3
connection east, Island, ISLAND, 7
map_attributes Room, ROOM, $1, 0
"""
        modern = legacy.replace(", NORTH | EAST", "").replace("$1, 0", "$1")
        self.assertEqual(self.parse(legacy), self.parse(modern))

    def test_malformed_or_empty_attributes_fail(self):
        for source in ("; empty", "map_attributes Town, TOWN", "connection east, Town, TOWN, 0",
                       "map_attributes Town, TOWN, $0, NORTH, extra",
                       "map_attributes Town, TOWN, $0\nconnection upside, Route, ROUTE, 0",
                       "map_attributes Town, TOWN, $0\nmap_attributes Town, TOWN, $0"):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.parse(source)

    def test_pinned_upstream_map_and_connection_inventory(self):
        required = os.environ.get("ATLAS_UPSTREAM_ROOT")
        root = Path(required) if required else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not root.exists():
            if required:
                self.fail(f"Required upstream corpus does not exist: {root}")
            self.skipTest("Optional upstream corpus is not checked out")
        expected = os.environ.get("ATLAS_UPSTREAM_COMMIT", "704ea9db192ca8b902ef4aa7a441eb905eb29b89")
        actual = subprocess.check_output([os.environ.get("GIT_BIN", "git"), "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        self.assertEqual(actual, expected)
        path = root / "data/maps/attributes.asm"
        graph = AttributesParser(path).parse()
        repo = atlas_common.repository(root)
        self.assertEqual(set(graph), set(repo.maps))
        self.assertEqual(len(graph), 612)
        declared = re.findall(r"^\s+connection\s+", path.read_text(encoding="utf-8"), re.M)
        self.assertEqual(sum(len(entry.connections) for entry in graph.values()), len(declared))
        _augment_with_repo(graph, repo)
        absent = []
        for entry in graph.values():
            self.assertIsNotNone(entry.map_type, entry.label)
            for connection in entry.connections:
                if connection.label in graph:
                    self.assertEqual(graph[connection.label].constant, connection.constant)
                else:
                    absent.append((entry.label, connection.label, connection.constant))
                self.assertIn(connection.direction.upper(), entry.connection_flags)
        # Upstream intentionally uses a shortened Route36 border here. It is a
        # connection alias, not an omitted map header; layout support is separate.
        self.assertEqual(absent, [("RuinsOfAlphOutside", "FakeRoute36", "FAKE_ROUTE_36")])
        connected = _component_members("NewBarkTown", _build_adjacency(graph))
        self.assertIn("GoldenrodCity", connected)
        self.assertIn("OlivineCity", connected)
        # The attributes macro reuses 3F dimensions, but the header order and
        # warp IDs still identify distinct third and fourth floors.
        self.assertEqual(repo.maps["LavRadioTower3F"].constant, "LAV_RADIO_TOWER_3F")
        self.assertEqual(repo.maps["LavRadioTower4F"].constant, "LAV_RADIO_TOWER_4F")
        from generate_warp_metadata import build_metadata
        maps, _, _ = build_metadata(root, None, set())
        unresolved = [(label, warp["index"], warp["target"]["map_constant"])
                      for label, entry in maps.items() for warp in entry["warps"]
                      if warp["target"]["map_label"] is None]
        self.assertEqual(unresolved, [])
        tower_warp = maps["LavRadioTower3F"]["warps"][1]
        self.assertEqual(tower_warp["target"]["map_label"], "LavRadioTower4F")


if __name__ == "__main__":
    unittest.main()
