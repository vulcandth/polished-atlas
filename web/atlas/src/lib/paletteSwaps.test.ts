import { describe, expect, it } from "vitest";
import { createSpatialPaletteSelector, resolveSpatialBgPalettes } from "./paletteSwaps";
import type { BgPalettesMetadata, RgbTuple } from "@/types";

const palette = (n: number): RgbTuple[] => Array.from({ length: 4 }, () => [n, n, n]);
const metadata: BgPalettesMetadata = {
  version: 2, generatedAt: "test", weekday: 1,
  paletteSwapPalettes: {
    water: Array.from({ length: 8 }, (_, i) => palette(10 + i)),
    museum: Array.from({ length: 8 }, (_, i) => palette(20 + i)),
    bike: Array.from({ length: 8 }, (_, i) => palette(30 + i)),
  },
  maps: {
    GoldenrodCity: {
      label: "GoldenrodCity",
      palettes: Object.fromEntries(["morn", "day", "nite", "eve"].map(time => [time, Array.from({ length: 8 }, (_, n) => palette(n))])),
      palette_swaps: [
        { min_x: 22, max_x: 39, min_y: 7, max_y: 19, slot: 3, outside: "water", inside: "museum" },
        { min_x: 26, max_x: 41, min_y: 21, max_y: 33, slot: 3, outside: null, inside: "bike" },
      ],
    },
  },
};

describe("palette-swap composite", () => {
  it("preserves the previous slot through NULL and excludes maximum boundaries", () => {
    expect(resolveSpatialBgPalettes(metadata, "GoldenrodCity", "day", 22, 7)?.[3]).toEqual(palette(21));
    expect(resolveSpatialBgPalettes(metadata, "GoldenrodCity", "day", 39, 7)?.[3]).toEqual(palette(11));
    expect(resolveSpatialBgPalettes(metadata, "GoldenrodCity", "day", 26, 21)?.[3]).toEqual(palette(31));
    expect(resolveSpatialBgPalettes(metadata, "GoldenrodCity", "day", 26, 33)?.[3]).toEqual(palette(11));
    expect(metadata.maps.GoldenrodCity.palettes.day[3]).toEqual(palette(3));
  });
  it("updates NPC colors only when moving into another effective palette region", () => {
    const select = createSpatialPaletteSelector(metadata, "GoldenrodCity", "day");
    expect(select(21, 7)?.[3]).toEqual(palette(11));
    expect(select(21.9, 7)).toBeUndefined();
    expect(select(22, 7)?.[3]).toEqual(palette(21));
    expect(select(23, 7)).toBeUndefined();
    expect(select(39, 7)?.[3]).toEqual(palette(11));
    expect(select(26, 21)?.[3]).toEqual(palette(31));
  });
  it("selects each time and overcast variant", () => {
    for (const [index, time] of ["morn", "day", "nite", "eve"].entries()) {
      const overcast = { ...metadata, maps: { GoldenrodCity: { ...metadata.maps.GoldenrodCity, overcast: true } } };
      expect(resolveSpatialBgPalettes(metadata, "GoldenrodCity", time, 22, 7)?.[3]).toEqual(palette(20 + index));
      expect(resolveSpatialBgPalettes(overcast, "GoldenrodCity", time, 22, 7)?.[3]).toEqual(palette(24 + index));
    }
  });
  it("fails explicitly for a referenced but missing palette table", () => {
    expect(() => resolveSpatialBgPalettes({ ...metadata, paletteSwapPalettes: {} }, "GoldenrodCity", "day", 22, 7)).toThrow("Invalid palette swap");
  });
});
