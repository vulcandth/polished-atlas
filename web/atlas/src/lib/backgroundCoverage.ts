import type { MapAnimationMetadata } from "@/types";
import { decodeBase64 } from "./base64";
import { makeTrackClock } from "./tileAnimation";

type ReadPixel = (x: number, y: number) => number;

export function createBackgroundCoverage(metadata: MapAnimationMetadata, readBase: ReadPixel, readTiles: ReadPixel) {
  if (!metadata.backgroundCoverage) return undefined;
  const { frameWidth: width, frameHeight: height, tileAnimation } = metadata;
  const base = decodeBase64(metadata.backgroundCoverage.base);
  const frames = decodeBase64(metadata.backgroundCoverage.frames);
  const stride = width / 8;
  if (!Number.isInteger(stride) || base.length !== stride * height ||
      frames.length !== (tileAnimation?.tileCount ?? 0) * 8) {
    throw new Error("Invalid background color-index coverage");
  }
  const clocks = new Map<number, (elapsedMs: number) => number>();
  for (const track of tileAnimation?.tracks ?? []) {
    const clock = makeTrackClock(track.frames, track.durations, tileAnimation!.frameMs);
    for (const [x, y] of track.positions) clocks.set((y >> 3) * stride + (x >> 3), clock);
  }
  let elapsed = 0;
  return {
    setTime(time: number) { elapsed = time; },
    colorAt(x: number, y: number) {
      if (x < 0 || x >= width || y < 0 || y >= height) return null;
      const col = x >> 3;
      const clock = clocks.get((y >> 3) * stride + col);
      const frame = clock?.(elapsed);
      const row = frame === undefined ? base[y * stride + col] : frames[frame * 8 + (y & 7)];
      if (!(row & (0x80 >> (x & 7)))) return null;
      if (frame === undefined) return readBase(x, y);
      const columns = tileAnimation!.sheetColumns;
      return readTiles((frame % columns) * 8 + (x & 7), Math.floor(frame / columns) * 8 + (y & 7));
    },
  };
}
