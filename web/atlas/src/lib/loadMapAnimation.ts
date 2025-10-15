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
  for (let index = 0; index < metadata.frameCount; index += 1) {
    const frameRect = new Rectangle(
      index * metadata.frameWidth,
      0,
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
}
