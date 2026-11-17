import { Assets, BaseTexture, Rectangle, Texture, type Container } from "pixi.js";
import type { MapAnimationMetadata } from "@/types";
import { withVersion } from "@/lib/basePath";
import { createTileAnimationPlayer, validateTileAnimation } from "@/lib/tileAnimation";

export interface MapAnimationResource {
  textures: Texture[];
  frameDurations: number[];
  loopDuration: number;
  baseTexture: BaseTexture;
  imageUrl: string;
  tileTextures?: Texture[];
  tileImageUrl?: string;
  applyTiles?: (parent: Container, elapsedMs: number, enabled?: boolean) => void;
}

const resolvedUrlCache = new Map<string, string>();

export async function loadMapAnimation(assetUrl: string): Promise<MapAnimationResource> {
  const attemptedUrls: string[] = [];
  const seen = new Set<string>();

  const queue: string[] = [];
  const cached = resolvedUrlCache.get(assetUrl);
  if (cached && cached !== assetUrl) {
    queue.push(cached);
  }
  queue.push(assetUrl);
  const enqueueFallback = (url: string): void => {
    const fallback = computeCommonFallback(url);
    if (fallback && !seen.has(fallback)) {
      queue.push(fallback);
    }
  };

  let lastError: unknown;
  while (queue.length > 0) {
    const candidate = queue.shift()!;
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    attemptedUrls.push(candidate);
    try {
      const { metadata, responseUrl } = await fetchAnimationMetadata(candidate);
      const baseHref = new URL(responseUrl, window.location.href);
      const resolvedImageUrl = withVersion(new URL(metadata.image, baseHref).toString());
      await Assets.load(resolvedImageUrl);
      const baseTexture = BaseTexture.from(resolvedImageUrl);
      const textures: Texture[] = [];
      const desiredColumnsRaw = metadata.sheetColumns ?? metadata.frameCount;
      const desiredColumns = Number.isFinite(desiredColumnsRaw)
        ? Math.floor(desiredColumnsRaw)
        : metadata.frameCount;
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
          throw new Error(
            `Animation sheet at ${responseUrl} does not fit inside the base texture bounds.`,
          );
        }
      }
      for (let index = 0; index < metadata.frameCount; index += 1) {
        const columnIndex = index % sheetColumns;
        const rowIndex = Math.floor(index / sheetColumns);
        const frameRect = new Rectangle(
          columnIndex * metadata.frameWidth,
          rowIndex * metadata.frameHeight,
          metadata.frameWidth,
          metadata.frameHeight,
        );
        textures.push(new Texture(baseTexture, frameRect));
      }
      let tileTextures: Texture[] | undefined;
      let tileImageUrl: string | undefined;
      let applyTiles: MapAnimationResource["applyTiles"];
      if (metadata.tileAnimation) {
        const tiles = metadata.tileAnimation;
        tileImageUrl = withVersion(new URL(tiles.image, baseHref).toString());
        await Assets.load(tileImageUrl);
        const tileBase = BaseTexture.from(tileImageUrl);
        if (tileBase.width !== tiles.sheetColumns * 8 ||
            tileBase.height !== Math.ceil(tiles.tileCount / tiles.sheetColumns) * 8) {
          throw new Error(`Invalid animated tile atlas dimensions at ${tileImageUrl}`);
        }
        tileTextures = Array.from({ length: tiles.tileCount }, (_, index) => new Texture(tileBase,
          new Rectangle((index % tiles.sheetColumns) * 8, Math.floor(index / tiles.sheetColumns) * 8, 8, 8)));
        applyTiles = createTileAnimationPlayer(tiles, tileTextures);
      }
      const durations = [...metadata.frameDurationsMs];
      const loopDuration =
        metadata.loopDurationMs > 0
          ? metadata.loopDurationMs
          : durations.reduce((a, b) => a + b, 0);
      if (candidate !== assetUrl) {
        resolvedUrlCache.set(assetUrl, candidate);
      }
      return {
        textures,
        frameDurations: durations,
        loopDuration,
        baseTexture,
        imageUrl: resolvedImageUrl,
        tileTextures,
        tileImageUrl,
        applyTiles,
      };
    } catch (error) {
      lastError = error;
      enqueueFallback(candidate);
    }
  }

  const attemptedSummary = attemptedUrls.join(", ");
  const errorMessage =
    lastError instanceof Error
      ? `${lastError.message} (attempted: ${attemptedSummary || assetUrl})`
      : `Failed to load animation metadata (attempted: ${attemptedSummary || assetUrl})`;
  throw new Error(errorMessage);
}

async function fetchAnimationMetadata(
  url: string,
): Promise<{ metadata: MapAnimationMetadata; responseUrl: string }> {
  const response = await fetch(url, { cache: "force-cache" });
  if (!response.ok) {
    throw new Error(`Failed to load animation metadata from ${url} (status ${response.status})`);
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("json")) {
    throw new Error(
      `Unexpected content type for animation metadata at ${url}: ${contentType || "unknown"}`,
    );
  }
  let metadata: MapAnimationMetadata;
  try {
    metadata = (await response.json()) as MapAnimationMetadata;
  } catch (err) {
    const parseError = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid animation metadata at ${url}: ${parseError}`);
  }
  validateMetadata(metadata, url);
  return {
    metadata,
    responseUrl: response.url || url,
  };
}

function computeCommonFallback(sourceUrl: string): string | null {
  try {
    const target = new URL(sourceUrl, window.location.href);
    const markerIndex = target.pathname.lastIndexOf("/maps/");
    if (markerIndex < 0) {
      return null;
    }
    const prefix = target.pathname.slice(0, markerIndex + "/maps/".length);
    const remainder = target.pathname.slice(markerIndex + "/maps/".length);
    const segments = remainder.split("/");
    if (segments.length < 3) {
      return null;
    }
    const timeSlug = segments[0];
    if (!timeSlug || timeSlug === "common") {
      return null;
    }
    segments[0] = "common";
    target.pathname = `${prefix}${segments.join("/")}`;
    return target.toString();
  } catch {
    return null;
  }
}

function validateMetadata(metadata: MapAnimationMetadata, assetUrl: string): void {
  if (metadata.version !== 1 && metadata.version !== 2) {
    throw new Error(`Unsupported animation metadata version ${metadata.version} for ${assetUrl}.`);
  }
  if (metadata.tileAnimation) {
    if (metadata.version !== 2 || metadata.frameCount !== 1) throw new Error("Invalid tile animation version or base frame count");
    validateTileAnimation(metadata.tileAnimation, metadata.frameWidth, metadata.frameHeight);
  }
  if (
    !Array.isArray(metadata.frameDurationsMs) ||
    metadata.frameDurationsMs.length !== metadata.frameCount
  ) {
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
