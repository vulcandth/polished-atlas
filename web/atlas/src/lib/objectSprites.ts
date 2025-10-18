import { BaseTexture, Texture } from "pixi.js";
import type {
  ObjectFacingEntry,
  ObjectMetadata,
  ObjectSpriteDefinition,
  PokemonIconMetadata,
  RgbTuple,
} from "@/types";
import { decodeBase64 } from "@/lib/base64";

type FacingTextureRecord = {
  texture: Texture;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
};

const DEFAULT_PALETTE: RgbTuple[] = [
  [255, 255, 255],
  [170, 170, 170],
  [85, 85, 85],
  [0, 0, 0],
];

const DEBUG_SPRITES = new Set([
  "SPRITE_SAILBOAT",
  "SPRITE_BIG_GYARADOS",
  "SPRITE_BIG_SNORLAX",
]);

function decodeTilePixels(tileBytes: Uint8Array): Uint8Array[] {
  if (tileBytes.length % 16 !== 0) {
    return [];
  }
  const tileCount = tileBytes.length / 16;
  const tiles: Uint8Array[] = [];
  for (let tileIndex = 0; tileIndex < tileCount; tileIndex += 1) {
    const pixels = new Uint8Array(64);
    const base = tileIndex * 16;
    for (let row = 0; row < 8; row += 1) {
      const low = tileBytes[base + row * 2];
      const high = tileBytes[base + row * 2 + 1];
      for (let column = 0; column < 8; column += 1) {
        const shift = 7 - column;
        const loBit = (low >> shift) & 0x01;
        const hiBit = (high >> shift) & 0x01;
        const value = loBit | (hiBit << 1);
        pixels[row * 8 + column] = value;
      }
    }
    tiles.push(pixels);
  }
  return tiles;
}

function clampPalette(colors: RgbTuple[]): RgbTuple[] {
  if (colors.length >= 4) {
    return colors.slice(0, 4);
  }
  const output = colors.slice();
  while (output.length < 4) {
    output.push(DEFAULT_PALETTE[output.length] ?? DEFAULT_PALETTE[DEFAULT_PALETTE.length - 1]);
  }
  return output;
}

export class ObjectSpriteCache {
  private readonly metadata: ObjectMetadata;
  private readonly facingKeyByLabel: Map<string, string>;
  private readonly tileCache = new Map<string, Uint8Array[]>();
  private readonly textureCache = new Map<string, FacingTextureRecord>();
  private readonly pokemonIcons: PokemonIconMetadata | null;
  private readonly pokemonIconTileCache = new Map<string, Uint8Array[]>();
  private readonly pokemonIconTextureCache = new Map<string, FacingTextureRecord[]>();
  private timeOfDay: string;

  constructor(metadata: ObjectMetadata, timeOfDay: string) {
    this.metadata = metadata;
    this.timeOfDay = timeOfDay;
    this.facingKeyByLabel = new Map();
    for (const [key, entry] of Object.entries(metadata.facings)) {
      this.facingKeyByLabel.set(entry.label, key);
    }
    this.pokemonIcons = metadata.pokemonIcons ?? null;
  }

  setTimeOfDay(next: string): void {
    if (this.timeOfDay === next) {
      return;
    }
    this.timeOfDay = next;
    this.clearTextures();
  }

  destroy(): void {
    this.clearTextures();
    this.tileCache.clear();
    this.facingKeyByLabel.clear();
  }

