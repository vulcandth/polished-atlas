import type {
  CardinalDirection,
  SpriteFrameRef,
  ObjectMarkerEntry,
} from "@/components/MapCanvas/MapCanvas.types";

/**
 * Apply a sprite frame to a marker, updating texture and offset.
 */
export function applySpriteFrame(
  marker: ObjectMarkerEntry,
  direction: CardinalDirection | null,
  frameIndex: number,
): void {
  const frameSet = marker.frameSet;
  if (!frameSet) {
    if (direction) {
      marker.lastDirection = direction;
    }
    return;
  }
  let frames =
    direction && frameSet.framesByDirection[direction]?.length
      ? frameSet.framesByDirection[direction]
      : undefined;
  let resolvedDirection = direction;
  if ((!frames || frames.length === 0) && frameSet.defaultDirection) {
    const fallback = frameSet.framesByDirection[frameSet.defaultDirection];
    if (fallback && fallback.length) {
      frames = fallback;
      resolvedDirection = frameSet.defaultDirection;
    }
  }
  if ((!frames || frames.length === 0) && frameSet.availableDirections.length > 0) {
    const fallbackDirection = frameSet.availableDirections[0];
    const fallback = frameSet.framesByDirection[fallbackDirection];
    if (fallback && fallback.length) {
      frames = fallback;
      resolvedDirection = fallbackDirection;
    }
  }
  let frame: SpriteFrameRef | null = null;
  if (frames && frames.length > 0) {
    const normalizedIndex = Math.max(0, Math.floor(frameIndex)) % frames.length;
    frame = frames[normalizedIndex];
  }
  if (!frame) {
    frame = frameSet.defaultFrame;
  }
  if (marker.currentFrameKey !== frame.key) {
    marker.sprite.texture = frame.texture;
    const spriteName = marker.object.sprite.constant;
    if (
      import.meta.env?.DEV &&
      spriteName &&
      (spriteName === "SPRITE_SAILBOAT" ||
        spriteName === "SPRITE_BIG_GYARADOS" ||
        spriteName === "SPRITE_BIG_SNORLAX")
    ) {
      const tex = frame.texture;
      console.info(
        `[SpriteCache] ${spriteName} frame ${frame.key} resolved ${tex.width}x${tex.height} (offset=${frame.offsetX},${frame.offsetY})`,
      );
    }
    marker.currentFrameKey = frame.key;
  }
  marker.spriteOffset.x = frame.offsetX * marker.spriteScale;
  marker.spriteOffset.y = frame.offsetY * marker.spriteScale;
  if (resolvedDirection) {
    marker.lastDirection = resolvedDirection;
  }
}

/**
 * Update a marker's animation state and position based on elapsed time.
 */
