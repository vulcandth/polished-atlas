import { Container, Sprite, Texture } from "pixi.js";
import type { TileAnimationMetadata } from "@/types";

export function validateTileAnimation(data: TileAnimationMetadata, width: number, height: number): void {
  if (!data || typeof data.image !== "string" || !data.image ||
      !Number.isSafeInteger(data.tileCount) || data.tileCount <= 0 ||
      !Number.isSafeInteger(data.sheetColumns) || data.sheetColumns <= 0 ||
      !Number.isFinite(data.frameMs) || data.frameMs <= 0 || !Array.isArray(data.tracks) || !data.tracks.length) {
    throw new Error("Invalid tile animation metadata");
  }
  const occupied = new Set<string>();
  for (const track of data.tracks) {
    if (!Array.isArray(track.frames) || track.frames.length === 0 ||
        !Array.isArray(track.durations) || track.durations.length !== track.frames.length ||
        track.frames.some((frame) => !Number.isSafeInteger(frame) || frame < 0 || frame >= data.tileCount) ||
        track.durations.some((duration) => !Number.isSafeInteger(duration) || duration <= 0) ||
        !Number.isSafeInteger(track.durations.reduce((sum, duration) => sum + duration, 0)) ||
        !Array.isArray(track.positions) || track.positions.length === 0) {
      throw new Error("Invalid tile animation track");
    }
    for (const position of track.positions) {
      if (!Array.isArray(position) || position.length !== 2 ||
          position.some((value) => !Number.isSafeInteger(value) || value < 0 || value % 8 !== 0) ||
          position[0] + 8 > width || position[1] + 8 > height || occupied.has(position.join(","))) {
        throw new Error("Invalid or overlapping animated tile position");
      }
      occupied.add(position.join(","));
    }
  }
}

export function makeTrackClock(frames: number[], durations: number[], frameMs: number) {
  let total = 0;
  const ends = durations.map((duration) => total += duration);
  return (elapsedMs: number) => {
    const tick = Math.floor(Math.max(0, elapsedMs) / frameMs + 1e-7) % total;
    let low = 0, high = ends.length - 1;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (tick < ends[middle]) high = middle;
      else low = middle + 1;
    }
    return frames[low];
  };
}

export function createTileAnimationPlayer(data: TileAnimationMetadata, textures: Texture[]) {
  const clocks = data.tracks.map((track) => makeTrackClock(track.frames, track.durations, data.frameMs));
  const instances = new WeakMap<Container, { layer: Container; tracks: { sprites: Sprite[]; frame: number }[] }>();
  return (parent: Container, elapsedMs: number, enabled = true) => {
    let instance = instances.get(parent);
    if (!enabled) {
      if (instance) instance.layer.visible = false;
      return; // The base image already contains frame zero.
    }
    if (!instance) {
      const layer = new Container();
      layer.eventMode = "none";
      layer.zIndex = 0;
      parent.addChild(layer);
      instance = {
        layer,
        tracks: data.tracks.map((track) => ({
          frame: -1,
          sprites: track.positions.map(([x, y]) => {
            const sprite = new Sprite(textures[track.frames[0]]);
            sprite.position.set(x, y);
            sprite.eventMode = "none";
            layer.addChild(sprite);
            return sprite;
          }),
        })),
      };
      instances.set(parent, instance);
    }
    instance.layer.visible = true;
    instance.tracks.forEach((track, index) => {
      const frame = clocks[index](elapsedMs);
      if (frame === track.frame) return;
      track.frame = frame;
      for (const sprite of track.sprites) sprite.texture = textures[frame];
    });
  };
}
