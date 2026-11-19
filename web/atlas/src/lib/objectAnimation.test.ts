import { describe, expect, it } from "vitest";
import { getStaticObjectAnimation } from "./objectAnimation";
import { getMovementModel } from "./movementModel";
import { makeTrackClock } from "./tileAnimation";

describe("stationary object animations", () => {
  it("selects Rattata's source poses at 16-VBlank boundaries", () => {
    const animation = getStaticObjectAnimation("SPRITEMOVEDATA_RATTATA_BACK")!;
    const clock = makeTrackClock([0, 1], [1, 1], animation.frameDurationMs);
    const vblankMs = 1000 * 70224 / 4194304;
    expect(getMovementModel("SPRITEMOVEDATA_RATTATA_BACK").category).toBe("object");
    for (let tick = 0; tick < 1024; tick++) {
      const facing = animation.facings[clock(tick * vblankMs)];
      expect(facing).toBe(tick % 32 < 16 ? "FACING_STEP_DOWN_0" : "FACING_STEP_UP_0");
    }
    expect(clock(16 * vblankMs - 0.01)).toBe(0);
    expect(clock(32 * vblankMs)).toBe(0);
  });

  it("does not animate reused graphics in arch decorations or standing objects", () => {
    for (const movement of ["SPRITEMOVEDATA_ARCH_TREE_LEFT", "SPRITEMOVEDATA_ARCH_TREE_RIGHT",
      "SPRITEMOVEDATA_POKECOM_NEWS", "SPRITEMOVEDATA_STILL", "SPRITEMOVEDATA_STANDING_DOWN", null]) {
      expect(getStaticObjectAnimation(movement)).toBeNull();
    }
    expect(getStaticObjectAnimation("SPRITEMOVEDATA_BIG_HO_OH")?.facings)
      .toEqual(["FACING_BIG_HO_OH_1", "FACING_BIG_HO_OH_2"]);
    expect(getStaticObjectAnimation("SPRITEMOVEDATA_BIG_LUGIA")?.facings)
      .toEqual(["FACING_BIG_LUGIA_1", "FACING_BIG_LUGIA_2"]);
  });
});
