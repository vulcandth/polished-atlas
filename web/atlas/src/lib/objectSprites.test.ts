import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ObjectSpriteCache } from "./objectSprites";
import type { ObjectMetadata, ObjectSpriteDefinition, ObjectFacingEntry, RgbTuple } from "@/types";

type RawMetadata = {
  version?: number;
  generated_at?: string;
  block_pixel_size?: number;
  cells_per_block?: number;
  event_cell_pixel_size?: number;
  default_facing_for_direction?: Partial<Record<"DOWN" | "LEFT" | "RIGHT" | "UP", string>>;
  sprites?: Record<string, any>;
  facings?: Record<string, any>;
};

const SPRITES_UNDER_TEST = [
  "SPRITE_SAILBOAT",
  "SPRITE_BIG_GYARADOS",
  "SPRITE_BIG_SNORLAX",
] as const;

const FACINGS_UNDER_TEST = [
  "FACING_SAILBOAT_TOP",
  "FACING_SAILBOAT_BOTTOM",
  "FACING_BIG_GYARADOS_1",
  "FACING_BIG_GYARADOS_2",
  "FACING_BIG_DOLL_ASYM",
  "FACING_BIG_DOLL_SYM",
] as const;

type SpriteKey = (typeof SPRITES_UNDER_TEST)[number];
type FacingKey = (typeof FACINGS_UNDER_TEST)[number];

const TARGET_FACINGS: Record<SpriteKey, FacingKey[]> = {
  SPRITE_SAILBOAT: ["FACING_SAILBOAT_TOP", "FACING_SAILBOAT_BOTTOM"],
  SPRITE_BIG_GYARADOS: ["FACING_BIG_GYARADOS_1", "FACING_BIG_GYARADOS_2"],
  SPRITE_BIG_SNORLAX: ["FACING_BIG_DOLL_ASYM", "FACING_BIG_DOLL_SYM"],
};

type LoadedMetadata = {
  metadata: ObjectMetadata;
  tileCounts: Record<SpriteKey, number>;
};

