import type { ObjectEventEntry, MovementSummary } from "@/types";
import type {
  CardinalDirection,
  Offset,
  MovementSegment,
  PathMovementAnimator,
  SpinStep,
  SpinMovementAnimator,
  IdleMovementAnimator,
  MovementAnimator,
  MovementFrameSet,
} from "@/components/MapCanvas/MapCanvas.types";
import {
  FRAME_DURATION_MS,
  MOVEMENT_SPEED_SCALE,
  STEP_FRAMES_BY_SPEED,
  IDLE_FRAMES_BY_SPEED,
  SPIN_INTERVAL_BY_SPEED,
  CLOCKWISE_SEQUENCE,
  COUNTERCLOCKWISE_SEQUENCE,
  DIRECTION_DELTAS,
} from "@/components/MapCanvas/constants";
import {
  createSeededRandom,
  deltaToDirection,
  oppositeDirection,
} from "./animation-frames";

/**
 * Convert movement speed to step duration in milliseconds.
 */
export function movementSpeedToStepDuration(
  speed: MovementSummary["model"]["speed"] | undefined,
): number {
  const frames = speed ? STEP_FRAMES_BY_SPEED[speed] : undefined;
  const frameCount = Number.isFinite(frames) ? (frames as number) : STEP_FRAMES_BY_SPEED.normal;
  return frameCount * FRAME_DURATION_MS * MOVEMENT_SPEED_SCALE;
}

/**
 * Convert movement speed to idle duration in milliseconds.
 */
export function movementSpeedToIdleDuration(
  speed: MovementSummary["model"]["speed"] | undefined,
): number {
  const frames = speed ? IDLE_FRAMES_BY_SPEED[speed] : undefined;
  const frameCount = Number.isFinite(frames) ? (frames as number) : IDLE_FRAMES_BY_SPEED.normal;
  return frameCount * FRAME_DURATION_MS * MOVEMENT_SPEED_SCALE;
}

/**
 * Convert movement speed to spin interval in milliseconds.
 */
export function movementSpeedToSpinInterval(
  speed: MovementSummary["model"]["speed"] | undefined,
): number {
  const interval = speed ? SPIN_INTERVAL_BY_SPEED[speed] : undefined;
  const base = Number.isFinite(interval) ? (interval as number) : SPIN_INTERVAL_BY_SPEED.normal;
  return base * MOVEMENT_SPEED_SCALE;
}

/**
 * Create an axis-based path animator for NPCs that walk along a single axis.
 */