export function updateMarkerAnimation(marker: ObjectMarkerEntry, elapsedMs: number): void {
  const baseX = marker.basePosition.x;
  const baseY = marker.basePosition.y;
  const cellSize = marker.cellPixelSize;
  const animator = marker.animator;

  if (!animator) {
    applySpriteFrame(marker, marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null, 0);
    marker.sprite.x = baseX + marker.spriteOffset.x;
    marker.sprite.y = baseY + marker.spriteOffset.y;
    marker.stepCount = null;
    marker.currentStepIndex = null;
    marker.stepProgress = 0;
    return;
  }

  if (animator.kind === "path") {
    const total = animator.totalDurationMs;
    marker.stepCount = animator.stepCount;
    if (!(total > 0) || animator.segments.length === 0) {
      applySpriteFrame(
        marker,
        marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null,
        0,
      );
      marker.sprite.x = baseX + marker.spriteOffset.x;
      marker.sprite.y = baseY + marker.spriteOffset.y;
      marker.currentStepIndex = null;
      marker.stepProgress = 0;
      return;
    }
    const timeInCycle = ((elapsedMs % total) + total) % total;
    let accumulator = 0;
    let activeSegment = animator.segments[animator.segments.length - 1];
    for (const segment of animator.segments) {
      const next = accumulator + segment.durationMs;
      if (timeInCycle < next) {
        activeSegment = segment;
        break;
      }
      accumulator = next;
    }
    if (activeSegment.type === "move") {
      const segmentElapsed = timeInCycle - accumulator;
      const duration = activeSegment.durationMs > 0 ? activeSegment.durationMs : 1;
      const progress = Math.max(0, Math.min(1, segmentElapsed / duration));
      const interpDx =
        activeSegment.from.dx + (activeSegment.to.dx - activeSegment.from.dx) * progress;
      const interpDy =
        activeSegment.from.dy + (activeSegment.to.dy - activeSegment.from.dy) * progress;
      const stepIndex = activeSegment.stepIndex ?? 0;
      const parity = stepIndex & 1;
      const inStride = progress >= 0.5;
      const baseFrameIndex = parity === 0 ? 0 : 2;
      const strideFrameIndex = parity === 0 ? 1 : 3;
      const frameIndex = inStride ? strideFrameIndex : baseFrameIndex;
      applySpriteFrame(marker, activeSegment.direction, frameIndex);
      marker.sprite.x = baseX + marker.spriteOffset.x + interpDx * cellSize;
      marker.sprite.y = baseY + marker.spriteOffset.y + interpDy * cellSize;
      marker.currentStepIndex = activeSegment.stepIndex;
      marker.stepProgress = progress;
    } else {
      const stepIndex = activeSegment.stepIndex ?? 0;
      const parity = stepIndex & 1;
      const frameIndex = parity === 0 ? 0 : 2;
      applySpriteFrame(marker, activeSegment.direction, frameIndex);
      marker.sprite.x = baseX + marker.spriteOffset.x + activeSegment.position.dx * cellSize;
      marker.sprite.y = baseY + marker.spriteOffset.y + activeSegment.position.dy * cellSize;
      marker.currentStepIndex = activeSegment.stepIndex;
      marker.stepProgress = 0;
    }
    return;
  }

  if (animator.kind === "idle") {
    const frameCount = Math.max(1, animator.frameCount);
    const frameDuration = Math.max(1, animator.frameDurationMs);
    const loopDuration = frameCount * frameDuration;
    const cycleTime =
      (((elapsedMs + animator.phaseOffsetMs) % loopDuration) + loopDuration) % loopDuration;
    const frameIndex = Math.floor(cycleTime / frameDuration) % frameCount;
    applySpriteFrame(marker, animator.direction, frameIndex);
    marker.sprite.x = baseX + marker.spriteOffset.x;
    marker.sprite.y = baseY + marker.spriteOffset.y;
    marker.lastDirection = animator.direction ?? marker.lastDirection;
    marker.stepCount = null;
    marker.currentStepIndex = null;
    marker.stepProgress = 0;
    return;
  }

  if (animator.kind === "spin") {
    const total = animator.totalDurationMs;
    if (!(total > 0) || animator.steps.length === 0) {
      applySpriteFrame(
        marker,
        marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null,
        0,
      );
      marker.sprite.x = baseX + marker.spriteOffset.x;
      marker.sprite.y = baseY + marker.spriteOffset.y;
      marker.stepCount = null;
      marker.currentStepIndex = null;
      marker.stepProgress = 0;
      return;
    }
    const timeInCycle = ((elapsedMs % total) + total) % total;
    let accumulator = 0;
    let activeStep = animator.steps[animator.steps.length - 1];
    for (const step of animator.steps) {
      const next = accumulator + step.durationMs;
      if (timeInCycle < next) {
        activeStep = step;
        break;
      }
      accumulator = next;
    }
    applySpriteFrame(marker, activeStep.direction, 0);
    marker.sprite.x = baseX + marker.spriteOffset.x;
    marker.sprite.y = baseY + marker.spriteOffset.y;
    marker.lastDirection = activeStep.direction;
    marker.stepCount = null;
    marker.currentStepIndex = null;
    marker.stepProgress = 0;
    return;
  }

  applySpriteFrame(marker, marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null, 0);
  marker.sprite.x = baseX + marker.spriteOffset.x;
  marker.sprite.y = baseY + marker.spriteOffset.y;
  marker.stepCount = null;
  marker.currentStepIndex = null;
  marker.stepProgress = 0;
}