function loadMetadataSubset(): LoadedMetadata {
  const metadataPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../maps/object_metadata.json",
  );
  const raw = JSON.parse(readFileSync(metadataPath, "utf8")) as RawMetadata;

  const metadata: ObjectMetadata = {
    version: Number.isFinite(raw.version) ? Math.trunc(raw.version as number) : 1,
    generatedAt: typeof raw.generated_at === "string" ? raw.generated_at : "",
    blockPixelSize: Number.isFinite(raw.block_pixel_size)
      ? Math.trunc(raw.block_pixel_size as number)
      : 32,
    cellsPerBlock: Number.isFinite(raw.cells_per_block)
      ? Math.trunc(raw.cells_per_block as number)
      : 2,
    eventCellPixelSize: Number.isFinite(raw.event_cell_pixel_size)
      ? Math.trunc(raw.event_cell_pixel_size as number)
      : 16,
    paletteNames: [],
    timeOfDaySlots: [],
    defaultFacingForDirection: {
      DOWN: raw.default_facing_for_direction?.DOWN ?? "",
      LEFT: raw.default_facing_for_direction?.LEFT ?? "",
      RIGHT: raw.default_facing_for_direction?.RIGHT ?? "",
      UP: raw.default_facing_for_direction?.UP ?? "",
    },
    palettes: {},
    sprites: {} as Record<string, ObjectSpriteDefinition>,
    movements: {},
    facings: {} as Record<string, ObjectFacingEntry>,
    maps: {},
    pokemonIcons: null,
  };

  const tileCounts: Record<SpriteKey, number> = {
    SPRITE_SAILBOAT: 0,
    SPRITE_BIG_GYARADOS: 0,
    SPRITE_BIG_SNORLAX: 0,
  };

  for (const spriteName of SPRITES_UNDER_TEST) {
    const entry = raw.sprites?.[spriteName];
    if (!entry) {
      throw new Error(`Missing sprite metadata for ${spriteName}`);
    }
    const declaredCount = Number.isFinite(entry.tile_count) ? Math.trunc(entry.tile_count) : 0;
    const base64 = typeof entry.tiles_2bpp_base64 === "string" ? entry.tiles_2bpp_base64 : "";
    const actualCount = base64 ? Math.floor(Buffer.from(base64, "base64").length / 16) : 0;
    const tileCount = declaredCount > 0 ? declaredCount : actualCount;
    tileCounts[spriteName] = tileCount;
    metadata.sprites[spriteName] = {
      id: Number.isFinite(entry.id) ? Math.trunc(entry.id) : 0,
      gfxPointer: typeof entry.gfx_pointer === "string" ? entry.gfx_pointer : "",
      spriteType: typeof entry.sprite_type === "string" ? entry.sprite_type : "UNKNOWN",
      defaultPalette: typeof entry.default_palette === "string" ? entry.default_palette : null,
      tilePath: typeof entry.tile_path === "string" ? entry.tile_path : "",
      tileCount,
      tiles2bppBase64: base64,
    } satisfies ObjectSpriteDefinition;
  }

  for (const facingName of FACINGS_UNDER_TEST) {
    const entry = raw.facings?.[facingName];
    if (!entry) {
      throw new Error(`Missing facing metadata for ${facingName}`);
    }
    const tiles = Array.isArray(entry.entries)
      ? entry.entries.map((tile: any) => ({
          dx: Number.isFinite(tile?.dx) ? Math.trunc(tile.dx) : 0,
          dy: Number.isFinite(tile?.dy) ? Math.trunc(tile.dy) : 0,
          tile: Number.isFinite(tile?.tile) ? Math.trunc(tile.tile) : 0,
          attributes: Number.isFinite(tile?.attributes) ? Math.trunc(tile.attributes) : 0,
        }))
      : [];
    metadata.facings[facingName] = {
      label: typeof entry.label === "string" ? entry.label : facingName,
      tiles,
    } satisfies ObjectFacingEntry;
  }

  return { metadata, tileCounts };
}

