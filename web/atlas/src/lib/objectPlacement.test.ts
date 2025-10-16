import { describe, expect, it } from "vitest";
import { computeObjectPosition, type PlacementContext } from "./objectPlacement";

describe("computeObjectPosition", () => {
  it("uses collision-cell units when tiles are provided", () => {
    const context: PlacementContext = {
      atlasBlockPixelSize: 32,
      metadataBlockPixelSize: 32,
      cellsPerBlock: 2,
      eventCellPixelSize: 16,
    };
    const position = computeObjectPosition(
      { xTiles: 3, yTiles: 2, xPixels: 0, yPixels: 0 },
      context
    );
    expect(position.x).toBe(48);
    expect(position.y).toBe(32);
  });

  it("falls back to pixels when tile data is missing", () => {
    const context: PlacementContext = {
      atlasBlockPixelSize: 32,
      metadataBlockPixelSize: 32,
      cellsPerBlock: 2,
      eventCellPixelSize: 16,
    };
    const position = computeObjectPosition(
      { xTiles: Number.NaN, yTiles: Number.NaN, xPixels: 160, yPixels: 96 },
      context
    );
    expect(position.x).toBeCloseTo(160, 6);
    expect(position.y).toBeCloseTo(96, 6);
  });

  it("scales coordinates when atlas and metadata block sizes differ", () => {
    const context: PlacementContext = {
      atlasBlockPixelSize: 64,
      metadataBlockPixelSize: 32,
      cellsPerBlock: 2,
      eventCellPixelSize: 16,
    };
    const position = computeObjectPosition(
      { xTiles: 1, yTiles: 1, xPixels: 0, yPixels: 0 },
      context
    );
    expect(position.x).toBe(32);
    expect(position.y).toBe(32);
  });
});
