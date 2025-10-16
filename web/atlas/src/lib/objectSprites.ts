import { BaseTexture, Texture } from "pixi.js";
import type {
  ObjectFacingEntry,
  ObjectMetadata,
  ObjectSpriteDefinition,
  RgbTuple,
} from "@/types";

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

function decodeBase64(data: string): Uint8Array {
  if (!data) {
    return new Uint8Array();
  }
  if (typeof atob === "function") {
    const binary = atob(data);
    const buffer = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      buffer[index] = binary.charCodeAt(index);
    }
    return buffer;
  }
  const globalBuffer = (globalThis as unknown as { Buffer?: { from(data: string, encoding: string): Uint8Array } }).Buffer;
  if (globalBuffer) {
    const decoded = globalBuffer.from(data, "base64");
    return decoded instanceof Uint8Array ? decoded : Uint8Array.from(decoded as unknown as number[]);
  }
  throw new Error("No base64 decoder available in this environment.");
}

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
  private timeOfDay: string;

  constructor(metadata: ObjectMetadata, timeOfDay: string) {
    this.metadata = metadata;
    this.timeOfDay = timeOfDay;
    this.facingKeyByLabel = new Map();
    for (const [key, entry] of Object.entries(metadata.facings)) {
      this.facingKeyByLabel.set(entry.label, key);
    }
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
    if (!spriteDef || spriteDef.tileCount <= 0 || !spriteDef.tiles2bppBase64) {
      return null;
    }
    const tiles = this.ensureTilePixels(spriteName, spriteDef);
    if (!tiles.length) {
      return null;
    }
    const facing = this.resolveFacingEntry(facingKey);
    if (!facing || facing.tiles.length === 0) {
      return null;
    }
    const palette = this.resolvePalette(paletteName ?? spriteDef.defaultPalette);
    const record = this.buildTexture(spriteName, spriteDef, facing, tiles, palette);
    if (!record) {
      return null;
    }
    this.textureCache.set(cacheKey, record);
    return record;
  }

  private clearTextures(): void {
    for (const record of this.textureCache.values()) {
      record.texture.destroy(true);
    }
    this.textureCache.clear();
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
        tileEntry.tile ?? 0
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
    rawIndex: number
  ): number | null {
    if (!Number.isFinite(rawIndex)) {
      return null;
    }
    const declaredCount = spriteDef.tileCount > 0 ? spriteDef.tileCount : tileCount;
    const limit = Math.max(0, Math.min(tileCount, declaredCount));
    if (rawIndex >= 0 && rawIndex < limit) {
      return rawIndex;
    }
    if (rawIndex >= 0x80 && spriteName === "SPRITE_SAILBOAT") {
      // Sailboat graphics load into VRAM bank 1 in-game, so high tile IDs
      // need to wrap back into the tail of the decoded sheet.
      const adjusted = rawIndex - 0x74;
      if (adjusted >= 0 && adjusted < limit) {
        return adjusted;
      }
    }
    return null;
  }
}
