import type { ObjectEventEntry } from "@/types";

export interface PlacementContext {
  atlasBlockPixelSize: number;
  metadataBlockPixelSize: number;
  cellsPerBlock: number;
  eventCellPixelSize: number;
}

const DEFAULT_ATLAS_BLOCK = 32;
const DEFAULT_CELLS_PER_BLOCK = 2;

export function computeObjectPriority(flags2: number | null | undefined): number {
  // InitSprites tests LOW_PRIORITY (bit 0) before HIGH_PRIORITY (bit 1).
  // Higher groups are written last into reverse-ordered OAM, hence appear in front.
  if ((flags2 ?? 0) & 1) return 0;
  if ((flags2 ?? 0) & 2) return 2;
  return 1;
}

function normalisePositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function computeObjectPosition(
  entry: Pick<ObjectEventEntry, "xTiles" | "yTiles" | "xPixels" | "yPixels" | "spriteYOffset">,
  context: PlacementContext,
): { x: number; y: number } {
  const atlasBlock = normalisePositive(context.atlasBlockPixelSize, DEFAULT_ATLAS_BLOCK);
  const metadataBlock = normalisePositive(context.metadataBlockPixelSize, atlasBlock);
  const cellsPerBlock = Math.max(
    1,
    Math.trunc(normalisePositive(context.cellsPerBlock, DEFAULT_CELLS_PER_BLOCK)),
  );
  const baseCellPixelSize = normalisePositive(
    context.eventCellPixelSize,
    metadataBlock / cellsPerBlock,
  );
  const pixelScale = metadataBlock !== 0 ? atlasBlock / metadataBlock : 1;
  const atlasCellPixelSize = baseCellPixelSize * pixelScale;

  const usingTileUnitsX = Number.isFinite(entry.xTiles);
  const usingTileUnitsY = Number.isFinite(entry.yTiles);

  const xCells = usingTileUnitsX
    ? (entry.xTiles as number)
    : Number.isFinite(entry.xPixels)
      ? (entry.xPixels as number) / baseCellPixelSize
      : 0;
  const yCells = usingTileUnitsY
    ? (entry.yTiles as number)
    : Number.isFinite(entry.yPixels)
      ? (entry.yPixels as number) / baseCellPixelSize
      : 0;

  // Modern metadata includes InitSprites' BG_ALIGNED/BG_OFFSET adjustment.
  // Older bundles retain the ordinary quarter-cell upward offset.
  const yOffset = usingTileUnitsY
    ? (entry.spriteYOffset ?? -baseCellPixelSize / 4) * pixelScale : 0;

  return {
    x: xCells * atlasCellPixelSize,
    y: yCells * atlasCellPixelSize + yOffset,
  };
}
