import { describe, expect, it } from "vitest";
import { BaseTexture, Container, Sprite, Texture } from "pixi.js";
import type { TileAnimationMetadata } from "@/types";
import { createTileAnimationPlayer, makeTrackClock, validateTileAnimation } from "./tileAnimation";

const frameMs = 1000 * 70224 / 4194304;
const metadata = (): TileAnimationMetadata => ({
  image: "map.tiles.png", tileCount: 2, sheetColumns: 2, frameMs,
  tracks: [{ positions: [[0, 0], [8, 8]], frames: [0, 1, 0], durations: [2, 1, 1] }],
});

describe("compact map animation", () => {
  it("keeps terrain priority above NPCs and below weather, freezing frame zero when disabled", () => {
    const textures = [0, 1].map((value) => new Texture(BaseTexture.fromBuffer(new Uint8Array(256).fill(value), 8, 8)));
    const parent = new Container();
    parent.sortableChildren = true;
    const objects = new Container(), weather = new Container();
    objects.zIndex = 5;
    weather.zIndex = 6;
    parent.addChild(weather, objects);
    const update = createTileAnimationPlayer(metadata(), textures, { zIndex: 5.5, retainStatic: true });
    update(parent, frameMs * 2, false);
    parent.sortChildren();
    const layer = parent.children[1] as Container;
    expect(parent.children).toEqual([objects, layer, weather]);
    expect(layer.visible).toBe(true);
    expect((layer.children[0] as Sprite).texture).toBe(textures[0]);
    update(parent, frameMs * 2, true);
    expect((layer.children[0] as Sprite).texture).toBe(textures[1]);
    update(parent, frameMs * 2, false);
    expect(layer.visible).toBe(true);
    expect((layer.children[0] as Sprite).texture).toBe(textures[0]);
    expect(parent.children).toHaveLength(3);
    parent.destroy({ children: true });
    textures.forEach((texture) => texture.destroy(true));
  });

  it("keeps exact VBlank boundaries and independently repeating tracks", () => {
    const clock = makeTrackClock([0, 1, 0], [2, 1, 1], frameMs);
    for (let tick = 0; tick < 1600; tick++) {
      expect(clock(tick * frameMs)).toBe(tick % 4 === 2 ? 1 : 0);
    }
    expect(clock(2 * frameMs - 0.01)).toBe(0);
    expect(clock(-100)).toBe(0);
  });

  it("rejects missing frames, overlap and invalid atlas coordinates", () => {
    validateTileAnimation(metadata(), 16, 16);
    for (const mutate of [
      (m: TileAnimationMetadata) => m.tracks[0].frames.push(2),
      (m: TileAnimationMetadata) => m.tracks[0].positions.push([8, 8]),
      (m: TileAnimationMetadata) => m.tracks[0].positions.push([16, 0]),
      (m: TileAnimationMetadata) => m.tracks[0].durations[0] = 0,
      (m: TileAnimationMetadata) => m.tileCount = 0,
    ]) {
      const data = metadata();
      mutate(data);
      expect(() => validateTileAnimation(data, 16, 16)).toThrow();
    }
  });

  it("updates overlay textures, leaves other children intact and resets to the static base", () => {
    const textures = [0, 1].map((value) => new Texture(BaseTexture.fromBuffer(new Uint8Array(8 * 8 * 4).fill(value), 8, 8)));
    const parent = new Container();
    const objects = new Container();
    objects.zIndex = 5;
    parent.addChild(objects);
    const update = createTileAnimationPlayer(metadata(), textures);
    update(parent, 0, false);
    expect(parent.children).toHaveLength(1);
    update(parent, frameMs * 2, true);
    const layer = parent.children[1] as Container;
    expect(layer.children).toHaveLength(2);
    expect(layer.eventMode).toBe("none");
    expect((layer.children[0] as Sprite).texture).toBe(textures[1]);
    expect(layer.children[1].position.x).toBe(8);
    update(parent, frameMs * 3, true);
    expect((layer.children[0] as Sprite).texture).toBe(textures[0]);
    update(parent, frameMs * 2, false);
    expect(layer.visible).toBe(false);
    expect(objects.visible).toBe(true);
    update(parent, frameMs * 2, true);
    expect(layer.visible).toBe(true);
    expect(parent.children).toHaveLength(2);
    parent.destroy({ children: true });
    textures.forEach((texture) => texture.destroy(true));
  });
});
