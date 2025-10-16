import type { ObjectEventEntry } from "@/types";

export interface PlacementContext {
  atlasBlockPixelSize: number;
  metadataBlockPixelSize: number;
  cellsPerBlock: number;
  eventCellPixelSize: number;
}

const DEFAULT_ATLAS_BLOCK = 32;
const DEFAULT_CELLS_PER_BLOCK = 2;

function normalisePositive(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

export function computeObjectPosition(
  entry: Pick<ObjectEventEntry, "xTiles" | "yTiles" | "xPixels" | "yPixels">,
  context: PlacementContext
): { x: number; y: number } {
  const atlasBlock = normalisePositive(context.atlasBlockPixelSize, DEFAULT_ATLAS_BLOCK);
  const metadataBlock = normalisePositive(context.metadataBlockPixelSize, atlasBlock);
  const cellsPerBlock = Math.max(
    1,
    Math.trunc(normalisePositive(context.cellsPerBlock, DEFAULT_CELLS_PER_BLOCK))
  );
  const baseCellPixelSize = normalisePositive(
    context.eventCellPixelSize,
    metadataBlock / cellsPerBlock
  );
  const pixelScale = metadataBlock !== 0 ? atlasBlock / metadataBlock : 1;
  const atlasCellPixelSize = baseCellPixelSize * pixelScale;

  const xCells = Number.isFinite(entry.xTiles)
    ? entry.xTiles
    : Number.isFinite(entry.xPixels)
      ? entry.xPixels / baseCellPixelSize
      : 0;
  const yCells = Number.isFinite(entry.yTiles)
    ? entry.yTiles
    : Number.isFinite(entry.yPixels)
      ? entry.yPixels / baseCellPixelSize
      : 0;

  return {
    x: xCells * atlasCellPixelSize,
    y: yCells * atlasCellPixelSize,
  };
}
