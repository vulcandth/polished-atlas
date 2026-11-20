from pathlib import Path
import os
import re
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from generate_map_connections import AttributesParser, MapAttributes, MapConnection, _augment_with_repo, _layout_graph, _collect_reachable, _project_neighbour
from generate_map_neighborhoods import _build_adjacency, _component_members, _build_layout, _compute_map_z_indices, _select_root, TARGET_TYPES
import atlas_common


class MapConnectionTests(unittest.TestCase):
    def test_reverse_constraints_preserve_one_way_geometry(self):
        graph = {
            'Town': MapAttributes('Town', 'TOWN', '$0', ['0'], width=10, height=8),
            'Route': MapAttributes('Route', 'ROUTE', '$0', ['east'],
                [MapConnection('east', 'Town', 'TOWN', -3)], width=4, height=12),
        }
        with tempfile.TemporaryDirectory() as directory:
            layout, proxies = _layout_graph(graph, Path(directory))
        self.assertEqual(proxies, set())
        self.assertEqual(graph['Town'].connections, [])
        self.assertTrue(layout['Town'].connections[0].layout_only)
        placements, _ = _build_layout(layout, 'Town')
        self.assertEqual((placements['Route'].x, placements['Route'].y), (-4, 3))
        with self.assertRaisesRegex(ValueError, 'Unplaced maps'):
            _build_layout(graph, 'Town')

    def test_malformed_dual_connection_fails(self):
        graph = {'Town': MapAttributes('Town', 'TOWN', '$0', ['0'], width=10, height=8)}
        for record in ['dual_connection south, TOWN, 5',
                       'dual_connection south, TOWN, 99, Town, TOWN, 0, Town, TOWN, 0',
                       'dual_connection south, MISSING, 5, Town, TOWN, 0, Town, TOWN, 0']:
            with self.subTest(record=record), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                path = root / 'data/maps/dual_connections.asm'
                path.parent.mkdir(parents=True)
                path.write_text(record, encoding='utf-8')
                with self.assertRaises(ValueError):
                    _layout_graph(graph, root)

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
        expected = os.environ.get("ATLAS_UPSTREAM_COMMIT", "1e600899f81bd9ae7dea36a7c611985c6bab5f6c")
        actual = subprocess.check_output([os.environ.get("GIT_BIN", "git"), "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
        self.assertEqual(actual, expected)
        path = root / "data/maps/attributes.asm"
        graph = AttributesParser(path).parse()
        repo = atlas_common.repository(root)
        self.assertEqual(set(graph), set(repo.maps))
        self.assertEqual(len(graph), 612)
        declared = re.findall(r"^\s+connection\s+", path.read_text(encoding="utf-8"), re.M)
        self.assertEqual(sum(not c.layout_only for entry in graph.values() for c in entry.connections), len(declared))
        _augment_with_repo(graph, repo)
        absent = []
        for entry in graph.values():
            self.assertIsNotNone(entry.map_type, entry.label)
            for connection in entry.connections:
                if connection.label in graph:
                    self.assertEqual(graph[connection.label].constant, connection.constant)
                else:
                    absent.append((entry.label, connection.label, connection.constant))
                if not connection.layout_only:
                    self.assertIn(connection.direction.upper(), entry.connection_flags)
        self.assertEqual(absent, [])
        north, = [c for c in graph['RuinsOfAlphOutside'].connections if c.direction == 'north' and not c.layout_only]
        self.assertEqual((north.label, north.constant, north.offset, north.overlap_blocks),
                         ('Route36', 'ROUTE_36', -9, 1))
        self.assertFalse(any(c.label == 'RuinsOfAlphOutside' for c in graph['Route36'].connections))
        connected = _component_members("NewBarkTown", _build_adjacency(graph))
        self.assertIn("GoldenrodCity", connected)
        self.assertIn("OlivineCity", connected)
        layout_graph, proxies = _layout_graph(graph, root)
        fake_edges = [(label, c) for label, node in graph.items() for c in node.connections if c.declared_fake]
        self.assertEqual(len(fake_edges), 28)
        self.assertEqual(proxies, {'Route14LuckyIslandDual', 'OlivineCityRoute35CoastDual'})
        self.assertIn('CherrygroveTrainTrack', layout_graph)
        route13 = [c for c in layout_graph['Route13'].connections if c.direction == 'south']
        self.assertEqual([(c.label, c.offset, c.split_range) for c in route13],
                         [('Route14', 0, (None, 18)), ('LuckyIsland', 9, (18, None))])
        adjacency = _build_adjacency(layout_graph)
        visited = set()
        for label in sorted(layout_graph):
            if label in visited:
                continue
            members = _component_members(label, adjacency)
            visited.update(members)
            selected = _select_root(members, layout_graph, TARGET_TYPES)
            reachable = _collect_reachable(layout_graph, selected)
            self.assertEqual(set(reachable), members, selected)
            placements, _ = _build_layout(reachable, selected)
            self.assertEqual(set(placements), members)
            for source, edge in fake_edges:
                if source in placements:
                    target = placements[edge.label]
                    self.assertEqual((target.x, target.y), _project_neighbour(
                        placements[source], target.width, target.height, edge), (source, edge.label))
            if 'Route13' in placements:
                route, west, east = [placements[k] for k in ('Route13', 'Route14', 'LuckyIsland')]
                self.assertEqual((west.x, west.y), (route.x, route.y + route.height))
                self.assertEqual((east.x, east.y), (west.x + west.width, west.y))
                self.assertIn('FuchsiaCity', placements)
                self.assertIn('PalletTown', placements)
            if 'Route35CoastSouth' in placements:
                south, city, north = [placements[k] for k in ('Route35CoastSouth', 'OlivineCity', 'Route35CoastNorth')]
                self.assertEqual((city.x, city.y + city.height), (south.x - 7, south.y))
                self.assertEqual((north.x, north.y + north.height), (south.x + 15, south.y))
                bay, track, cherry = [placements[k] for k in ('CherrygroveBay', 'CherrygroveTrainTrack', 'CherrygroveCity')]
                self.assertEqual((track.x, track.y), (bay.x + bay.width, bay.y))
                self.assertEqual((cherry.x, cherry.y), (track.x, bay.y + 15))
                self.assertTrue(any(c.declared_fake and c.label == track.label
                                    for c in graph[cherry.label].connections))
                z = _compute_map_z_indices(list(placements), [(source, c.label) for source, c in fake_edges])
                self.assertGreater(z[cherry.label], z[track.label])
                ruins, route = placements['RuinsOfAlphOutside'], placements['Route36']
                self.assertEqual(ruins.x + ruins.width, placements['VioletCity'].x)
                self.assertEqual((ruins.x, ruins.y), (route.x + 9, route.y + route.height - 1))
                reverse, = [c for c in layout_graph['Route36'].connections if c.label == ruins.label]
                self.assertTrue(reverse.layout_only)
                self.assertEqual(reverse.overlap_blocks, 1)
        # The attributes macro reuses 3F dimensions, but the header order and
        # warp IDs still identify distinct third and fourth floors.
        self.assertEqual(repo.maps["LavRadioTower3F"].constant, "LAV_RADIO_TOWER_3F")
        self.assertEqual(repo.maps["LavRadioTower4F"].constant, "LAV_RADIO_TOWER_4F")
        from generate_warp_metadata import build_metadata
        maps, _, _ = build_metadata(root, None)
        for label in ("NationalPark", "ViridianForest"):
            self.assertIs(repo.maps[label].stitch, False)
            self.assertFalse(maps[label]["is_overworld"])
            gates = [warp["target"] for name, entry in maps.items() if "Gate" in name
                     for warp in entry["warps"] if warp["target"]["map_label"] == label]
            self.assertTrue(gates, label)
            self.assertTrue(all(not target["is_overworld"] for target in gates), label)
        unresolved = [(label, warp["index"], warp["target"]["map_constant"])
                      for label, entry in maps.items() for warp in entry["warps"]
                      if warp["target"]["map_label"] is None]
        self.assertEqual(unresolved, [])
        tower_warp = maps["LavRadioTower3F"]["warps"][1]
        self.assertEqual(tower_warp["target"]["map_label"], "LavRadioTower4F")


if __name__ == "__main__":
    unittest.main()
