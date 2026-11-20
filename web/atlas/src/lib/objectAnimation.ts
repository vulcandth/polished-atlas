import type { ObjectEventEntry, ObjectMetadata } from "@/types";

/** Source SetFacing* actions using AlternateStepFrame's two 16-VBlank phases. */
const FRAME_MS = 1000 * 70224 / 4194304;
const FACINGS: Record<string, readonly [string, string]> = {
  SPRITEMOVEDATA_BIG_GYARADOS: ["FACING_BIG_GYARADOS_1", "FACING_BIG_GYARADOS_2"],
  SPRITEMOVEDATA_BIG_HO_OH: ["FACING_BIG_HO_OH_1", "FACING_BIG_HO_OH_2"],
  SPRITEMOVEDATA_BIG_LUGIA: ["FACING_BIG_LUGIA_1", "FACING_BIG_LUGIA_2"],
  SPRITEMOVEDATA_POKEMON: ["FACING_STEP_DOWN_0", "FACING_STEP_UP_0"],
  SPRITEMOVEDATA_RATTATA_BACK: ["FACING_STEP_DOWN_0", "FACING_STEP_UP_0"],
};

export function getStaticObjectAnimation(movement: string | null | undefined) {
  const facings = FACINGS[movement ?? ""];
  // Select by behavior, not graphics: Rattata's art is also used for static
  // arch decorations in SilverCaveRoom3.
  return facings ? { facings, frameDurationMs: 16 * FRAME_MS } : null;
}

export function resolveFacingConstant(entry: ObjectEventEntry, metadata: ObjectMetadata): string | null {
  const movementKey = entry.movement?.constant ?? "";
  const movement = movementKey ? metadata.movements[movementKey] : undefined;
  const movementAction = movement?.action ?? "";
  if (movementAction === "OBJECT_ACTION_MUSEUM_DRILL") {
    // SetFacingMuseumDrill indexes four consecutive facings by direction.
    const facings: Record<string, string> = {
      DOWN: "FACING_MUSEUM_DRILL_DOWN", UP: "FACING_MUSEUM_DRILL_UP",
      LEFT: "FACING_ARCH_TREE_LEFT", RIGHT: "FACING_ARCH_TREE_RIGHT",
    };
    const facing = facings[movement?.facing ?? ""];
    if (facing && metadata.facings[facing]) return facing;
  }
  const fixedActionFacing: Record<string, string> = {
    OBJECT_ACTION_BIG_HO_OH: "FACING_BIG_HO_OH_1",
    OBJECT_ACTION_BIG_LUGIA: "FACING_BIG_LUGIA_1",
    OBJECT_ACTION_ALOLAN_EXEGGUTOR: "FACING_ALOLAN_EXEGGUTOR_0",
  };
  const fixedFacing = fixedActionFacing[movementAction];
  if (fixedFacing && metadata.facings[fixedFacing]) return fixedFacing;
  if (movementAction === "OBJECT_ACTION_CUT_TREE" && metadata.facings["FACING_CUT_TREE"]) {
    return "FACING_CUT_TREE";
  }
  if (movementAction === "OBJECT_ACTION_FRUIT") {
    const facing = entry.extra?.["fruit_facing"];
    if (typeof facing === "string" && metadata.facings[facing]) return facing;
    const treeNameRaw = entry.extra?.["tree"];
    const treeName = typeof treeNameRaw === "string" ? treeNameRaw : "";
    if (treeName.includes("APRICORN") && metadata.facings["FACING_APRICORN"]) {
      return "FACING_APRICORN";
    }
    if (metadata.facings["FACING_BERRY"]) {
      return "FACING_BERRY";
    }
    if (metadata.facings["FACING_PICKED_FRUIT"]) {
      return "FACING_PICKED_FRUIT";
    }
  }
  if (movementAction === "OBJECT_ACTION_BIG_GYARADOS") {
    if (metadata.facings["FACING_BIG_GYARADOS_2"]) {
      return "FACING_BIG_GYARADOS_2";
    }
    if (metadata.facings["FACING_BIG_GYARADOS_1"]) {
      return "FACING_BIG_GYARADOS_1";
    }
  }
  if (movementAction === "OBJECT_ACTION_BIG_SNORLAX" && metadata.facings["FACING_BIG_DOLL_SYM"]) {
    return "FACING_BIG_DOLL_SYM";
  }
  if (movementAction === "OBJECT_ACTION_SAILBOAT_TOP" && metadata.facings["FACING_SAILBOAT_TOP"]) {
    return "FACING_SAILBOAT_TOP";
  }
  if (
    movementAction === "OBJECT_ACTION_SAILBOAT_BOTTOM" &&
    metadata.facings["FACING_SAILBOAT_BOTTOM"]
  ) {
    return "FACING_SAILBOAT_BOTTOM";
  }
  // Standing flip variants: choose flip facings instead of default.
  if (movementAction === "OBJECT_ACTION_STAND_FLIP") {
    const face = (movement?.facing ?? "").toUpperCase();
    if (face === "DOWN" && metadata.facings["FACING_STEP_DOWN_FLIP"]) {
      return "FACING_STEP_DOWN_FLIP";
    }
    if (face === "UP" && metadata.facings["FACING_STEP_UP_FLIP"]) {
      return "FACING_STEP_UP_FLIP";
    }
  }
  // Tiny windows use a custom facing series FACING_TINY_WINDOWS_0..6 and the variant
  // is selected by the object's X range field in map data (args[5] in object_event).
  // Examples: SnowtopMountainOutside places SPRITE_SAILBOAT with SPRITEMOVEDATA_TINY_WINDOWS
  // using range.x values 0, 1, 3. Clamp to the defined [0..6] constants and fall back to 0.
  if (movementAction === "OBJECT_ACTION_TINY_WINDOWS") {
    const raw = entry.range?.x;
    const variant = Number.isFinite(raw as number)
      ? Math.max(0, Math.min(6, Math.trunc(raw as number)))
      : 0;
    const key = `FACING_TINY_WINDOWS_${variant}` as const;
    if (metadata.facings[key]) {
      return key;
    }
    if (metadata.facings["FACING_TINY_WINDOWS_0"]) {
      return "FACING_TINY_WINDOWS_0";
    }
  }
  const facingValue = movement?.facing ?? "";
  if (facingValue) {
    if (metadata.facings[facingValue]) {
      return facingValue;
    }
    const normalized = facingValue.toUpperCase();
    const mapped =
      metadata.defaultFacingForDirection[facingValue] ??
      metadata.defaultFacingForDirection[normalized] ??
      metadata.defaultFacingForDirection[normalized.toLowerCase()];
    if (mapped && metadata.facings[mapped]) {
      return mapped;
    }
  }
  const fallback =
    metadata.defaultFacingForDirection.DOWN ??
    metadata.defaultFacingForDirection.Down ??
    metadata.defaultFacingForDirection.down ??
    "FACING_STEP_DOWN_0";
  if (fallback && metadata.facings[fallback]) {
    return fallback;
  }
  const firstKey = Object.keys(metadata.facings)[0];
  return firstKey ?? null;
}
