import { describe, expect, it } from "vitest";
import { convertObjectMetadata } from "@/hooks/useObjectMetadata";
import { isPokemonIconSprite, ObjectSpriteCache } from "./objectSprites";
import type { RgbTuple } from "@/types";

function fixture() {
  const tile = Array.from({ length: 8 }, () => [0xf0, 0x0f]).flat();
  const row = (color: number): RgbTuple[] => [
    [248, 248, 248], [color === 0 ? 80 : 0, color === 1 ? 80 : 0, color === 2 ? 80 : 0],
    [color === 0 ? 160 : 0, color === 1 ? 160 : 0, color === 2 ? 160 : 0], [0, 0, 0],
  ];
  const metadata = convertObjectMetadata({
    palettes: {
      RED: { time_variants: { day: row(0), nite: row(1) }, darkness: row(1), overcast: { nite: row(1) } },
      GREEN: { time_variants: { day: row(1), nite: row(0) } },
      BLUE: { time_variants: { day: row(2), nite: row(0) }, darkness: row(1), overcast: { nite: row(1) } },
      MON: { mon_components: ["BLUE", "RED"] },
      EQUAL_MON: { mon_components: ["RED", "RED"] },
      AQUA: { static: row(1) },
    },
    sprites: { TEST: { tile_count: 1, tiles_2bpp_base64: Buffer.from(tile).toString("base64"), default_palette: "RED" } },
    facings: { TEST: { entries: [
      { dx: 0, dy: 0, tile: 0, attributes: 0 },
      { dx: 8, dy: 0, tile: 0, attributes: 8 },
    ] } },
    pokemon_icons: { entries: { TEST: { forms: { NO_FORM: {
      tile_count: 4, tiles_2bpp_base64: Buffer.from([...tile, ...tile, ...tile, ...tile]).toString("base64"),
      frame_count: 1, frame_tile_stride: 4, width: 16, height: 16,
      palette: { normal: "MON", shiny: "EQUAL_MON" },
    } } } } },
    dual_palettes: { MAP_A: ["RED", "GREEN"], MAP_B: ["RED", "BLUE"] },
    glow: { collision_types: {}, adjustments: { OBJ_GLOW_LAVA: [8, 1, 0] }, fade_steps: 15, fade_step_frames: 2 },
  });
  return { metadata, cache: new ObjectSpriteCache(metadata, "day") };
}

function pixel(record: { texture: { baseTexture: { resource: unknown } } }, x: number) {
  const buffer = (record.texture.baseTexture.resource as { data: Uint8Array }).data;
  return Array.from(buffer.slice(x * 4, x * 4 + 4));
}

describe("modern object palettes", () => {
  it("renders NEXT_PALETTE tiles and restores the map pair without stale cache colors", () => {
    const { cache, metadata } = fixture();
    cache.setPaletteContext({ dualPalettes: metadata.dualPalettes!.MAP_A });
    const context = cache.getPaletteContext();
    const first = cache.getFacingTexture("TEST", "TEST", null)!;
    expect(pixel(first, 0)).toEqual([80, 0, 0, 255]);
    expect(pixel(first, 8)).toEqual([0, 80, 0, 255]);
    cache.setPaletteContext({ dualPalettes: metadata.dualPalettes!.MAP_B });
    const second = cache.getFacingTexture("TEST", "TEST", null)!;
    expect(pixel(second, 8)).toEqual([0, 0, 80, 255]);
    expect(second.texture).not.toBe(first.texture);
    cache.setPaletteContext(context);
    expect(cache.getFacingTexture("TEST", "TEST", null)!.texture).toBe(first.texture);
    cache.setTimeOfDay("nite");
    const night = cache.getFacingTexture("TEST", "TEST", null)!;
    expect(pixel(night, 0)).toEqual([0, 80, 0, 255]);
    expect(pixel(night, 8)).toEqual([80, 0, 0, 255]);
    cache.destroy();
  });

  it("combines light color 2 and dark color 2 before applying glow exactly once", () => {
    const { cache } = fixture();
    const icon = () => cache.getPokemonIconFrameTextures("TEST", "NO_FORM", null)!.frames[0];
    expect(pixel(icon(), 0)).toEqual([0, 0, 160, 255]);
    expect(pixel(icon(), 4)).toEqual([160, 0, 0, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_NONE", current: "OBJ_GLOW_LAVA", steps: 0 });
    expect(pixel(icon(), 0)).toEqual([0, 0, 160, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_NONE", current: "OBJ_GLOW_LAVA", steps: 15 });
    expect(pixel(icon(), 0)).toEqual([66, 8, 165, 255]);
    expect(pixel(icon(), 4)).toEqual([230, 8, 0, 255]);
    cache.destroy();
  });

  it("applies darkness and day glow to both packed components", () => {
    const { cache } = fixture();
    cache.setTimeOfDay("nite");
    cache.setPaletteContext({ darkness: true, overcast: true });
    const icon = () => cache.getPokemonIconFrameTextures("TEST", null, null)!.frames[0];
    expect(pixel(icon(), 0)).toEqual([0, 160, 0, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_DAY", current: "OBJ_GLOW_DAY", steps: 15 });
    expect(pixel(icon(), 0)).toEqual([0, 0, 160, 255]);
    expect(pixel(icon(), 4)).toEqual([160, 0, 0, 255]);
    cache.destroy();
  });

  it("keeps equal-nybble palettes and aquarium NPC palette overrides intact", () => {
    const { cache } = fixture();
    const equal = cache.getPokemonIconFrameTextures("TEST", null, "EQUAL_MON")!.frames[0];
    expect(pixel(equal, 0)).toEqual([80, 0, 0, 255]);
    const aqua = cache.getPokemonIconFrameTextures("TEST", null, "AQUA")!.frames[0];
    expect(pixel(aqua, 0)).toEqual([0, 80, 0, 255]);
    expect(pixel(aqua, 4)).toEqual([0, 160, 0, 255]);
    expect(isPokemonIconSprite("SPRITE_AQUARIUM_MON")).toBe(true);
    expect(isPokemonIconSprite("SPRITE_MON_ICON")).toBe(true);
    expect(isPokemonIconSprite("SPRITE_BIG_HO_OH")).toBe(false);
    cache.destroy();
  });
});