export function createAxisPathAnimator(
  summary: MovementSummary,
  objectEntry: ObjectEventEntry,
  frameSet: MovementFrameSet | null,
): PathMovementAnimator | null {
  if (!summary.path || summary.path.length === 0) {
    return null;
  }
  const start = summary.startCell;
  const path = summary.path;
  const recordedSteps = summary.steps ?? [];
  const startIndex = path.findIndex((cell) => cell.x === start.x && cell.y === start.y);
  if (startIndex === -1) {
    return null;
  }
  const positiveOffsets = path
    .slice(startIndex + 1)
    .map((cell) => ({ dx: cell.x - start.x, dy: cell.y - start.y }));
  const negativeOffsets = path
    .slice(0, startIndex)
    .map((cell) => ({ dx: cell.x - start.x, dy: cell.y - start.y }))
    .reverse();

  if (positiveOffsets.length === 0 && negativeOffsets.length === 0) {
    return null;
  }

  const moveDuration = Math.max(90, movementSpeedToStepDuration(summary.model.speed));
  const idleDuration = Math.max(120, movementSpeedToIdleDuration(summary.model.speed) * 0.6);

  const segments: MovementSegment[] = [];
  let current: Offset = { dx: 0, dy: 0 };
  let currentDirection: CardinalDirection =
    frameSet?.defaultDirection ?? (summary.axis === "x" ? "right" : "down");
  let lastStepIndex: number = recordedSteps.length > 0 ? recordedSteps[0].index : 0;
  let nextStepCursor = 0;
  let moveSegmentCount = 0;

  const rngSeedBase =
    ((objectEntry.index ?? 0) * 1103515245 + start.x * 1237 + start.y * 1999) >>> 0;
  const rng = createSeededRandom(rngSeedBase);
  const earlyTurnChance = 0.35;
  const earlyTurnFloor = 0.5;

  const claimStepIndex = (target: Offset, direction: CardinalDirection): number => {
    if (recordedSteps.length === 0) {
      const index = nextStepCursor;
      nextStepCursor += 1;
      return index;
    }
    const targetX = start.x + target.dx;
    const targetY = start.y + target.dy;
    for (let cursor = nextStepCursor; cursor < recordedSteps.length; cursor += 1) {
      const step = recordedSteps[cursor];
      if (step.to.x === targetX && step.to.y === targetY && step.direction === direction) {
        nextStepCursor = cursor + 1;
        return step.index;
      }
    }
    const fallbackStep =
      recordedSteps[Math.min(recordedSteps.length - 1, nextStepCursor)] ??
      recordedSteps[recordedSteps.length - 1];
    nextStepCursor = Math.min(recordedSteps.length, nextStepCursor + 1);
    return fallbackStep ? fallbackStep.index : recordedSteps.length;
  };

  const pushMove = (target: Offset): void => {
    if (target.dx === current.dx && target.dy === current.dy) {
      return;
    }
    const direction = deltaToDirection(target.dx - current.dx, target.dy - current.dy);
    if (!direction) {
      return;
    }
    const stepIndex = claimStepIndex(target, direction);
    segments.push({
      type: "move",
      from: { ...current },
      to: { ...target },
      direction,
      durationMs: moveDuration,
      stepIndex,
    });
    current = { ...target };
    currentDirection = direction;
    lastStepIndex = stepIndex;
    moveSegmentCount += 1;
  };

  const pushIdle = (duration: number): void => {
    if (!(duration > 0)) {
      return;
    }
    segments.push({
      type: "wait",
      position: { ...current },
      direction: currentDirection,
      durationMs: duration,
      stepIndex: lastStepIndex,
    });
  };

  const planSequences = (offsets: Offset[]): Offset[][] => {
    if (offsets.length === 0) {
      return [];
    }
    const passes = offsets.length > 1 ? 2 : 1;
    const sequences: Offset[][] = [];
    for (let pass = 0; pass < passes; pass += 1) {
      let length = offsets.length;
      if (pass > 0 && offsets.length > 1 && rng() < earlyTurnChance) {
        const minSteps = Math.max(1, Math.floor(offsets.length * earlyTurnFloor));
        const maxSteps = Math.max(minSteps, offsets.length - 1);
        if (maxSteps > minSteps) {
          const span = maxSteps - minSteps + 1;
          length = minSteps + Math.floor(rng() * span);
        } else {
          length = minSteps;
        }
      }
      length = Math.max(1, Math.min(offsets.length, length));
      sequences.push(offsets.slice(0, length));
    }
    return sequences;
  };

  const runSequence = (offsets: Offset[]): void => {
    if (!offsets.length) {
      pushIdle(idleDuration);
      return;
    }
    for (const offset of offsets) {
      pushMove(offset);
      pushIdle(idleDuration);
    }
    for (let index = offsets.length - 2; index >= 0; index -= 1) {
      const offset = offsets[index];
      if (!offset) {
        continue;
      }
      pushMove(offset);
      pushIdle(idleDuration);
    }
    pushMove({ dx: 0, dy: 0 });
    pushIdle(idleDuration);
  };

  const positiveSequences = planSequences(positiveOffsets);
  const negativeSequences = planSequences(negativeOffsets);
  const totalSequences = Math.max(positiveSequences.length, negativeSequences.length);

  if (totalSequences === 0) {
    return null;
  }

  for (let pass = 0; pass < totalSequences; pass += 1) {
    const forward = positiveSequences[pass];
    if (forward) {
      runSequence(forward);
    }
    const backward = negativeSequences[pass];
    if (backward) {
      runSequence(backward);
    }
  }

  if (!segments.length) {
    return null;
  }
  const totalDuration = segments.reduce(
    (total, segment) => total + Math.max(0, segment.durationMs),
    0,
  );
  if (!(totalDuration > 0)) {
    return null;
  }
  const stepCount = recordedSteps.length > 0 ? recordedSteps.length : moveSegmentCount;

  return {
    kind: "path",
    segments,
    totalDurationMs: totalDuration,
    stepCount,
  };
}

/**
 * Create a wander animator for NPCs that wander randomly within bounds.
 */
