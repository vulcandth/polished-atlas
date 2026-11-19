from pathlib import Path
import sys
import tempfile
import unittest

try:
    from PIL import Image
except ImportError:
    Image = None

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from animation_gif import write_track_gif
from tile_animation import FRAME_MS


@unittest.skipUnless(Image, "GIF output requires Pillow")
class AnimationGifTests(unittest.TestCase):
    def test_independent_tracks_loop_with_cumulative_gif_delays(self):
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            red = (255, 0, 0)
            blue = (0, 0, 255)
            Image.new("RGB", (16, 8), red).save(folder / "base.png")
            sheet = Image.new("RGB", (16, 8), red)
            sheet.paste(blue, (8, 0, 16, 8))
            sheet.save(folder / "tiles.png")
            metadata = {"image": "base.png", "tileAnimation": {
                "image": "tiles.png", "tileCount": 2, "sheetColumns": 2,
                "frameMs": FRAME_MS,
                "tracks": [
                    {"positions": [[0, 0]], "frames": [0, 1], "durations": [1, 1]},
                    {"positions": [[8, 0]], "frames": [0, 1], "durations": [2, 1]},
                ],
            }}
            path = folder / "test.gif"
            write_track_gif(metadata, folder, path)
            with Image.open(path) as gif:
                self.assertEqual(gif.info["loop"], 0)
                self.assertEqual(gif.n_frames, 6)
                total = 0
                for tick in range(6):
                    gif.seek(tick)
                    rgb = gif.convert("RGB")
                    self.assertEqual(rgb.getpixel((0, 0)), blue if tick % 2 else red)
                    self.assertEqual(rgb.getpixel((8, 0)), blue if tick % 3 == 2 else red)
                    total += gif.info["duration"]
                    self.assertEqual(total, 10 * round((tick + 1) * FRAME_MS / 10))
