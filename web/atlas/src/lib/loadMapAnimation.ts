import { Assets, BaseTexture, Rectangle, Texture } from "pixi.js";
import type { MapAnimationMetadata } from "@/types";

export interface MapAnimationResource {
  textures: Texture[];
  frameDurations: number[];
  loopDuration: number;
  baseTexture: BaseTexture;
  imageUrl: string;
}

export async function loadMapAnimation(assetUrl: string): Promise<MapAnimationResource> {
  const response = await fetch(assetUrl, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Failed to load animation metadata from ${assetUrl} (status ${response.status})`);
  }
  const metadata = (await response.json()) as MapAnimationMetadata;
  validateMetadata(metadata, assetUrl);
  const baseHref = new URL(assetUrl, window.location.href);
  const resolvedImageUrl = new URL(metadata.image, baseHref).toString();
  await Assets.load(resolvedImageUrl);
  const baseTexture = BaseTexture.from(resolvedImageUrl);
  const textures: Texture[] = [];
  const desiredColumnsRaw = metadata.sheetColumns ?? metadata.frameCount;
  const desiredColumns = Number.isFinite(desiredColumnsRaw) ? Math.floor(desiredColumnsRaw) : metadata.frameCount;
  const textureColumns = Math.max(1, Math.floor(baseTexture.width / metadata.frameWidth));
  const textureRows = Math.max(1, Math.floor(baseTexture.height / metadata.frameHeight));
  let sheetColumns = Math.max(1, Math.min(metadata.frameCount, textureColumns, desiredColumns));
  let sheetRows = Math.max(1, Math.ceil(metadata.frameCount / sheetColumns));

  if (sheetRows > textureRows) {
    let adjustedColumns = sheetColumns;
    while (adjustedColumns > 1) {
      adjustedColumns -= 1;
      if (adjustedColumns > textureColumns) {
        continue;
      }
      const candidateRows = Math.ceil(metadata.frameCount / adjustedColumns);
      if (candidateRows <= textureRows) {
        sheetColumns = adjustedColumns;
        sheetRows = candidateRows;
        break;
      }
    }
    if (sheetRows > textureRows) {
      sheetColumns = Math.max(1, Math.min(textureColumns, metadata.frameCount));
      sheetRows = Math.max(1, Math.ceil(metadata.frameCount / sheetColumns));
    }
    if (sheetRows > textureRows) {
      throw new Error(`Animation sheet at ${assetUrl} does not fit inside the base texture bounds.`);
    }
  }
  for (let index = 0; index < metadata.frameCount; index += 1) {
    const columnIndex = index % sheetColumns;
    const rowIndex = Math.floor(index / sheetColumns);
    const frameRect = new Rectangle(
      columnIndex * metadata.frameWidth,
      rowIndex * metadata.frameHeight,
      metadata.frameWidth,
      metadata.frameHeight
    );
    textures.push(new Texture(baseTexture, frameRect));
  }
  const durations = [...metadata.frameDurationsMs];
  const loopDuration = metadata.loopDurationMs > 0 ? metadata.loopDurationMs : durations.reduce((a, b) => a + b, 0);
  return {
    textures,
    frameDurations: durations,
    loopDuration,
    baseTexture,
    imageUrl: resolvedImageUrl,
  };
}

function validateMetadata(metadata: MapAnimationMetadata, assetUrl: string): void {
  if (metadata.version !== 1) {
    console.warn(`Unsupported animation metadata version ${metadata.version} for ${assetUrl}.`);
  }
  if (!Array.isArray(metadata.frameDurationsMs) || metadata.frameDurationsMs.length !== metadata.frameCount) {
    throw new Error(`Animation metadata at ${assetUrl} has inconsistent frame durations.`);
  }
  if (metadata.frameWidth <= 0 || metadata.frameHeight <= 0) {
    throw new Error(`Animation metadata at ${assetUrl} reports invalid frame dimensions.`);
  }
  if (metadata.sheetColumns !== undefined) {
    if (!Number.isFinite(metadata.sheetColumns) || metadata.sheetColumns <= 0) {
      throw new Error(`Animation metadata at ${assetUrl} reports an invalid sheet column count.`);
    }
  }
}