  getFacingTexture(
    spriteName: string,
    facingKey: string,
    paletteName: string | null | undefined
  ): FacingTextureRecord | null {
    if (!spriteName || !facingKey) {
      return null;
    }
    const cacheKey = `${spriteName}|${facingKey}|${paletteName ?? ""}|${this.timeOfDay}`;
    const cached = this.textureCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const spriteDef = this.metadata.sprites[spriteName];
    if (!spriteDef) {
      return null;
    }
    const palette = this.resolvePalette(paletteName ?? spriteDef.defaultPalette);
    const buildFallback = (): FacingTextureRecord | null => {
      const fallback = this.buildGeneratedTexture(spriteName, palette);
      if (fallback && import.meta.env?.DEV && DEBUG_SPRITES.has(spriteName)) {
        console.info(`[SpriteCache] Generated fallback texture for ${spriteName} (${facingKey}) at ${fallback.width}x${fallback.height}`);
      }
      return fallback;
    };
    if (spriteDef.tileCount <= 0 || !spriteDef.tiles2bppBase64) {
      const fallback = buildFallback();
      if (fallback) {
        this.textureCache.set(cacheKey, fallback);
      }
      return fallback;
    }
    const tiles = this.ensureTilePixels(spriteName, spriteDef);
    if (!tiles.length) {
      const fallback = buildFallback();
      if (fallback) {
        this.textureCache.set(cacheKey, fallback);
      }
      return fallback;
    }
    const facing = this.resolveFacingEntry(facingKey);
    if (!facing || facing.tiles.length === 0) {
      const fallback = buildFallback();
      if (fallback) {
        this.textureCache.set(cacheKey, fallback);
      }
      return fallback;
    }
    const record = this.buildTexture(spriteName, spriteDef, facing, tiles, palette);
    if (!record) {
      const fallback = buildFallback();
      if (fallback) {
        this.textureCache.set(cacheKey, fallback);
      }
      return fallback ?? null;
    }
    this.textureCache.set(cacheKey, record);
    return record;
  }

  private clearTextures(): void {
    for (const record of this.textureCache.values()) {
      record.texture.destroy(true);
    }
    this.textureCache.clear();
    for (const records of this.pokemonIconTextureCache.values()) {
      for (const record of records) {
        record.texture.destroy(true);
      }
    }
    this.pokemonIconTextureCache.clear();
  }

  private ensureTilePixels(name: string, definition: ObjectSpriteDefinition): Uint8Array[] {
    const cached = this.tileCache.get(name);
    if (cached) {
      return cached;
    }
    if (!definition.tiles2bppBase64) {
      this.tileCache.set(name, []);
      return [];
    }
    try {
      const bytes = decodeBase64(definition.tiles2bppBase64);
      const tiles = decodeTilePixels(bytes);
      this.tileCache.set(name, tiles);
      return tiles;
    } catch (err) {
      console.error(`Failed to decode sprite tiles for ${name}`, err);
      this.tileCache.set(name, []);
      return [];
    }
  }

