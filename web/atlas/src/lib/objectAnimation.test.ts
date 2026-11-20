import { describe, expect, it } from "vitest";
import { convertObjectMetadata } from "@/hooks/useObjectMetadata";
import { getStaticObjectAnimation, resolveFacingConstant } from "./objectAnimation";
import { getMovementModel } from "./movementModel";
import { makeTrackClock } from "./tileAnimation";

describe("stationary object animations", () => {
  it.each([
    ["DOWN", "FACING_MUSEUM_DRILL_DOWN"], ["UP", "FACING_MUSEUM_DRILL_UP"],
    ["LEFT", "FACING_ARCH_TREE_LEFT"], ["RIGHT", "FACING_ARCH_TREE_RIGHT"],
  ])("uses the fixed museum or arch tiles when facing %s", (direction, expected) => {
    const metadata = convertObjectMetadata({
      movements: { FIXED: { action: "OBJECT_ACTION_MUSEUM_DRILL", facing: direction } },
      facings: { [expected]: {}, WALKING: {} },
      default_facing_for_direction: { [direction]: "WALKING" },
      maps: { Map: { objects: [{ movement: { constant: "FIXED" } }] } },
    });
    expect(resolveFacingConstant(metadata.maps.Map.objects[0], metadata)).toBe(expected);
  });

  it.each(["SPRITEMOVEDATA_RATTATA_BACK", "SPRITEMOVEDATA_POKEMON"])(
    "selects the source poses for %s at 16-VBlank boundaries", (movement) => {
    const animation = getStaticObjectAnimation(movement)!;
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
