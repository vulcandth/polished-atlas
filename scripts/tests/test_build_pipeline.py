from pathlib import Path
import json
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import assemble_pages
import build_atlas


class BuildSourceTests(unittest.TestCase):
    def test_rejects_unpinned_branch(self):
        with tempfile.TemporaryDirectory() as folder:
            config = Path(folder) / "source.json"
            config.write_text(json.dumps(dict(channel="dev", commit="master", repository="url", ref="master")))
            with self.assertRaisesRegex(ValueError, "full lowercase commit SHA"):
                build_atlas.load_source(config)

    def test_existing_wrong_head_is_never_reset(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            (source / ".git").mkdir()
            with patch.object(build_atlas, "git", return_value="a" * 40), patch.object(build_atlas, "run") as run:
                with self.assertRaisesRegex(ValueError, "mismatch"):
                    build_atlas.ensure_source(dict(commit="b" * 40), source)
                run.assert_not_called()

    def test_modified_source_is_never_used(self):
        with tempfile.TemporaryDirectory() as folder:
            source = Path(folder)
            (source / ".git").mkdir()
            with patch.object(build_atlas, "git", side_effect=["a" * 40, " M maps/Test.asm"]):
                with self.assertRaisesRegex(ValueError, "local changes"):
                    build_atlas.ensure_source(dict(commit="a" * 40), source)

    def test_rejects_destructive_cleanup_outside_owned_output(self):
        with self.assertRaisesRegex(ValueError, "non-build directory"):
            build_atlas.reset_generated(build_atlas.ROOT / "maps")

    def test_time_aliases_and_day_first(self):
        self.assertEqual(build_atlas.time_slugs("night, morning, day,night,evening"), ["day", "nite", "morn", "eve"])
        with self.assertRaises(ValueError):
            build_atlas.time_slugs("day,noon")


def fixture(root, channel):
    root.mkdir()
    (root / "index.html").write_text(channel)
    info = dict(channel=channel, upstream=dict(channel=channel), atlas_dirty=False,
                settings=dict(times=["day", "morn", "nite", "eve"]))
    (root / "build-info.json").write_text(json.dumps(info))
    maps = root / "maps"
    maps.mkdir()
    for name in ("warp_metadata", "object_metadata", "weather_metadata", "weather_state", "bg_palette_metadata"):
        (maps / f"{name}.json").write_text("{}")
    (maps / "warp_metadata.json").write_text(json.dumps({"maps": {"Test": {
        "width_blocks": 1, "height_blocks": 1,
        "collision": {"width_cells": 2, "height_cells": 2, "cells": "AAAAAA=="}}}}))
    common = maps / "common/animated"
    common.mkdir(parents=True)
    (common / "Test.animation.json").write_text(json.dumps(dict(image="Test.png", frameCount=1, frameWidth=32, frameHeight=32)))
    (common / "Test.png").write_bytes(b"test-sheet")
    for slug in info["settings"]["times"]:
        directory = maps / slug / "animated"
        directory.mkdir(parents=True)
        (directory / "map_neighborhoods.json").write_text(json.dumps({"neighborhoods": [{"graph": "test_connections.json"}]}))
        (directory / "test_connections.json").write_text(json.dumps({"map_count": 1,
            "maps": {"Test": {"asset": "maps/common/animated/Test.animation.json"}}}))
    return root


class PublicationTests(unittest.TestCase):
    def test_both_channels_and_provenance_are_assembled(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stable = fixture(root / "stable", "stable")
            dev = fixture(root / "dev", "dev")
            output = root / "site"
            assemble_pages.assemble(stable, dev, output)
            self.assertEqual((output / "index.html").read_text(), "stable")
            self.assertEqual((output / "dev/index.html").read_text(), "dev")
            self.assertEqual(json.loads((output / "deployment.json").read_text())["dev"]["channel"], "dev")
            with self.assertRaisesRegex(ValueError, "must not exist"):
                assemble_pages.assemble(stable, dev, output)

    def test_failed_dev_never_produces_partial_site(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stable = fixture(root / "stable", "stable")
            dev = fixture(root / "dev", "dev")
            (dev / "maps/weather_state.json").unlink()
            with self.assertRaisesRegex(ValueError, "Missing dev"):
                assemble_pages.assemble(stable, dev, root / "site")
            self.assertFalse((root / "site").exists())

    def test_swapped_channel_cannot_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            root = fixture(Path(folder) / "bundle", "stable")
            with self.assertRaisesRegex(ValueError, "Expected dev"):
                assemble_pages.validate_bundle(root, "dev")

    def test_missing_sheet_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root = fixture(Path(folder) / "bundle", "stable")
            (root / "maps/test.animation.json").write_text(json.dumps(dict(image="missing.png")))
            with self.assertRaisesRegex(ValueError, "animation sheet"):
                assemble_pages.validate_bundle(root, "stable")

    def test_size_limit_is_checked_before_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            stable = fixture(root / "stable", "stable")
            dev = fixture(root / "dev", "dev")
            with patch.object(assemble_pages, "MAX_SITE_BYTES", 1):
                with self.assertRaisesRegex(ValueError, "size budget"):
                    assemble_pages.assemble(stable, dev, root / "site")
            self.assertFalse((root / "site").exists())

    def test_omitted_map_cannot_publish(self):
        with tempfile.TemporaryDirectory() as folder:
            root = fixture(Path(folder) / "bundle", "stable")
            path = root / "maps/warp_metadata.json"
            data = json.loads(path.read_text())
            data["maps"]["Missing"] = data["maps"]["Test"]
            path.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "Missing day render for Missing"):
                assemble_pages.validate_bundle(root, "stable")


if __name__ == "__main__":
    unittest.main()