  getPokemonIconFrameTextures(
    speciesConstant: string | null,
    formConstant: string | null,
    overridePalette: string | null,
  ): { frames: FacingTextureRecord[]; frameDurationFrames: number } | null {
    if (!this.pokemonIcons || !speciesConstant) {
      return null;
    }
    const speciesEntry = this.pokemonIcons.entries?.[speciesConstant];
    if (!speciesEntry) {
      return null;
    }
    const forms = speciesEntry.forms ?? {};
    const normalizedForm = formConstant && forms[formConstant] ? formConstant : forms["NO_FORM"] ? "NO_FORM" : Object.keys(forms)[0];
    if (!normalizedForm) {
      return null;
    }
    const variant = forms[normalizedForm];
    if (!variant || !variant.tiles2bppBase64) {
      return null;
    }
    const paletteKey = overridePalette ?? variant.palette?.normal ?? null;
    const cacheKey = `icon|${speciesConstant}|${normalizedForm}|${paletteKey ?? ""}|${this.timeOfDay}`;
    const cachedFrames = this.pokemonIconTextureCache.get(cacheKey);
    if (cachedFrames) {
      const durationFrames = Math.max(1, Math.trunc(variant.frameDurationFrames || this.pokemonIcons.defaultFrameDurationFrames || 8));
      return { frames: cachedFrames, frameDurationFrames: durationFrames };
    }

    let tiles = this.pokemonIconTileCache.get(variant.tiles2bppBase64);
    if (!tiles) {
      try {
        const bytes = decodeBase64(variant.tiles2bppBase64);
        tiles = decodeTilePixels(bytes);
      } catch (err) {
        console.error("Failed to decode pokemon icon tiles", speciesConstant, normalizedForm, err);
        tiles = [];
      }
      this.pokemonIconTileCache.set(variant.tiles2bppBase64, tiles);
    }
    if (!tiles || tiles.length === 0) {
      return null;
    }

    const frameTileStride = Math.max(1, Math.trunc(variant.frameTileStride || this.pokemonIcons.frameTileStride || 4));
    const width = Math.max(8, Math.trunc(variant.width || this.pokemonIcons.framePixelWidth || 16));
    const height = Math.max(8, Math.trunc(variant.height || this.pokemonIcons.framePixelHeight || width));
    const inferredFrameCount = Math.max(1, Math.trunc(tiles.length / frameTileStride));
    const frameCount = Math.max(1, Math.trunc(variant.frameCount || inferredFrameCount));
    if (tiles.length < frameTileStride) {
      return null;
    }

    const palette = this.resolvePalette(paletteKey);
    const colors = clampPalette(palette);
    const frames: FacingTextureRecord[] = [];
    const tilesPerRow = Math.max(1, Math.ceil(width / 8));
    const tilesPerColumn = Math.max(1, Math.ceil(height / 8));
    const stride = tilesPerRow * tilesPerColumn;
    const effectiveStride = Math.max(frameTileStride, stride);

    for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
      const start = frameIndex * effectiveStride;
      const end = start + effectiveStride;
      if (end > tiles.length) {
        break;
      }
      const frameTiles = tiles.slice(start, end);
      if (frameTiles.length < stride) {
        break;
      }
      const buffer = new Uint8Array(width * height * 4);
      for (let tileRow = 0; tileRow < tilesPerColumn; tileRow += 1) {
        for (let tileCol = 0; tileCol < tilesPerRow; tileCol += 1) {
          const tileIndex = tileRow * tilesPerRow + tileCol;
          const tilePixels = frameTiles[tileIndex];
          if (!tilePixels) {
            continue;
          }
          for (let row = 0; row < 8; row += 1) {
            const destY = tileRow * 8 + row;
            if (destY >= height) {
              continue;
            }
            for (let column = 0; column < 8; column += 1) {
              const destX = tileCol * 8 + column;
              if (destX >= width) {
                continue;
              }
              const pixelValue = tilePixels[row * 8 + column];
              if (pixelValue === 0) {
                continue;
              }
              const color = colors[pixelValue] ?? DEFAULT_PALETTE[Math.min(pixelValue, DEFAULT_PALETTE.length - 1)];
              const offset = (destY * width + destX) * 4;
              buffer[offset] = color[0];
              buffer[offset + 1] = color[1];
              buffer[offset + 2] = color[2];
              buffer[offset + 3] = 255;
            }
          }
        }
      }
      const baseTexture = BaseTexture.fromBuffer(buffer, width, height);
      const texture = new Texture(baseTexture);
      frames.push({
        texture,
        offsetX: -Math.floor(width / 2),
        offsetY: -Math.floor(height / 2),
        width,
        height,
      });
    }

    if (frames.length === 0) {
      return null;
    }

