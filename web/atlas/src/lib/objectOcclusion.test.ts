import { BaseTexture, Sprite, Texture } from "pixi.js";
import { expect, it } from "vitest";
import type { MapAnimationMetadata } from "@/types";
import { createBackgroundCoverage } from "./backgroundCoverage";
import { createObjectOcclusion, facingPriority } from "./objectOcclusion";

it("combines fixed and grass-only OAM priority with animated background color indices", () => {
  const bytes = (values: number[]) => Buffer.from(values).toString("base64");
  const map: MapAnimationMetadata = {
    version: 2, image: "base.png", frameWidth: 16, frameHeight: 8,
    frameCount: 1, frameDurationsMs: [10], loopDurationMs: 10,
    backgroundCoverage: { base: bytes(Array(8).fill([0xc0, 0xe0]).flat()),
      frames: bytes([...Array(8).fill(0x60), ...Array(8).fill(0xe0)]) },
    tileAnimation: { image: "atlas.png", tileCount: 2, sheetColumns: 2, frameMs: 10,
      tracks: [{ positions: [[8, 0]], frames: [1, 0], durations: [1, 1] }] },
  };
  const background = createBackgroundCoverage(map, () => 0x102030,
    (x) => x >= 8 ? 0x405060 : 0x708090)!;
  const rgba = new Uint8Array(16).fill(255);
  const frame = new Texture(BaseTexture.fromBuffer(rgba, 4, 1));
  const sprite = new Sprite(frame);
  const draw = createObjectOcclusion(sprite, background.colorAt);
  const flags = facingPriority(rgba, Uint8Array.of(0x80, 2, 0, 2));
  const red = (texture: Texture) => {
    const data = (texture.baseTexture.resource as unknown as { data: Uint8Array }).data;
    expect(data.filter((_, i) => i % 4 === 3)).toEqual(Uint8Array.of(255, 255, 255, 255));
    return Array.from(data.filter((_, i) => i % 4 === 0));
  };
  expect(red(draw(frame, flags, 0, 0, false))).toEqual([0x10, 255, 255, 255]);
  expect(red(draw(frame, flags, 0, 0, true))).toEqual([0x10, 0x10, 255, 255]);
  expect(red(draw(frame, flags, 8, 0, true))).toEqual([0x40, 0x40, 255, 255]);
  background.setTime(10);
  expect(red(draw(frame, flags, 8, 0, true))).toEqual([255, 0x70, 255, 255]);
  expect(draw(frame, flags, 8, 0, false)).toBe(frame);
  expect(draw(frame, flags, 16, 0, true)).toBe(frame);
  expect(red(frame)).toEqual([255, 255, 255, 255]);
  sprite.destroy();
  frame.destroy(true);
});