describe("ObjectSpriteCache normalization for large sprites", () => {
  const { metadata, tileCounts } = loadMetadataSubset();
  const cache = new ObjectSpriteCache(metadata, "day");
  const normalizer = cache as unknown as {
    normalizeTileIndex(
      spriteName: string,
      spriteDef: ObjectSpriteDefinition,
      tileCount: number,
      rawIndex: number,
      attributes: number,
    ): number | null;
  };

  function indicesFor(sprite: SpriteKey, facing: FacingKey): number[] {
    const spriteDef = metadata.sprites[sprite];
    const facingDef = metadata.facings[facing];
    return facingDef.tiles.map((tile, index) => {
      const result = normalizer.normalizeTileIndex(
        sprite,
        spriteDef,
        tileCounts[sprite],
        tile.tile,
        tile.attributes,
      );
      if (result === null) {
        throw new Error(`Failed to normalize tile ${index} for ${sprite}/${facing}`);
      }
      return result;
    });
  }

  it("remaps the sailboat bow and stern tiles", () => {
    expect(indicesFor("SPRITE_SAILBOAT", "FACING_SAILBOAT_TOP")).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(indicesFor("SPRITE_SAILBOAT", "FACING_SAILBOAT_BOTTOM")).toEqual([
      8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it("stitches both banks for big Gyarados", () => {
    expect(indicesFor("SPRITE_BIG_GYARADOS", "FACING_BIG_GYARADOS_1")).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
    expect(indicesFor("SPRITE_BIG_GYARADOS", "FACING_BIG_GYARADOS_2")).toEqual([
      0, 1, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29,
    ]);
  });

  it("reads the second Exeggutor head tile from the source transfer boundary", () => {
    const sprite = { ...metadata.sprites.SPRITE_BIG_GYARADOS, tileCount: 24 };
    expect(normalizer.normalizeTileIndex("SPRITE_ALOLAN_EXEGGUTOR", sprite, 24, 0x80, 0)).toBe(15);
  });

  it("keeps the entire Snorlax sheet accessible", () => {
    expect(indicesFor("SPRITE_BIG_SNORLAX", "FACING_BIG_DOLL_SYM")).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(indicesFor("SPRITE_BIG_SNORLAX", "FACING_BIG_DOLL_ASYM")).toEqual([
      0, 1, 4, 5, 7, 10, 3, 2, 2, 6, 9, 8, 4, 11,
    ]);
  });

  it("maps Big Snorlax banked tiles back onto the base sheet", () => {
    const sprite = metadata.sprites["SPRITE_BIG_SNORLAX"];
    const tileCount = tileCounts.SPRITE_BIG_SNORLAX;
    const facingEntry = metadata.facings["FACING_BIG_DOLL_SYM"];
    const attributes = facingEntry.tiles[0]?.attributes ?? 0;
    expect(
      normalizer.normalizeTileIndex("SPRITE_BIG_SNORLAX", sprite, tileCount, 0x80, attributes),
    ).toBe(0);
    expect(
      normalizer.normalizeTileIndex("SPRITE_BIG_SNORLAX", sprite, tileCount, 0x8b, attributes),
    ).toBe(11);
  });

  it("never returns null for the targeted tiles", () => {
    for (const sprite of SPRITES_UNDER_TEST) {
      const facings = TARGET_FACINGS[sprite] ?? [];
      for (const facing of facings) {
        const indices = indicesFor(sprite, facing);
        expect(indices).toHaveLength(metadata.facings[facing].tiles.length);
      }
    }
  });
});

describe("background-derived object palettes", () => {
  it("constructs special WHITE and GRASS palettes from BG colors 0,0,1,2", () => {
    const { metadata } = loadMetadataSubset();
    const cache = new ObjectSpriteCache(metadata, "day");
    const rows: RgbTuple[][] = Array.from({ length: 8 }, (_, slot) =>
      Array.from({ length: 4 }, (_, color) => [slot * 20 + color, color, slot]));
    cache.setBgPalettes(rows);
    const resolvePalette = (name: string) => (cache as unknown as {
      resolvePalette(name: string): RgbTuple[];
    }).resolvePalette(name);
    expect(resolvePalette("PAL_OW_COPY_BG_WHITE")).toEqual([rows[0][0], rows[0][0], rows[0][1], rows[0][2]]);
    expect(resolvePalette("PAL_OW_COPY_BG_GRASS")).toEqual([rows[2][0], rows[2][0], rows[2][1], rows[2][2]]);
    expect(resolvePalette("PAL_OW_COPY_BG_GREEN")).toEqual(rows[2]);
    rows[2] = [[10, 20, 30], [40, 50, 60], [70, 80, 90], [0, 0, 0]];
    cache.setBgPalettes(rows);
    expect(resolvePalette("PAL_OW_COPY_BG_GRASS")).toEqual([rows[2][0], rows[2][0], rows[2][1], rows[2][2]]);
  });
});

describe("NPC glow sprite colors", () => {
  function fixture() {
    const { metadata } = loadMetadataSubset();
    metadata.glow = { collision_types: {}, adjustments: { OBJ_GLOW_AQUARIUM: [2, 5, 9] }, fade_steps: 15, fade_step_frames: 2 };
    const row = (n: number): RgbTuple[] => [[255, 255, 255], [n, n, n], [8, 8, 8], [0, 0, 0]];
    metadata.palettes.PAL_OW_RED = { timeVariants: { day: row(82), nite: row(41) }, overcast: { nite: row(25) }, darkness: row(16) };
    metadata.palettes.PAL_OW_STATIC = { static: row(82), darkness: row(16) };
    metadata.sprites.TEST = { id: 1, gfxPointer: "Test", spriteType: "STANDING_SPRITE", defaultPalette: "PAL_OW_RED", tilePath: "test", tileCount: 1, tiles2bppBase64: Buffer.from([255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0, 255, 0]).toString("base64") };
    metadata.facings.TEST = { label: "Test", tiles: [{ dx: 0, dy: 0, tile: 0, attributes: 0 }] };
    const cache = new ObjectSpriteCache(metadata, "nite");
    const pixel = (palette?: string) => {
      const record = cache.getFacingTexture("TEST", "TEST", palette);
      expect(record).not.toBeNull();
      const resource = record!.texture.baseTexture.resource as unknown as { data: Uint8Array };
      return Array.from(resource.data.slice(0, 4));
    };
    return { cache, pixel, row };
  }

  it("uses day/night endpoints despite darkness and overcast, without stale cached colors", () => {
    const { cache, pixel } = fixture();
    cache.setPaletteContext({ darkness: true, overcast: true });
    expect(pixel()).toEqual([16, 16, 16, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_DAY", current: "OBJ_GLOW_DAY", steps: 15 });
    expect(pixel()).toEqual([82, 82, 82, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_NITE", current: "OBJ_GLOW_NITE", steps: 15 });
    expect(pixel()).toEqual([41, 41, 41, 255]);
    cache.destroy();
  });

  it("applies RGB glow after selecting local background colors and preserves fade endpoints", () => {
    const { cache, pixel, row } = fixture();
    cache.setBgPalettes(Array.from({ length: 8 }, () => row(82)));
    cache.setGlowState({ previous: "OBJ_GLOW_AQUARIUM", current: "OBJ_GLOW_AQUARIUM", steps: 15 });
    expect(pixel("PAL_OW_COPY_BG_GREEN")).toEqual([99, 123, 156, 255]);
    cache.setBgPalettes(Array.from({ length: 8 }, () => row(41)));
    expect(pixel("PAL_OW_COPY_BG_GREEN")).toEqual([58, 82, 115, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_NONE", current: "OBJ_GLOW_AQUARIUM", steps: 0 });
    expect(pixel("PAL_OW_COPY_BG_GREEN")).toEqual([41, 41, 41, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_NONE", current: "OBJ_GLOW_AQUARIUM", steps: 15 });
    expect(pixel("PAL_OW_COPY_BG_GREEN")).toEqual([58, 82, 115, 255]);
    cache.destroy();
  });

  it("preserves individual palette sources in darkness and adds RGB glow afterwards", () => {
    const { cache, pixel } = fixture();
    cache.setPaletteContext({ darkness: true, overcast: true });
    expect(pixel("PAL_OW_STATIC")).toEqual([82, 82, 82, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_AQUARIUM", current: "OBJ_GLOW_AQUARIUM", steps: 15 });
    expect(pixel("PAL_OW_STATIC")).toEqual([99, 123, 156, 255]);
    cache.destroy();
  });

  it("uses explicit map palette time indoors and restores it during movement refresh", () => {
    const { cache, pixel } = fixture();
    cache.setTimeOfDay("day");
    cache.setPaletteContext({ indoor: true, paletteTime: "nite" });
    const aquariumContext = cache.getPaletteContext();
    expect(pixel()).toEqual([41, 41, 41, 255]);
    cache.setPaletteContext({ indoor: true, paletteTime: "day" });
    expect(pixel()).toEqual([82, 82, 82, 255]);
    cache.setPaletteContext(aquariumContext);
    expect(pixel()).toEqual([41, 41, 41, 255]);
    cache.setGlowState({ previous: "OBJ_GLOW_DAY", current: "OBJ_GLOW_DAY", steps: 15 });
    expect(pixel()).toEqual([82, 82, 82, 255]);
    cache.setPaletteContext({ indoor: true, paletteTime: "nite", overcast: true });
    expect(pixel()).toEqual([25, 25, 25, 255]);
    cache.setPaletteContext({ indoor: true, paletteTime: "nite", darkness: true, overcast: true });
    expect(pixel()).toEqual([16, 16, 16, 255]);
    cache.setPaletteContext({ indoor: true }); // old bundle fallback
    expect(pixel()).toEqual([82, 82, 82, 255]);
    cache.destroy();
  });
});
