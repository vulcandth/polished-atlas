import type {
  ObjectMetadata,
  ObjectEventEntry,
  ObjectSpriteDefinition,
  MapObjectMetadataEntry,
  MovementSummary,
} from "@/types";
import type { ObjectSpriteCache } from "@/lib/objectSprites";
import type { CollisionHelper } from "@/lib/collision";
import { getMovementModel } from "@/lib/movementModel";
import { simulateNpcMovement } from "@/lib/movementSimulation";
import type {
  CardinalDirection,
  SpriteFrameRef,
  MovementFrameSet,
  PokemonIconFrameRecord,
} from "@/components/MapCanvas/MapCanvas.types";
import {
  FRAME_DURATION_MS,
  POKEMON_ICON_FRAME_DURATION_SCALE,
  MIN_POKEMON_ICON_FRAME_DURATION_MS,
  STEP_FACING_KEYS,
} from "@/components/MapCanvas/constants";

/**
 * Compute frame index for a given elapsed time with frame durations.
 */
export function frameIndexForTime(
  elapsedMs: number,
  durations: number[],
  loopDuration: number,
): number {
  if (!durations.length || loopDuration <= 0) {
    return 0;
  }
  const cycle = elapsedMs % loopDuration;
  let acc = 0;
  for (let index = 0; index < durations.length; index += 1) {
    acc += durations[index];
    if (cycle < acc) {
      return index;
    }
  }
  return durations.length - 1;
}

/**
 * Check if an object is visible at a given time of day.
 */
export function isObjectVisibleAtTime(entry: ObjectEventEntry, timeOfDay: string): boolean {
  const slots = entry.timeOfDay?.slots;
  if (!Array.isArray(slots) || slots.length === 0) {
    return true;
  }
  return slots.includes(timeOfDay);
}

/**
 * Resolve the facing constant for an object based on its movement type.
 */
export function resolveFacingConstant(
  entry: ObjectEventEntry,
  metadata: ObjectMetadata,
): string | null {
  const movementKey = entry.movement?.constant ?? "";
  const movement = movementKey ? metadata.movements[movementKey] : undefined;
  const movementAction = movement?.action ?? "";
  if (movementAction === "OBJECT_ACTION_CUT_TREE" && metadata.facings["FACING_CUT_TREE"]) {
    return "FACING_CUT_TREE";
  }
  if (movementAction === "OBJECT_ACTION_FRUIT") {
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

/**
 * Resolve Pokémon species and form from object entry.
 */
export function resolvePokemonSpecies(entry: ObjectEventEntry): {
  species: string | null;
  form: string | null;
} {
  const speciesConstant =
    typeof entry.species?.constant === "string" ? entry.species.constant : null;
  const fallbackSpecies =
    typeof entry.extra?.["species"] === "string" ? (entry.extra!["species"] as string) : null;
  const rawForm = entry.extra?.["form"];
  const formConstant = typeof rawForm === "string" ? rawForm : null;
  return {
    species: speciesConstant ?? fallbackSpecies,
    form: formConstant,
  };
}

/**
 * Compute movement summary for an object using collision detection.
 */
export function computeMovementSummaryForObject(
  objectEntry: ObjectEventEntry,
  collisionHelper: CollisionHelper | null,
): MovementSummary | null {
  const model = getMovementModel(objectEntry.movement?.constant ?? null);
  try {
    return simulateNpcMovement({
      object: objectEntry,
      model,
      collisionHelper,
    });
  } catch (err) {
    console.warn("Failed to compute movement summary", objectEntry, err);
    return null;
  }
}

/**
 * Check if an object is within the map bounds.
 */
export function isObjectWithinMapBounds(
  objectEntry: ObjectEventEntry,
  mapData: MapObjectMetadataEntry | null | undefined,
  cellsPerBlock: number,
  eventCellPixelSize: number,
): boolean {
  if (!mapData) {
    return true;
  }
  const normalisedCellsPerBlock =
    Number.isFinite(cellsPerBlock) && cellsPerBlock > 0
      ? Math.trunc(Math.abs(cellsPerBlock))
      : null;
  if (!normalisedCellsPerBlock) {
    return true;
  }
  const widthBlocks =
    Number.isFinite(mapData.widthBlocks) && mapData.widthBlocks && mapData.widthBlocks > 0
      ? Math.abs(mapData.widthBlocks)
      : null;
  const heightBlocks =
    Number.isFinite(mapData.heightBlocks) && mapData.heightBlocks && mapData.heightBlocks > 0
      ? Math.abs(mapData.heightBlocks)
      : null;
  if (!widthBlocks && !heightBlocks) {
    return true;
  }
  const widthCells = widthBlocks ? widthBlocks * normalisedCellsPerBlock : null;
  const heightCells = heightBlocks ? heightBlocks * normalisedCellsPerBlock : null;
  const baseCellSize =
    Number.isFinite(eventCellPixelSize) && eventCellPixelSize > 0
      ? Math.abs(eventCellPixelSize)
      : null;

  const resolveCells = (tiles: number, pixels: number): number | null => {
    if (Number.isFinite(tiles)) {
      return tiles;
    }
    if (baseCellSize && Number.isFinite(pixels)) {
      return pixels / baseCellSize;
    }
    return null;
  };

  const xCells = resolveCells(objectEntry.xTiles, objectEntry.xPixels);
  const yCells = resolveCells(objectEntry.yTiles, objectEntry.yPixels);

  if (widthCells !== null && xCells !== null) {
    if (xCells < 0 || xCells >= widthCells) {
      return false;
    }
  }
  if (heightCells !== null && yCells !== null) {
    if (yCells < 0 || yCells >= heightCells) {
      return false;
    }
  }
  return true;
}

/**
 * Resolve cardinal direction from a facing key string.
 */
export function resolveDirectionFromFacingKey(
  key: string | null | undefined,
): CardinalDirection | null {
  if (!key) {
    return null;
  }
  const normalized = key.toUpperCase();
  if (normalized.includes("_DOWN")) {
    return "down";
  }
  if (normalized.includes("_UP")) {
    return "up";
  }
  if (normalized.includes("_LEFT")) {
    return "left";
  }
  if (normalized.includes("_RIGHT")) {
    return "right";
  }
  return null;
}

/**
 * Create a sprite frame reference from a cache record.
 */
export function createSpriteFrameRef(
  key: string,
  record: NonNullable<ReturnType<ObjectSpriteCache["getFacingTexture"]>>,
): SpriteFrameRef {
  return {
    key,
    texture: record.texture,
    offsetX: record.offsetX,
    offsetY: record.offsetY,
  };
}

/**
 * Create a seeded random number generator.
 */
export function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0xffffffff;
  };
}

