import type { MovementModel } from "@/types";

/**
 * Maps polishedcrystal sprite movement constants to simplified behaviour models
 * that are easier to reason about in the atlas UI.
 */
const DEFAULT_MOVEMENT_MODEL: MovementModel = { category: "special" };

export const MOVEMENT_MODEL_BY_CONSTANT = {
  SPRITEMOVEDATA_00: {
    category: "special",
    note: "Unused placeholder entry.",
  },
  SPRITEMOVEDATA_STILL: {
    category: "static",
  },
  SPRITEMOVEDATA_WANDER: {
    category: "random-walk",
    axes: "xy",
    medium: "land",
    speed: "normal",
  },
  SPRITEMOVEDATA_SPINRANDOM_SLOW: {
    category: "spin",
    spinDirection: "random",
    speed: "slow",
  },
  SPRITEMOVEDATA_WALK_UP_DOWN: {
    category: "axis-walk",
    axes: "y",
    medium: "land",
  },
  SPRITEMOVEDATA_WALK_LEFT_RIGHT: {
    category: "axis-walk",
    axes: "x",
    medium: "land",
  },
  SPRITEMOVEDATA_STANDING_DOWN: {
    category: "static",
    facing: "down",
  },
  SPRITEMOVEDATA_STANDING_UP: {
    category: "static",
    facing: "up",
  },
  SPRITEMOVEDATA_STANDING_LEFT: {
    category: "static",
    facing: "left",
  },
  SPRITEMOVEDATA_STANDING_RIGHT: {
    category: "static",
    facing: "right",
  },
  SPRITEMOVEDATA_SPINRANDOM_FAST: {
    category: "spin",
    spinDirection: "random",
    speed: "fast",
  },
  SPRITEMOVEDATA_PLAYER: {
    category: "player",
    note: "Player-controlled movement.",
  },
  SPRITEMOVEDATA_CUTTABLE_TREE: {
    category: "object",
    note: "Static interactable tree.",
  },
  SPRITEMOVEDATA_FOLLOWING: {
    category: "follow",
    followExact: true,
  },
  SPRITEMOVEDATA_SCRIPTED: {
    category: "scripted",
  },
  SPRITEMOVEDATA_SNORLAX: {
    category: "object",
  },
  SPRITEMOVEDATA_POKEMON: {
    category: "object",
  },
  SPRITEMOVEDATA_SUDOWOODO: {
    category: "object",
  },
  SPRITEMOVEDATA_SMASHABLE_ROCK: {
    category: "object",
  },
  SPRITEMOVEDATA_STRENGTH_BOULDER: {
    category: "object",
  },
  SPRITEMOVEDATA_FOLLOWNOTEXACT: {
    category: "follow",
    followExact: false,
  },
  SPRITEMOVEDATA_SHADOW: {
    category: "effect",
  },
  SPRITEMOVEDATA_EMOTE: {
    category: "effect",
  },
  SPRITEMOVEDATA_SCREENSHAKE: {
    category: "effect",
  },
  SPRITEMOVEDATA_SPINCOUNTERCLOCKWISE: {
    category: "spin",
    spinDirection: "counterclockwise",
    speed: "normal",
  },
  SPRITEMOVEDATA_SPINCLOCKWISE: {
    category: "spin",
    spinDirection: "clockwise",
    speed: "normal",
  },
  SPRITEMOVEDATA_BIGDOLL: {
    category: "object",
  },
  SPRITEMOVEDATA_BOULDERDUST: {
    category: "effect",
  },
  SPRITEMOVEDATA_GRASS: {
    category: "effect",
  },
  SPRITEMOVEDATA_PUDDLE: {
    category: "effect",
  },
  SPRITEMOVEDATA_SWIM_AROUND: {
    category: "random-walk",
    axes: "xy",
    medium: "water",
    speed: "normal",
  },
  SPRITEMOVEDATA_SWIM_UP_DOWN: {
    category: "axis-walk",
    axes: "y",
    medium: "water",
  },
  SPRITEMOVEDATA_SWIM_LEFT_RIGHT: {
    category: "axis-walk",
    axes: "x",
    medium: "water",
  },
  SPRITEMOVEDATA_FRUIT: {
    category: "object",
  },
  SPRITEMOVEDATA_BIG_GYARADOS: {
    category: "object",
  },
  SPRITEMOVEDATA_STANDING_DOWN_FLIP: {
    category: "static",
    facing: "down",
  },
  SPRITEMOVEDATA_STANDING_UP_FLIP: {
    category: "static",
    facing: "up",
  },
  SPRITEMOVEDATA_POKECOM_NEWS: {
    category: "effect",
  },
  SPRITEMOVEDATA_MUSEUM_DRILL_DOWN: {
    category: "effect",
  },
  SPRITEMOVEDATA_MUSEUM_DRILL_UP: {
    category: "effect",
  },
  SPRITEMOVEDATA_ARCH_TREE_LEFT: {
    category: "object",
  },
  SPRITEMOVEDATA_ARCH_TREE_RIGHT: {
    category: "object",
  },
  SPRITEMOVEDATA_SAILBOAT_TOP: {
    category: "object",
  },
  SPRITEMOVEDATA_SAILBOAT_BOTTOM: {
    category: "object",
  },
  SPRITEMOVEDATA_ALOLAN_EXEGGUTOR: {
    category: "object",
  },
  SPRITEMOVEDATA_TINY_WINDOWS: {
    category: "effect",
  },
  SPRITEMOVEDATA_PLACEHOLDER_UP: {
    category: "static",
    facing: "up",
    note: "Placeholder standing pose.",
  },
  SPRITEMOVEDATA_MICROPHONE: {
    category: "effect",
  },
} as const satisfies Record<string, MovementModel>;

const MOVEMENT_MODEL_LOOKUP: Record<string, MovementModel> = MOVEMENT_MODEL_BY_CONSTANT;

export function getMovementModel(
  movementConstant: string | null | undefined,
): MovementModel {
  if (!movementConstant) {
    return DEFAULT_MOVEMENT_MODEL;
  }
  return MOVEMENT_MODEL_LOOKUP[movementConstant] ?? DEFAULT_MOVEMENT_MODEL;
}
