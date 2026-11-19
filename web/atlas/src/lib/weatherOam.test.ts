import { describe, expect, it } from "vitest";
import { weatherOamClips, type OamGroup } from "./weatherOam";

const tile = (x: number, y: number): OamGroup => ({ tiles: [{ x, y }] });

describe("weather OAM allocation", () => {
  it("rejects a whole candidate on overflow without reserving its other scanlines", () => {
    const sprites = Array.from({ length: 10 }, (_, i) => tile(i * 8, 8));
    sprites.push(tile(80, 1), tile(88, 0));
    expect([...weatherOamClips(sprites, 160, 144)]).toEqual([[10, []]]);
  });

  it("admits the visible part across the adjacent screen and counts clipped edge tiles", () => {
    const sprites = Array.from({ length: 10 }, (_, i) => tile(i * 8, -4));
    sprites.push(tile(156, 0));
    expect(weatherOamClips(sprites, 320, 144).get(10)).toEqual([{ x: 160, y: 0, width: 4, height: 8 }]);
  });

  it("allocates actor facings before weather and reuses space left by an oversized facing", () => {
    const tiles = Array.from({ length: 39 }, (_, i) => ({ x: i % 5 * 8, y: Math.floor(i / 5) * 8 }));
    const groups = [{ tiles }, { tiles: [{ x: 0, y: 80 }, { x: 8, y: 80 }] },
      { ...tile(0, 90), weatherSlot: 1 }, { ...tile(0, 90), weatherSlot: 0 }];
    expect([...weatherOamClips(groups, 160, 144)]).toEqual([[1, []], [2, []]]);
  });
});