/**
 * Convert a delta (dx, dy) to a cardinal direction.
 */
export function deltaToDirection(dx: number, dy: number): CardinalDirection | null {
  if (dx === 0 && dy === 0) {
    return null;
  }
  if (dx === 0) {
    if (dy > 0) {
      return "down";
    }
    if (dy < 0) {
      return "up";
    }
  }
  if (dy === 0) {
    if (dx > 0) {
      return "right";
    }
    if (dx < 0) {
      return "left";
    }
  }
  return null;
}

/**
 * Get the opposite direction.
 */
export function oppositeDirection(direction: CardinalDirection): CardinalDirection {
  switch (direction) {
    case "down":
      return "up";
    case "up":
      return "down";
    case "left":
      return "right";
    case "right":
      return "left";
    default:
      return direction;
  }
}

/**
 * Build static animation frames for special sprites like BIG_GYARADOS.
 */
export function buildStaticAnimationFrames(
  cache: ObjectSpriteCache,
  spriteKey: string,
  paletteName: string | null,
  defaultDirection: CardinalDirection | null,
): { direction: CardinalDirection; frames: SpriteFrameRef[] } | null {
  if (spriteKey !== "SPRITE_BIG_GYARADOS") {
    return null;
  }
  const facingKeys = ["FACING_BIG_GYARADOS_1", "FACING_BIG_GYARADOS_2"];
  const frames: SpriteFrameRef[] = [];
  for (const facingKey of facingKeys) {
    const record = cache.getFacingTexture(spriteKey, facingKey, paletteName ?? null);
    if (record) {
      frames.push(createSpriteFrameRef(facingKey, record));
    }
  }
  if (frames.length === 0) {
    return null;
  }
  if (frames.length === 1) {
    frames.push(frames[0]);
  }
  const direction = defaultDirection ?? "down";
  return {
    direction,
    frames,
  };
}

/**
 * Build a movement frame set for walking sprites.
 */