export function createWanderAnimator(
  summary: MovementSummary,
  objectEntry: ObjectEventEntry,
  frameSet: MovementFrameSet | null,
): PathMovementAnimator | null {
  const bounds = summary.bounds ?? {
    left: summary.startCell.x,
    right: summary.startCell.x,
    top: summary.startCell.y,
    bottom: summary.startCell.y,
  };
  const reachableCells = summary.reachable ?? null;
  const reachableSet = reachableCells
    ? new Set(reachableCells.map((cell) => `${cell.x},${cell.y}`))
    : null;

  const seedBase =
    (objectEntry.index ?? 0) * 1103515245 + summary.startCell.x * 1237 + summary.startCell.y * 1999;
  const rng = createSeededRandom(seedBase >>> 0);
  const moveDuration = Math.max(90, movementSpeedToStepDuration(summary.model.speed));
  const idleBase = Math.max(120, movementSpeedToIdleDuration(summary.model.speed));
  const directionPool: CardinalDirection[] = ["down", "up", "left", "right"];

  let current: Offset = { dx: 0, dy: 0 };
  let currentDirection: CardinalDirection = frameSet?.defaultDirection ?? "down";
  let lastStepIndex = 0;
  let nextStepIndex = 0;
  let moveSegmentCount = 0;

  const maxExtentX = bounds.right - bounds.left;
  const maxExtentY = bounds.bottom - bounds.top;
  const halfLength = Math.max(3, Math.min(12, maxExtentX + maxExtentY + 4));

  const forwardDirections: CardinalDirection[] = [];

  for (let step = 0; step < halfLength; step += 1) {
    const candidates: CardinalDirection[] = [];
    for (const direction of directionPool) {
      const delta = DIRECTION_DELTAS[direction];
      const next = { dx: current.dx + delta.dx, dy: current.dy + delta.dy };
      const absX = summary.startCell.x + next.dx;
      const absY = summary.startCell.y + next.dy;
      if (absX < bounds.left || absX > bounds.right || absY < bounds.top || absY > bounds.bottom) {
        continue;
      }
      if (reachableSet && !reachableSet.has(`${absX},${absY}`)) {
        continue;
      }
      candidates.push(direction);
    }
    if (!candidates.length) {
      break;
    }
    const choice = candidates[Math.floor(rng() * candidates.length)];
    forwardDirections.push(choice);
    const delta = DIRECTION_DELTAS[choice];
    current = { dx: current.dx + delta.dx, dy: current.dy + delta.dy };
  }

  if (!forwardDirections.length) {
    return null;
  }

  const directions: CardinalDirection[] = [...forwardDirections];
  for (let index = forwardDirections.length - 1; index >= 0; index -= 1) {
    directions.push(oppositeDirection(forwardDirections[index]));
  }

  current = { dx: 0, dy: 0 };
  const segments: MovementSegment[] = [];
  for (const direction of directions) {
    const delta = DIRECTION_DELTAS[direction];
    const target = { dx: current.dx + delta.dx, dy: current.dy + delta.dy };
    const stepIndex = nextStepIndex;
    nextStepIndex += 1;
    segments.push({
      type: "move",
      from: { ...current },
      to: target,
      direction,
      durationMs: moveDuration,
      stepIndex,
    });
    current = target;
    currentDirection = direction;
    lastStepIndex = stepIndex;
    moveSegmentCount += 1;
    const idleDuration = idleBase * (0.6 + rng() * 0.6);
    segments.push({
      type: "wait",
      position: { ...current },
      direction: currentDirection,
      durationMs: idleDuration,
      stepIndex: lastStepIndex,
    });
  }

  if (current.dx !== 0 || current.dy !== 0) {
    while (current.dx !== 0) {
      const direction = current.dx > 0 ? "left" : "right";
      const delta = DIRECTION_DELTAS[direction];
      const target = { dx: current.dx + delta.dx, dy: current.dy + delta.dy };
      const stepIndex = nextStepIndex;
      nextStepIndex += 1;
      segments.push({
        type: "move",
        from: { ...current },
        to: target,
        direction,
        durationMs: moveDuration,
        stepIndex,
      });
      current = target;
      currentDirection = direction;
      lastStepIndex = stepIndex;
      moveSegmentCount += 1;
    }
    while (current.dy !== 0) {
      const direction = current.dy > 0 ? "up" : "down";
      const delta = DIRECTION_DELTAS[direction];
      const target = { dx: current.dx + delta.dx, dy: current.dy + delta.dy };
      const stepIndex = nextStepIndex;
      nextStepIndex += 1;
      segments.push({
        type: "move",
        from: { ...current },
        to: target,
        direction,
        durationMs: moveDuration,
        stepIndex,
      });
      current = target;
      currentDirection = direction;
      lastStepIndex = stepIndex;
      moveSegmentCount += 1;
    }
    segments.push({
      type: "wait",
      position: { ...current },
      direction: currentDirection,
      durationMs: idleBase,
      stepIndex: moveSegmentCount > 0 ? lastStepIndex : 0,
    });
  }

  const totalDuration = segments.reduce(
    (total, segment) => total + Math.max(0, segment.durationMs),
    0,
  );
  if (!(totalDuration > 0)) {
    return null;
  }
  const stepCount = moveSegmentCount;
  if (stepCount === 0) {
    return null;
  }

  return {
    kind: "path",
    segments,
    totalDurationMs: totalDuration,
    stepCount,
  };
}

/**
 * Create a spin animator for NPCs that rotate in place.
 */