    this.pokemonIconTextureCache.set(cacheKey, frames);
    const durationFrames = Math.max(1, Math.trunc(variant.frameDurationFrames || this.pokemonIcons.defaultFrameDurationFrames || 8));
    return { frames, frameDurationFrames: durationFrames };
  }

  private resolveFacingEntry(key: string): ObjectFacingEntry | null {
    if (!key) {
      return null;
    }
    const direct = this.metadata.facings[key];
    if (direct) {
      return direct;
    }
    const altKey = this.facingKeyByLabel.get(key);
    if (altKey) {
      return this.metadata.facings[altKey] ?? null;
    }
    return null;
  }

  private resolvePalette(name: string | null | undefined): RgbTuple[] {
    if (!name) {
      return DEFAULT_PALETTE;
    }
    const entry = this.metadata.palettes[name];
    if (!entry) {
      return DEFAULT_PALETTE;
    }
    const variants = entry.timeVariants ?? {};
    if (variants[this.timeOfDay]?.length) {
      return clampPalette(variants[this.timeOfDay]!);
    }
    if (variants.day?.length) {
      return clampPalette(variants.day);
    }
    const variantValues = Object.values(variants);
    if (variantValues.length > 0 && variantValues[0]?.length) {
      return clampPalette(variantValues[0]!);
    }
    if (entry.static?.length) {
      return clampPalette(entry.static);
    }
    return DEFAULT_PALETTE;
  }

  private buildTexture(
    spriteName: string,
    spriteDef: ObjectSpriteDefinition,
    facing: ObjectFacingEntry,
    tiles: Uint8Array[],
    palette: RgbTuple[]
  ): FacingTextureRecord | null {
    const shouldDebug = import.meta.env?.DEV && DEBUG_SPRITES.has(spriteName);
    let minX = 0;
    let minY = 0;
    let maxX = 0;
    let maxY = 0;
    for (const tileEntry of facing.tiles) {
      const dx = tileEntry.dx ?? 0;
      const dy = tileEntry.dy ?? 0;
      if (dx < minX) minX = dx;
      if (dy < minY) minY = dy;
      if (dx + 8 > maxX) maxX = dx + 8;
      if (dy + 8 > maxY) maxY = dy + 8;
    }
    const width = Math.max(8, maxX - minX);
    const height = Math.max(8, maxY - minY);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      return null;
    }
    const buffer = new Uint8Array(width * height * 4);
    const colors = clampPalette(palette);

    for (const tileEntry of facing.tiles) {
      const dx = tileEntry.dx ?? 0;
      const dy = tileEntry.dy ?? 0;
      const normalizedIndex = this.normalizeTileIndex(
        spriteName,
        spriteDef,
        tiles.length,
        tileEntry.tile ?? 0,
        tileEntry.attributes ?? 0
      );
      if (normalizedIndex === null) {
        continue;
      }
      const tilePixels = tiles[normalizedIndex];
      const attributes = tileEntry.attributes ?? 0;
      const flipX = (attributes & 0x20) !== 0;
      const flipY = (attributes & 0x40) !== 0;
      for (let row = 0; row < 8; row += 1) {
        const sourceRow = flipY ? 7 - row : row;
        const destY = dy - minY + row;
        if (destY < 0 || destY >= height) {
          continue;
        }
        for (let column = 0; column < 8; column += 1) {
          const sourceColumn = flipX ? 7 - column : column;
          const destX = dx - minX + column;
          if (destX < 0 || destX >= width) {
            continue;
          }
          const pixelValue = tilePixels[sourceRow * 8 + sourceColumn];
          if (pixelValue === 0) {
            continue;
          }
          const color = colors[pixelValue] ?? DEFAULT_PALETTE[Math.min(pixelValue, DEFAULT_PALETTE.length - 1)];
          const offset = (destY * width + destX) * 4;
          buffer[offset] = color[0];
          buffer[offset + 1] = color[1];
          buffer[offset + 2] = color[2];
          buffer[offset + 3] = 255;
        }
      }
    }

    const baseTexture = BaseTexture.fromBuffer(buffer, width, height);
    const texture = new Texture(baseTexture);
    if (shouldDebug) {
      console.info(
        `[SpriteCache] ${spriteName} built facing ${facing.label} at ${width}x${height} (min=${minX},${minY}) using ${facing.tiles.length} tiles`
      );
    }
    return {
      texture,
      offsetX: minX,
      offsetY: minY,
      width,
      height,
    };
  }

  private normalizeTileIndex(
    spriteName: string,
    spriteDef: ObjectSpriteDefinition,
    tileCount: number,
    rawIndex: number,
    attributes: number
  ): number | null {
    const shouldDebug = import.meta.env?.DEV && DEBUG_SPRITES.has(spriteName);
    if (!Number.isFinite(rawIndex)) {
      if (shouldDebug) {
        console.info(
          `[SpriteCache] ${spriteName} received NaN tile index (facing attr=${attributes.toString(16)})`
        );
      }
      return null;
    }
    const declaredCount = spriteDef.tileCount > 0 ? spriteDef.tileCount : tileCount;
    const limit = Math.max(0, Math.min(tileCount, declaredCount));
    if (rawIndex >= 0 && rawIndex < limit) {
      return rawIndex;
    }
    const ABSOLUTE_TILE_ID_FLAG = 1 << 2;
    if ((attributes & ABSOLUTE_TILE_ID_FLAG) !== 0) {
      return rawIndex >= 0 && rawIndex < limit ? rawIndex : null;
    }

    if (rawIndex >= 0x80) {
      const adjustedBankIndex = this.resolveBankedTileIndex(spriteName, spriteDef, limit, rawIndex);
      if (adjustedBankIndex !== null) {
        if (shouldDebug) {
          console.info(
            `[SpriteCache] ${spriteName} mapped 0x${rawIndex.toString(16)} -> ${adjustedBankIndex} (limit=${limit})`
          );
        }
        return adjustedBankIndex;
      }
    }
    if (shouldDebug) {
      console.info(
        `[SpriteCache] ${spriteName} failed to map tile 0x${rawIndex.toString(16)} (limit=${limit}, attr=0x${attributes.toString(16)})`
      );
    }
    return null;
  }

  private resolveBankedTileIndex(
    spriteName: string,
    spriteDef: ObjectSpriteDefinition,
    limit: number,
    rawIndex: number
  ): number | null {
    if (!(limit > 0) || rawIndex < 0x80) {
      return null;
    }
    const bankIndex = Math.floor(rawIndex / 0x80);
    if (bankIndex <= 0) {
      return null;
    }
    const baseIndex = rawIndex & 0x7f;

    const perBankSpan = this.inferPerBankSpan(spriteName, spriteDef, limit);
    if (perBankSpan > 0 && baseIndex < perBankSpan) {
      const adjusted = bankIndex * perBankSpan + baseIndex;
      if (adjusted >= 0 && adjusted < limit) {
        return adjusted;
      }
    }

    if (spriteName === "SPRITE_SAILBOAT") {
      // Sailboat graphics load banked tiles late in the sheet; strip the high
      // bit and fall back to the decoded tail so we keep the hull intact.
      const adjusted = rawIndex - 0x74;
      if (adjusted >= 0 && adjusted < limit) {
        return adjusted;
      }
    }

    if (spriteName === "SPRITE_BIG_GYARADOS") {
      // The large Gyarados sprite dedicates the second bank to follow the first
      // half directly, so mirror that layout for the atlas textures.
      const half = Math.floor(limit / 2);
      const offset = rawIndex & 0x7f;
      const adjusted = half + offset;
      if (adjusted >= 0 && adjusted < limit) {
        return adjusted;
      }
    }

    if (spriteName === "SPRITE_BIG_SNORLAX") {
      // Big Snorlax only ships a single bank of tiles; the upper-half indices
      // simply repeat the base sheet. Strip the bank bit and reuse the first
      // bank entry.
      const adjusted = rawIndex & 0x7f;
      if (adjusted >= 0 && adjusted < limit) {
        return adjusted;
      }
    }

    return null;
  }

  private inferPerBankSpan(
    spriteName: string,
    spriteDef: ObjectSpriteDefinition,
    limit: number
  ): number {
    if (!(limit > 0)) {
      return 0;
    }
    if (spriteDef.spriteType === "WALKING_SPRITE") {
      return Math.floor(limit / 2);
    }
    if (spriteName === "SPRITE_BIG_GYARADOS" || spriteName === "SPRITE_SAILBOAT") {
      return Math.floor(limit / 2);
    }
    return 0;
  }

  private buildGeneratedTexture(spriteName: string, palette: RgbTuple[]): FacingTextureRecord | null {
    if (spriteName !== "SPRITE_MON_ICON") {
      return null;
    }
    const colors = clampPalette(palette);
    const outline = colors[3] ?? colors[2] ?? colors[1] ?? colors[0];
    const fill = colors[1] ?? colors[0];
    const highlight = colors[0] ?? fill;
    const width = 16;
    const height = 16;
    const centerX = (width - 1) / 2;
    const centerY = (height - 1) / 2;
    const radius = 6;
    const radiusSq = radius * radius;
    const borderSq = Math.max(0, (radius - 1) * (radius - 1));
    const highlightSq = 9;
    const buffer = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const dx = x - centerX;
        const dy = y - centerY;
        const distSq = dx * dx + dy * dy;
        if (distSq > radiusSq) {
          continue;
        }
        let color: RgbTuple;
        if (distSq >= borderSq) {
          color = outline;
        } else if (distSq <= highlightSq && dy < 0) {
          color = highlight;
        } else {
          color = fill;
        }
        const offset = (y * width + x) * 4;
        buffer[offset] = color[0];
        buffer[offset + 1] = color[1];
        buffer[offset + 2] = color[2];
        buffer[offset + 3] = 255;
      }
    }
    const baseTexture = BaseTexture.fromBuffer(buffer, width, height);
    const texture = new Texture(baseTexture);
    return {
      texture,
      offsetX: -8,
      offsetY: -8,
      width,
      height,
    };
  }
}