export function buildMovementFrameSet(
  cache: ObjectSpriteCache,
  spriteKey: string,
  spriteDef: ObjectSpriteDefinition,
  paletteName: string | null,
  baseKey: string,
  baseRecord: NonNullable<ReturnType<ObjectSpriteCache["getFacingTexture"]>>,
): MovementFrameSet {
  const defaultFrame = createSpriteFrameRef(baseKey, baseRecord);
  const framesByDirection: Partial<Record<CardinalDirection, SpriteFrameRef[]>> = {};
  const availableDirections: CardinalDirection[] = [];
  let defaultDirection = resolveDirectionFromFacingKey(baseKey);

  if (spriteDef.spriteType !== "WALKING_SPRITE") {
    const staticFrames = buildStaticAnimationFrames(
      cache,
      spriteKey,
      paletteName ?? null,
      defaultDirection ?? null,
    );
    if (staticFrames) {
      framesByDirection[staticFrames.direction] = staticFrames.frames;
      if (!availableDirections.includes(staticFrames.direction)) {
        availableDirections.push(staticFrames.direction);
      }
      if (!defaultDirection) {
        defaultDirection = staticFrames.direction;
      }
    }
    return {
      framesByDirection,
      availableDirections,
      defaultFrame,
      defaultDirection: defaultDirection ?? resolveDirectionFromFacingKey(baseKey),
    };
  }

  (Object.keys(STEP_FACING_KEYS) as CardinalDirection[]).forEach((direction) => {
    const keys = STEP_FACING_KEYS[direction];
    const frames: SpriteFrameRef[] = [];
    for (const facingKey of keys) {
      const record = cache.getFacingTexture(spriteKey, facingKey, paletteName ?? null);
      if (record) {
        frames.push(createSpriteFrameRef(facingKey, record));
      }
    }
    if (frames.length > 0) {
      if (frames.length < 4) {
        const originals = frames.slice();
        while (frames.length < 4) {
          frames.push(originals[frames.length % originals.length]);
        }
      }
      framesByDirection[direction] = frames;
      if (!availableDirections.includes(direction)) {
        availableDirections.push(direction);
      }
    }
  });

  defaultDirection = defaultDirection ?? resolveDirectionFromFacingKey(baseKey);
  if (!defaultDirection && availableDirections.length > 0) {
    defaultDirection = availableDirections[0];
  }
  if (defaultDirection && !availableDirections.includes(defaultDirection)) {
    availableDirections.unshift(defaultDirection);
  }

  return {
    framesByDirection,
    availableDirections,
    defaultFrame,
    defaultDirection: defaultDirection ?? null,
  };
}

/**
 * Build a frame set for Pokémon icon sprites.
 */
export function buildPokemonIconFrameSet(
  cache: ObjectSpriteCache,
  objectEntry: ObjectEventEntry,
  _spriteDef: ObjectSpriteDefinition,
  facingKey: string,
  paletteName: string | null,
  logContext: string,
): {
  baseFrame: SpriteFrameRef | null;
  frameSet: MovementFrameSet | null;
  frameDurationMs: number | null;
} {
  const spriteKey = "SPRITE_MON_ICON";
  const { species, form } = resolvePokemonSpecies(objectEntry);
  const palette = paletteName ?? null;
  const direction = resolveDirectionFromFacingKey(facingKey) ?? "down";
  const fallbackRecord = cache.getFacingTexture(spriteKey, facingKey, palette);
  const iconData = cache.getPokemonIconFrameTextures(species, form, palette);

  const convertFrame = (frameRecord: PokemonIconFrameRecord, index: number): SpriteFrameRef => {
    const halfWidth = Math.round((frameRecord.width ?? 0) / 2);
    const halfHeight = Math.round((frameRecord.height ?? 0) / 2);
    return {
      key: `${spriteKey}:${species ?? "UNKNOWN"}:${form ?? "NO_FORM"}:${index}`,
      texture: frameRecord.texture,
      offsetX: frameRecord.offsetX + halfWidth,
      offsetY: frameRecord.offsetY + halfHeight,
    };
  };

  if (iconData && iconData.frames.length > 0) {
    console.info(`[MapCanvas] Pokémon icon lookup (${logContext})`, {
      species,
      form,
      palette,
      hasEntry: true,
      frameCount: iconData.frames.length,
      frameDurationFrames: iconData.frameDurationFrames,
    });

    const frames: SpriteFrameRef[] = iconData.frames.map((frameRecord, index) =>
      convertFrame(frameRecord, index),
    );
    const baseFrame = frames[0] ?? null;
    const frameSet = baseFrame
      ? {
          framesByDirection: { [direction]: frames },
          availableDirections: [direction],
          defaultFrame: baseFrame,
          defaultDirection: direction,
        }
      : null;
    const frameDurationMs = Math.max(
      MIN_POKEMON_ICON_FRAME_DURATION_MS,
      iconData.frameDurationFrames * FRAME_DURATION_MS * POKEMON_ICON_FRAME_DURATION_SCALE,
    );
    return {
      baseFrame,
      frameSet,
      frameDurationMs,
    };
  }

  console.warn(`[MapCanvas] Falling back to placeholder icon (${logContext})`, {
    species,
    form,
    palette,
    hasEntry: Boolean(iconData?.frames.length),
  });

  if (!fallbackRecord) {
    return {
      baseFrame: null,
      frameSet: null,
      frameDurationMs: null,
    };
  }

  const halfWidth = Math.round((fallbackRecord.width ?? 0) / 2);
  const halfHeight = Math.round((fallbackRecord.height ?? 0) / 2);
  const fallbackFrame: SpriteFrameRef = {
    key: `${spriteKey}:${facingKey}:fallback`,
    texture: fallbackRecord.texture,
    offsetX: fallbackRecord.offsetX + halfWidth,
    offsetY: fallbackRecord.offsetY + halfHeight,
  };
  const fallbackFrameSet: MovementFrameSet = {
    framesByDirection: { [direction]: [fallbackFrame] },
    availableDirections: [direction],
    defaultFrame: fallbackFrame,
    defaultDirection: direction,
  };

  return {
    baseFrame: fallbackFrame,
    frameSet: fallbackFrameSet,
    frameDurationMs: null,
  };
}
