import { describe, expect, it } from "vitest";
import { createSpatialPaletteSelector, resolveEntranceVariant, resolveSpatialBgPalettes } from "./paletteSwaps";
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
  it("keeps entrance-specific terrain and NPC palettes paired across time and movement", () => {
    const original = metadata.maps.GoldenrodCity;
    const variants = {
      BELLCHIME_TRAIL: { asset_label: "Grotto--BELLCHIME_TRAIL", palettes: {
        day: Array.from({ length: 8 }, () => palette(248)),
        nite: Array.from({ length: 8 }, () => palette(192)),
      } },
      CHERRYGROVE_BAY: { asset_label: "Grotto--CHERRYGROVE_BAY", palettes: {
        day: Array.from({ length: 8 }, () => palette(176)),
      } },
    };
    const data = { ...metadata, maps: { Grotto: {
      ...original, label: "Grotto", palette_swaps: [], entrance_variants: variants,
    } } };
    expect(resolveEntranceVariant(data, "Grotto", "BELLCHIME_TRAIL")?.asset_label).toBe("Grotto--BELLCHIME_TRAIL");
    expect(resolveSpatialBgPalettes(data, "Grotto", "day", 3, 3, "BELLCHIME_TRAIL")?.[2]).toEqual(palette(248));
    expect(resolveSpatialBgPalettes(data, "Grotto", "nite", 3, 3, "BELLCHIME_TRAIL")?.[2]).toEqual(palette(192));
    expect(resolveSpatialBgPalettes(data, "Grotto", "day", 3, 3, "CHERRYGROVE_BAY")?.[2]).toEqual(palette(176));
    expect(resolveEntranceVariant(data, "Grotto", "ROUTE_32")).toBeUndefined();
    expect(resolveSpatialBgPalettes(data, "Grotto", "day", 3, 3, "ROUTE_32")).toEqual(original.palettes.day);
    const select = createSpatialPaletteSelector(data, "Grotto", "day", "BELLCHIME_TRAIL");
    expect(select(3, 3)?.[2]).toEqual(palette(248));
    expect(select(4, 3)).toBeUndefined();
    expect(data.maps.Grotto.palettes.day).toEqual(original.palettes.day);
  });
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
  it("uses the map palette time for swaps without changing the clock-time base lookup", () => {
    const forced = { ...metadata, maps: { GoldenrodCity: {
      ...metadata.maps.GoldenrodCity, palette_times: { day: "nite" }, overcast: true,
    } } };
    const colors = resolveSpatialBgPalettes(forced, "GoldenrodCity", "day", 22, 7);
    expect(colors?.[3]).toEqual(palette(26));
    expect(colors?.[2]).toEqual(metadata.maps.GoldenrodCity.palettes.day[2]);
  });
});