export function createSpinAnimator(
  summary: MovementSummary,
  objectEntry: ObjectEventEntry,
  frameSet: MovementFrameSet | null,
): SpinMovementAnimator | null {
  const directionMode = summary.model.spinDirection ?? "random";
  const interval = Math.max(180, movementSpeedToSpinInterval(summary.model.speed));
  const steps: SpinStep[] = [];

  if (directionMode === "clockwise" || directionMode === "counterclockwise") {
    const sequence = directionMode === "clockwise" ? CLOCKWISE_SEQUENCE : COUNTERCLOCKWISE_SEQUENCE;
    const startDirection = frameSet?.defaultDirection ?? sequence[0];
    const startIndex = sequence.indexOf(startDirection);
    const normalizedStart = startIndex >= 0 ? startIndex : 0;
    for (let index = 0; index < sequence.length; index += 1) {
      const direction = sequence[(normalizedStart + index) % sequence.length];
      steps.push({ direction, durationMs: interval });
    }
  } else {
    const available = frameSet?.availableDirections?.length
      ? frameSet.availableDirections
      : (["down", "up", "left", "right"] as CardinalDirection[]);
    const rngSeed =
      (objectEntry.index ?? 0) * 214013 +
      summary.startCell.x * 2531011 +
      summary.startCell.y * 1376312589;
    const rng = createSeededRandom(rngSeed >>> 0);
    const stepCount = 6;
    for (let index = 0; index < stepCount; index += 1) {
      const direction = available[Math.floor(rng() * available.length)] ?? "down";
      const duration = interval * (0.6 + rng() * 0.8);
      steps.push({ direction, durationMs: duration });
    }
  }

  const totalDuration = steps.reduce((total, step) => total + Math.max(0, step.durationMs), 0);
  if (!(totalDuration > 0)) {
    return null;
  }

  return {
    kind: "spin",
    steps,
    totalDurationMs: totalDuration,
  };
}

/**
 * Create an idle animator for NPCs that animate in place (e.g., big Gyarados).
 */
export function createIdleAnimator(
  summary: MovementSummary,
  objectEntry: ObjectEventEntry,
  frameSet: MovementFrameSet | null,
): IdleMovementAnimator | null {
  if (!frameSet) {
    return null;
  }
  const primaryDirection = frameSet.defaultDirection ?? frameSet.availableDirections[0] ?? null;
  if (!primaryDirection) {
    return null;
  }
  const frames = frameSet.framesByDirection[primaryDirection];
  if (!frames || frames.length <= 1) {
    return null;
  }
  const frameDuration = Math.max(260, movementSpeedToIdleDuration(summary.model.speed));
  const seed =
    ((objectEntry.index ?? 0) * 2147483647 +
      summary.startCell.x * 2654435761 +
      summary.startCell.y * 40503) >>>
    0;
  const rng = createSeededRandom(seed);
  const phaseOffsetMs = Math.floor(rng() * frameDuration * frames.length);
  return {
    kind: "idle",
    direction: primaryDirection,
    frameCount: frames.length,
    frameDurationMs: frameDuration,
    phaseOffsetMs,
  };
}

/**
 * Create an idle animator specifically for Pokémon icon sprites.
 */
export function createPokemonIconAnimator(
  objectEntry: ObjectEventEntry,
  frameSet: MovementFrameSet | null,
  frameDurationMs: number,
): IdleMovementAnimator | null {
  if (!frameSet || !frameSet.defaultDirection) {
    return null;
  }
  const direction = frameSet.defaultDirection;
  const frames = frameSet.framesByDirection[direction];
  if (!frames || frames.length <= 1) {
    return null;
  }
  const duration = Math.max(60, Math.round(frameDurationMs));
  const seed = ((objectEntry.index ?? 0) * 1103515245 + duration * 1664525) >>> 0;
  const rng = createSeededRandom(seed);
  const phaseOffsetMs = Math.floor(rng() * duration * frames.length);
  return {
    kind: "idle",
    direction,
    frameCount: frames.length,
    frameDurationMs: duration,
    phaseOffsetMs,
  };
}

/**
 * Create the appropriate movement animator based on movement summary category.
 */
export function createMovementAnimator(
  summary: MovementSummary | null,
  objectEntry: ObjectEventEntry,
  frameSet: MovementFrameSet | null,
): MovementAnimator | null {
  if (!summary) {
    return null;
  }
  if (summary.model.category === "axis-walk") {
    return createAxisPathAnimator(summary, objectEntry, frameSet);
  }
  if (summary.model.category === "random-walk") {
    return createWanderAnimator(summary, objectEntry, frameSet);
  }
  if (summary.model.category === "spin") {
    return createSpinAnimator(summary, objectEntry, frameSet);
  }
  if (
    summary.model.category === "object" &&
    objectEntry.movement?.constant === "SPRITEMOVEDATA_BIG_GYARADOS"
  ) {
    const idleAnimator = createIdleAnimator(summary, objectEntry, frameSet);
    if (idleAnimator) {
      return idleAnimator;
    }
  }
  return null;
}
