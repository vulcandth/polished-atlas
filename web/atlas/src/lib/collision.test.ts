import { describe, expect, it } from "vitest";
import { canCrossSideWall, createCollisionHelper } from "./collision";

describe("movement along glowing side walls", () => {
  it.each([[0xb8, 1], [0xb9, -1], [0xb0, 1], [0xb1, -1]])(
    "preserves the blocked edge of collision %i on entry and exit", (tile, side) => {
      const cells = new Uint8Array(9);
      cells[4] = tile;
      const helper = createCollisionHelper({
        encoding: "base64", cells: "", cellBytes: cells, widthCells: 3, heightCells: 3,
        tilesetConstant: null, tilesetLabel: null, tilesetIndex: null,
      }, []);
      expect(canCrossSideWall(helper, 1, 1, side, 0)).toBe(false);
      expect(canCrossSideWall(helper, 1 + side, 1, -side, 0)).toBe(false);
      expect(canCrossSideWall(helper, 1, 1, -side, 0)).toBe(true);
      expect(canCrossSideWall(helper, 1, 1, 0, 1)).toBe(true);
      expect(canCrossSideWall(helper, 1, 0, 0, 1)).toBe(true);
    },
  );
});
