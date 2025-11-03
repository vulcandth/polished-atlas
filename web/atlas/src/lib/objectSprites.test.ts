import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { ObjectSpriteCache } from "./objectSprites";
import type { ObjectMetadata, ObjectSpriteDefinition, ObjectFacingEntry } from "@/types";

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
