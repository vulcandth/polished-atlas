import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tile_animation import Command, Context, Machine, COPY_SPECS, parse_tables, repository_sources, capture_cycle, judge_palette


PALETTE = [[(p, c, 0) for c in range(4)] for p in range(8)]


def machine(*commands, banks=None, sources=None, judge=()):
    return Machine(tuple(commands) + (Command("DoneTileAnimation"),),
                   banks or (bytes(4096), bytes(4096)), sources or {}, PALETTE, judge)


class TileAnimationTests(unittest.TestCase):
    def test_strict_table_aliases_and_banked_address(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "anims.asm"
            path.write_text("TilesetOneAnim::\nTilesetTwoAnim::\n tileframe AnimateWaterBubbleTiles, $1:81\n tileframe DoneTileAnimation\n")
            tables = parse_tables(path)
            self.assertEqual(tables["TilesetOne"], tables["TilesetTwo"])
            self.assertEqual(tables["TilesetOne"][0], Command("AnimateWaterBubbleTiles", 1, 0x81))
            for bad in ("tileframe Unknown, $0:10", "tileframe AnimateWaterTile", "tileframe AnimateWaterTile, $2:10", "dw 0, DoneTileAnimation"):
                path.write_text(f"TilesetOneAnim::\n {bad}\n tileframe DoneTileAnimation\n")
                with self.assertRaises(ValueError):
                    parse_tables(path)

    def test_legacy_exporter_cannot_silently_skip_banked_tables(self):
        from render_map import _load_tileset_animations
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "data").mkdir()
            (root / "data/tileset_anims.asm").write_text("TilesetOneAnim::\n tileframe DoneTileAnimation\n")
            with self.assertRaisesRegex(ValueError, "modern delta exporter"):
                _load_tileset_animations(root, SimpleNamespace(), None)

    def test_one_command_per_step_and_independent_timer(self):
        m = machine(Command("AnimateWaterTile", 0, 20), Command("StandingTileFrame8"),
                    sources={"water_johto": b"".join(bytes([i]) * 16 for i in (1, 2, 3, 4))})
        changed, _ = m.step(Context(0, 0))
        self.assertEqual(changed, {(0, 20): bytes([1]) * 16})
        self.assertEqual((m.pc, m.timer), (1, 0))
        m.step(Context(1, 0))
        self.assertEqual((m.pc, m.timer), (2, 1))
        m.step(Context(2, 0))
        self.assertEqual((m.pc, m.timer), (0, 1))
        m.timer = 7
        m.pc = 1
        m.step(Context(3, 0))
        self.assertEqual(m.timer, 0)

    def test_multi_tile_copy_uses_selected_bank_and_high_ids(self):
        bank0 = bytes([200]) * 4096
        bank1 = b"".join(bytes([i]) * 16 for i in range(256))
        m = machine(Command("AnimateWaterBubbleTiles", 1, 0x81), banks=(bank0, bank1))
        m.timer = 3
        tiles, _ = m.step(Context(0, 0))
        self.assertEqual(tiles, {(1, 0x81): bytes([0x91]) * 16, (1, 0x82): bytes([0x92]) * 16})
        self.assertEqual(bytes(m.banks[0]), bank0)

    def test_tower_pointer_sequence_and_actual_star_phase(self):
        source = b"".join(bytes([i]) * 16 for i in range(256))
        m = machine(Command("AnimateTowerPillarTiles2", 1, 0x24), banks=(source, source))
        m.timer = 20  # pointer index 5 -> frame 3, not frame 5
        m.step(Context(0, 0))
        self.assertEqual(m.banks[1][0x24 * 16:0x27 * 16], bytes([0x4a]) * 16 + bytes([0x4b]) * 16 + bytes([0x4c]) * 16)
        m = machine(Command("AnimateBigStarTile1", 1, 0x40), banks=(source, source))
        m.step(Context(0, 0))
        self.assertEqual(m.banks[1][0x400:0x410], bytes([0x47]) * 16)

    def test_divider_is_byte_offset_and_vblank_drives_turbine(self):
        source = bytes(range(256)) * 16
        m = machine(Command("AnimateJudgeMachineTiles", 1, 0x57), banks=(source, source))
        m.step(Context(0, 6))
        self.assertEqual(m.banks[1][0x570:0x590], source[0x5c6:0x5e6])
        for vblank, expected in ((0, 1), (1, 2)):
            m = machine(Command("AnimateTurbineTiles", 0, 0x6c), sources={"turbine": bytes([1]) * 64 + bytes([2]) * 64})
            m.timer = 7
            m.step(Context(vblank, 0))
            self.assertEqual(m.banks[0][0x6c0:0x700], bytes([expected]) * 64)

    def test_scroll_directions_and_eight_step_period(self):
        tile = bytes(range(16))
        original = tile * 256
        m = machine(Command("ScrollFourTilesUpDownLeftRight", 1, 0x49), banks=(original, original))
        m.step(Context(0, 0))
        self.assertEqual(m.banks[1][0x490:0x4a0], tile[2:] + tile[:2])
        self.assertEqual(m.banks[1][0x4a0:0x4b0], tile[-2:] + tile[:-2])
        self.assertEqual(m.banks[1][0x4b0:0x4c0], bytes(((v << 1) | (v >> 7)) & 255 for v in tile))
        self.assertEqual(m.banks[1][0x4c0:0x4d0], bytes((v >> 1) | ((v & 1) << 7) for v in tile))
        for _ in range(7):
            m.pc = 0
            m.step(Context(0, 0))
        self.assertEqual(bytes(m.banks[1]), original)

    def test_state_gates_and_palette_writes(self):
        source = b"".join(bytes([i]) * 16 for i in range(256))
        for time in (0, 1, 2, 3):
            m = machine(Command("AnimateLampLightTiles", 0, 0x65), banks=(source, source))
            tiles, _ = m.step(Context(2, 0, time=time))
            self.assertEqual(bool(tiles), time in (2, 3))
        m = machine(Command("AnimateForestTreeTiles", 1, 0x1c), banks=(source, source))
        self.assertEqual(m.step(Context(0, 0)), ({}, {}))
        m.pc = 0
        self.assertEqual(len(m.step(Context(0, 0, forest_restless=True))[0]), 4)
        m = machine(Command("FlickeringCaveEntrancePalette"))
        self.assertEqual(m.step(Context(2, 0))[1], {})
        m.pc = 0
        self.assertEqual(m.step(Context(2, 0, darkness=True))[1], {(4, 0): PALETTE[4][1]})
        colors = tuple(((i, 1, 2), (i, 3, 4)) for i in range(16))
        m = machine(Command("CycleJudgeMachinePalette"), judge=colors)
        m.timer = 18
        self.assertEqual(m.step(Context(0, 0, judge_active=True))[1], {(6, 1): (2, 1, 2), (6, 2): (2, 3, 4)})

    def test_pinned_corpus_tables_and_all_rom_animation_frames(self):
        required = os.environ.get("ATLAS_UPSTREAM_ROOT")
        root = Path(required) if required else Path(__file__).resolve().parents[2] / "external/polishedcrystal-master"
        if not root.exists() and not required:
            self.skipTest("Optional upstream checkout unavailable")
        tables = parse_tables(root / "data/tileset_anims.asm")
        self.assertGreaterEqual(len(tables), 53)
        sources = repository_sources(root)
        self.assertEqual(judge_palette(root)[0], ((23, 28, 21), (10, 17, 16)))
        bank = bytes(range(256)) * 16
        for table in tables.values():
            m = Machine(table, (bank, bank), sources, PALETTE, tuple(((1, 2, 3), (4, 5, 6)) for _ in range(16)))
            for frame in range(len(table) * 32):
                m.step(Context(frame, frame * 7, time=2, spinning=True, forest_restless=True, judge_active=True, darkness=True))
        # Bounds check every named ROM frame, including those not reached in a short cycle.
        for name, spec in COPY_SPECS.items():
            if isinstance(spec.source, str):
                frames = max(spec.sequence) + 1 if spec.sequence else spec.period
                self.assertEqual(len(sources[spec.source]), frames * spec.count * 16, name)

    def test_cycle_keeps_blank_frames_and_reconstructs_start_after_warmup(self):
        m = machine(Command("AnimateWaterTile", 0, 20), Command("DoNothing"), Command("StandingTileFrame8"),
                    sources={"water_johto": b"".join(bytes([i]) * 16 for i in (1, 2, 3, 4))})
        cycle = capture_cycle(m, Context(0, 0))
        self.assertEqual(len(cycle.changes), 32)
        self.assertGreater(cycle.warmup_frames, 0)
        self.assertGreater(sum(not tiles and not colors for tiles, colors in cycle.changes), 20)
        banks = [bytearray(bank) for bank in cycle.banks]
        for tiles, _ in cycle.changes:
            for (bank, tile), value in tiles.items():
                banks[bank][tile * 16:(tile + 1) * 16] = value
        self.assertEqual(tuple(bytes(bank) for bank in banks), cycle.banks)


if __name__ == "__main__":
    unittest.main()
