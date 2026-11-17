import { describe, expect, it } from "vitest";
import { applyGlowAdjustment, createGlowTransition, fadeColorStep, fadeGlowPalette, GlowFadeClock, NO_GLOW } from "./objectGlow";
import type { ObjectGlowMetadata, RgbTuple } from "@/types";

const rules: ObjectGlowMetadata = { collision_types: { 3: "OBJ_GLOW_DAY" }, adjustments: {}, fade_steps: 15, fade_step_frames: 2 };

describe("NPC glow", () => {
  it("saturates in 5-bit RGB and preserves color 3 without changing the source", () => {
    const colors: RgbTuple[] = [[255, 247, 239], [0, 0, 0], [82, 82, 82], [8, 16, 25]];
    expect(applyGlowAdjustment(colors, [2, 5, 9])).toEqual([
      [255, 255, 255], [16, 41, 74], [99, 123, 156], [8, 16, 25],
    ]);
    expect(colors[1]).toEqual([0, 0, 0]);
  });

  it("fades all 5-bit channel pairs monotonically to their exact target", () => {
    for (let from = 0; from <= 31; from++) {
      for (let to = 0; to <= 31; to++) {
        let active = from;
        for (let remaining = 15; remaining > 0; remaining--) {
          const next = fadeColorStep(active, to, remaining);
          expect(next).toBeGreaterThanOrEqual(Math.min(active, to));
          expect(next).toBeLessThanOrEqual(Math.max(active, to));
          active = next;
        }
        expect(active).toBe(to);
      }
    }
  });

  it("recovers exact CGB channels from both terrain and object metadata", () => {
    for (let value = 0; value < 32; value++) {
      const terrain: RgbTuple[] = [[value * 8, value * 8, value * 8]];
      const object: RgbTuple[] = [[Math.round(value * 255 / 31), Math.round(value * 255 / 31), Math.round(value * 255 / 31)]];
      expect(applyGlowAdjustment(terrain, [2, 5, 9])).toEqual(applyGlowAdjustment(object, [2, 5, 9]));
    }
  });

  it("matches the engine's deferred one-unit changes instead of linear RGB interpolation", () => {
    expect(fadeColorStep(10, 11, 15)).toBe(10);
    expect(fadeColorStep(10, 11, 2)).toBe(10);
    expect(fadeColorStep(10, 11, 1)).toBe(11);
    expect(fadeColorStep(0, 31, 15)).toBe(2);
    expect(fadeColorStep(31, 0, 15)).toBe(29);
    const from: RgbTuple[] = [[0, 0, 0]];
    const to: RgbTuple[] = [[255, 255, 255]];
    expect(fadeGlowPalette(from, to, 1, 15)).toEqual([[16, 16, 16]]);
    expect(fadeGlowPalette(from, to, 15, 15)).toEqual(to);
  });

  it("starts map entries at their selected glow and shares ongoing fades between NPCs", () => {
    const clock = new GlowFadeClock();
    const first = createGlowTransition(rules, clock);
    const second = createGlowTransition(rules, clock);
    expect(first("OBJ_GLOW_LAVA", 0).previous).toBe("OBJ_GLOW_LAVA");
    second(NO_GLOW, 0);
    expect(first(NO_GLOW, 100)).toEqual({ previous: "OBJ_GLOW_LAVA", current: NO_GLOW, steps: 0 });
    expect(first(NO_GLOW, 200).steps).toBe(2);
    expect(second("OBJ_GLOW_DAY", 200).steps).toBe(2);
    expect(first(NO_GLOW, 610).previous).toBe(NO_GLOW);
    expect(first("OBJ_GLOW_LAVA", 700).steps).toBe(0);
  });
});
