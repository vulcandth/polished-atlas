import { describe, expect, it } from "vitest";
import { Container, Sprite } from "pixi.js";
import { computeObjectPosition, computeObjectPriority, type PlacementContext } from "./objectPlacement";

describe("object drawing priority", () => {
  it("draws low-priority decorations behind NPCs regardless of event order, keeping ties stable", () => {
    const parent = new Container();
    parent.sortableChildren = true;
    const flags = [0, 2, 0, 1, 3, undefined];
    const sprites = flags.map((flags2) => {
      const sprite = new Sprite();
      sprite.zIndex = computeObjectPriority(flags2);
      parent.addChild(sprite);
      return sprite;
    });
    parent.sortChildren();
    // The later normal NPC stays in front of the earlier one. Both low/high
    // bits still select LOW, matching upstream's first priority test.
    expect(parent.children).toEqual([sprites[3], sprites[4], sprites[0], sprites[2], sprites[5], sprites[1]]);
    // Changing positions cannot introduce an unsupported Y-based depth order.
    sprites[0].y = 100;
    sprites[2].y = 0;
    parent.sortChildren();
    expect(parent.children.indexOf(sprites[0])).toBeLessThan(parent.children.indexOf(sprites[2]));
    parent.destroy({ children: true });
  });
});

describe("computeObjectPosition", () => {
  it("uses source BG_ALIGNED/BG_OFFSET offsets, including at doubled scale", () => {
    for (const spriteYOffset of [-8, -4, 0, 4]) {
      const entry = { xTiles: 1, yTiles: 4, xPixels: 16, yPixels: 64, spriteYOffset };
      const context = { atlasBlockPixelSize: 64, metadataBlockPixelSize: 32, cellsPerBlock: 2, eventCellPixelSize: 16 };
      expect(computeObjectPosition(entry, context)).toEqual({ x: 32, y: 128 + spriteYOffset * 2 });
    }
  });
  it("uses collision-cell units when tiles are provided", () => {
    const context: PlacementContext = {
      atlasBlockPixelSize: 32,
      metadataBlockPixelSize: 32,
      cellsPerBlock: 2,
      eventCellPixelSize: 16,
    };
    const position = computeObjectPosition(
      { xTiles: 3, yTiles: 2, xPixels: 0, yPixels: 0 },
      context,
    );
    expect(position.x).toBe(48);
    // With quarter-cell upward offset applied: 2 * 16 - 4 = 28
    expect(position.y).toBe(28);
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
      context,
    );
    expect(position.x).toBeCloseTo(160, 6);
    // No offset when using pixel fallback
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
      context,
    );
    expect(position.x).toBe(32);
    // atlasCellPixelSize = 32 here, so 1 * 32 - 8 = 24
    expect(position.y).toBe(24);
  });
});
