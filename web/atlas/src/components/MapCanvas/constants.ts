import type { CardinalDirection, Offset } from "./MapCanvas.types";

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 4;

export const FRAME_DURATION_MS = 1000 / 60;
export const POKEMON_ICON_FRAME_DURATION_SCALE = 2;
export const MIN_POKEMON_ICON_FRAME_DURATION_MS = 120;
export const MOVEMENT_SPEED_SCALE = 2;

export const STEP_FRAMES_BY_SPEED: Record<string, number> = {
  slow: 32,
  normal: 16,
  fast: 8,
};

export const IDLE_FRAMES_BY_SPEED: Record<string, number> = {
  slow: 48,
  normal: 32,
  fast: 20,
};

export const SPIN_INTERVAL_BY_SPEED: Record<string, number> = {
  slow: 700,
  normal: 540,
  fast: 360,
};

export const STEP_FACING_KEYS: Record<CardinalDirection, string[]> = {
  down: ["FACING_STEP_DOWN_0", "FACING_STEP_DOWN_1", "FACING_STEP_DOWN_2", "FACING_STEP_DOWN_3"],
  up: ["FACING_STEP_UP_0", "FACING_STEP_UP_1", "FACING_STEP_UP_2", "FACING_STEP_UP_3"],
  left: ["FACING_STEP_LEFT_0", "FACING_STEP_LEFT_1", "FACING_STEP_LEFT_2", "FACING_STEP_LEFT_3"],
  right: [
    "FACING_STEP_RIGHT_0",
    "FACING_STEP_RIGHT_1",
    "FACING_STEP_RIGHT_2",
    "FACING_STEP_RIGHT_3",
  ],
};

export const CLOCKWISE_SEQUENCE: CardinalDirection[] = ["right", "down", "left", "up"];
export const COUNTERCLOCKWISE_SEQUENCE: CardinalDirection[] = ["right", "up", "left", "down"];

export const DIRECTION_DELTAS: Record<CardinalDirection, Offset> = {
  down: { dx: 0, dy: 1 },
  up: { dx: 0, dy: -1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};
