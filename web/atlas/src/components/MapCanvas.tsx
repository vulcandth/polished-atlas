import { useCallback, useEffect, useRef, useState } from "react";
import { Application, Container, AnimatedSprite, FederatedPointerEvent, Assets, Graphics, Sprite, Texture } from "pixi.js";
import {
  AtlasLayout,
  MapPlacement,
  MapWarp,
  ObjectMetadata,
  MapObjectMetadataEntry,
  ObjectEventEntry,
  ObjectSpriteDefinition,
  WarpMetadata,
  MovementSummary,
} from "@/types";
import { registerPixiExtensions } from "@/pixi/registerExtensions";
import { loadMapAnimation, type MapAnimationResource } from "@/lib/loadMapAnimation";
import { ObjectSpriteCache } from "@/lib/objectSprites";
import { computeObjectPosition, type PlacementContext } from "@/lib/objectPlacement";
import { createCollisionHelper, type CollisionHelper } from "@/lib/collision";
import { getMovementModel } from "@/lib/movementModel";
import { simulateNpcMovement } from "@/lib/movementSimulation";
import { analyzeAllSpriteLimits, type SpriteLimitIssue, type MapScope } from "@/lib/spriteLimitAnalysis";

type OffsetTuple = [number, number];

type WarpMarkerEntry = {
  warp: MapWarp;
  graphic: Graphics;
  // Local pixel offsets within the map sprite
  localX: number;
  localY: number;
};

type WarpBacklink = {
  applicableTo: string | null;
  mapLabel: string;
  mapConstant: string | null;
  warpIndex: number;
  previous: WarpBacklink | null;
};

type CardinalDirection = "down" | "up" | "left" | "right";

type Offset = { dx: number; dy: number };

type SpriteFrameRef = {
  key: string;
  texture: Texture;
  offsetX: number;
  offsetY: number;
};

type MovementFrameSet = {
  framesByDirection: Partial<Record<CardinalDirection, SpriteFrameRef[]>>;
  availableDirections: CardinalDirection[];
  defaultFrame: SpriteFrameRef;
  defaultDirection: CardinalDirection | null;
};

type PokemonIconFrameRecord = NonNullable<ReturnType<ObjectSpriteCache["getPokemonIconFrameTextures"]>>["frames"][number];

type MovementSegment =
  | {
      type: "move";
      from: Offset;
      to: Offset;
      direction: CardinalDirection;
      durationMs: number;
      stepIndex: number;
    }
  | {
      type: "wait";
      position: Offset;
      direction: CardinalDirection;
      durationMs: number;
      stepIndex: number;
    };

type PathMovementAnimator = {
  kind: "path";
  segments: MovementSegment[];
  totalDurationMs: number;
  stepCount: number;
};

type SpinStep = {
  direction: CardinalDirection;
  durationMs: number;
};

type SpinMovementAnimator = {
  kind: "spin";
  steps: SpinStep[];
  totalDurationMs: number;
};

type IdleMovementAnimator = {
  kind: "idle";
  direction: CardinalDirection | null;
  frameCount: number;
  frameDurationMs: number;
  phaseOffsetMs: number;
};

type MovementAnimator = PathMovementAnimator | SpinMovementAnimator | IdleMovementAnimator;

type ObjectMarkerEntry = {
  object: ObjectEventEntry;
  sprite: Sprite;
  movementSummary: MovementSummary | null;
  animator: MovementAnimator | null;
  basePosition: { x: number; y: number };
  spriteOffset: { x: number; y: number };
  cellPixelSize: number;
  frameSet: MovementFrameSet | null;
  currentFrameKey: string | null;
  spriteScale: number;
  lastDirection: CardinalDirection | null;
  currentStepIndex: number | null;
  stepProgress: number;
  stepCount: number | null;
};

interface MapCanvasProps {
  atlas: AtlasLayout | null;
  loading: boolean;
  editing?: boolean;
  warpMetadata?: WarpMetadata | null;
  resolveAssetHref?: (mapLabel: string) => string;
  baseOffsets?: Record<string, OffsetTuple> | null;
  offsetOverrides?: Record<string, OffsetTuple> | null;
  zOverrides?: Record<string, number> | null;
  selectedNeighborhoodId?: string | null;
  onSelectNeighborhood?: (id: string) => void;
  onOffsetChange?: (id: string, next: OffsetTuple) => void;
  objectMetadata?: ObjectMetadata | null;
  timeOfDay?: string;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
// Allow panning beyond the edge of the content for better UX (esp. on mobile)
function computeOverscrollPx(viewW: number, viewH: number): number {
  const basis = Math.min(Math.max(viewW, 1), Math.max(viewH, 1));
  // 10% of the smaller viewport dimension, clamped to a sensible range
  const candidate = Math.max(viewW, viewH) > 0 ? Math.min(viewW, viewH) * 0.1 : 64;
  return Math.max(48, Math.min(256, candidate));
}

// Provide a slightly larger buffer at the bottom, where browser UI can
// overlap content and thumbs often need headroom.
function computeBottomExtraPx(viewH: number): number {
  // 1.5x the base overscroll or at least 32 additional pixels
  const base = computeOverscrollPx(viewH, viewH);
  return Math.max(32, Math.floor(base * 0.5));
}
const VIEW_STATE_STORAGE_KEY = "polished-atlas:view-state";
const VIEW_STATE_VERSION = 1;

interface StoredViewState {
  version: number;
  scale: number;
  center: {
    x: number;
    y: number;
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readStoredViewState(): StoredViewState | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(VIEW_STATE_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as StoredViewState | undefined;
    if (!parsed || parsed.version !== VIEW_STATE_VERSION) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredViewState(state: StoredViewState): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(VIEW_STATE_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.warn("Failed to persist atlas view state", err);
  }
}

function clampUnit(value: unknown, fallback = 0.5): number {
  if (!isFiniteNumber(value)) {
    return fallback;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function clampScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

registerPixiExtensions();

function disposeAnimationResource(resource: MapAnimationResource | null | undefined): void {
  if (!resource) {
    return;
  }
  // First, dispose of the Texture wrappers without touching the BaseTexture
  // so that the asset system can own the BaseTexture lifecycle.
  for (const texture of resource.textures) {
    try {
      if (texture && !texture.destroyed) {
        texture.destroy(false);
      }
    } catch {
      /* ignore individual texture destroy issues */
    }
  }
  // Then, unload via Assets which will properly destroy the BaseTexture it manages.
  void Assets.unload(resource.imageUrl);
}

function rendererOn(app: Application | null, event: string, handler: (...args: any[]) => void): void {
  const r: any = app && (app as any).renderer;
  if (r && typeof r.on === "function") {
    try { r.on(event, handler); } catch { /* noop */ }
  }
}

function rendererOff(app: Application | null, event: string, handler: (...args: any[]) => void): void {
  const r: any = app && (app as any).renderer;
  if (r && typeof r.off === "function") {
    try { r.off(event, handler); } catch { /* noop */ }
  }
}

// Compute the effective visible size of the canvas in CSS pixels, accounting for
// mobile browser UI that reduces the visual viewport compared to the layout viewport.
function getEffectiveViewSize(app: Application | null): { width: number; height: number } {
  if (!app) return { width: 0, height: 0 };
  const renderer = app.renderer;
  const canvas = app.view as unknown as HTMLCanvasElement | null;
  const baseW = Math.max(0, renderer?.width ?? 0);
  const baseH = Math.max(0, renderer?.height ?? 0);
  let rectW = baseW;
  let rectH = baseH;
  if (canvas) {
    const rect = canvas.getBoundingClientRect();
    rectW = Math.max(0, Math.round(rect.width));
    rectH = Math.max(0, Math.round(rect.height));
  }
  let vvW = Number.POSITIVE_INFINITY;
  let vvH = Number.POSITIVE_INFINITY;
  if (typeof window !== "undefined" && (window as any).visualViewport) {
    const vv = window.visualViewport as VisualViewport;
    vvW = Math.max(0, Math.round(vv.width));
    vvH = Math.max(0, Math.round(vv.height));
  }
  const width = Math.min(baseW || Number.POSITIVE_INFINITY, rectW || Number.POSITIVE_INFINITY, vvW);
  const height = Math.min(baseH || Number.POSITIVE_INFINITY, rectH || Number.POSITIVE_INFINITY, vvH);
  return {
    width: Number.isFinite(width) ? width : baseW,
    height: Number.isFinite(height) ? height : baseH,
  };
}

type SyncedAnimation = {
  sprite: AnimatedSprite;
  resource: MapAnimationResource;
  placement: MapPlacement;
  order: number;
  neighborhoodId: string | null;
  warpMarkers: WarpMarkerEntry[];
  objectContainer: Container | null;
  objectMarkers: ObjectMarkerEntry[];
  collisionHelper: CollisionHelper | null;
  // Whether this map sprite is currently within (or near) the viewport
  // and should be updated/rendered. Used for simple view culling.
  visible?: boolean;
};

type OverlayState = {
  mapLabel: string;
  sprite: AnimatedSprite;
  resource: MapAnimationResource;
  background: Graphics;
  markers: WarpMarkerEntry[];
  highlight?: Graphics;
  baseWidth: number;
  baseHeight: number;
  cellSize: number;
  baseAlpha: number;
  keyHandler: (event: KeyboardEvent) => void;
  objectContainer: Container | null;
  objectMarkers: ObjectMarkerEntry[];
  collisionHelper: CollisionHelper | null;
  scale: number;
  fitScale: number;
  minScale: number;
  maxScale: number;
  positioned: boolean;
  // Sprite limit analysis
  spriteLimitEnabled?: boolean;
  spriteIssues?: SpriteLimitIssue[];
  spriteIssueIndex?: number;
  spriteIssueHighlight?: Graphics;
};

function frameIndexForTime(elapsedMs: number, durations: number[], loopDuration: number): number {
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

function isObjectVisibleAtTime(entry: ObjectEventEntry, timeOfDay: string): boolean {
  const slots = entry.timeOfDay?.slots;
  if (!Array.isArray(slots) || slots.length === 0) {
    return true;
  }
  return slots.includes(timeOfDay);
}

function resolveFacingConstant(entry: ObjectEventEntry, metadata: ObjectMetadata): string | null {
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
  if (movementAction === "OBJECT_ACTION_SAILBOAT_BOTTOM" && metadata.facings["FACING_SAILBOAT_BOTTOM"]) {
    return "FACING_SAILBOAT_BOTTOM";
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

function resolvePokemonSpecies(entry: ObjectEventEntry): { species: string | null; form: string | null } {
  const speciesConstant = typeof entry.species?.constant === "string" ? entry.species.constant : null;
  const fallbackSpecies = typeof entry.extra?.["species"] === "string" ? (entry.extra!["species"] as string) : null;
  const rawForm = entry.extra?.["form"];
  const formConstant = typeof rawForm === "string" ? rawForm : null;
  return {
    species: speciesConstant ?? fallbackSpecies,
    form: formConstant,
  };
}

function computeMovementSummaryForObject(
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

function isObjectWithinMapBounds(
  objectEntry: ObjectEventEntry,
  mapData: MapObjectMetadataEntry | null | undefined,
  cellsPerBlock: number,
  eventCellPixelSize: number,
): boolean {
  if (!mapData) {
    return true;
  }
  const normalisedCellsPerBlock = Number.isFinite(cellsPerBlock) && cellsPerBlock > 0
    ? Math.trunc(Math.abs(cellsPerBlock))
    : null;
  if (!normalisedCellsPerBlock) {
    return true;
  }
  const widthBlocks = Number.isFinite(mapData.widthBlocks) && mapData.widthBlocks && mapData.widthBlocks > 0
    ? Math.abs(mapData.widthBlocks)
    : null;
  const heightBlocks = Number.isFinite(mapData.heightBlocks) && mapData.heightBlocks && mapData.heightBlocks > 0
    ? Math.abs(mapData.heightBlocks)
    : null;
  if (!widthBlocks && !heightBlocks) {
    return true;
  }
  const widthCells = widthBlocks ? widthBlocks * normalisedCellsPerBlock : null;
  const heightCells = heightBlocks ? heightBlocks * normalisedCellsPerBlock : null;
  const baseCellSize = Number.isFinite(eventCellPixelSize) && eventCellPixelSize > 0
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

const FRAME_DURATION_MS = 1000 / 60;
const POKEMON_ICON_FRAME_DURATION_SCALE = 2;
const MIN_POKEMON_ICON_FRAME_DURATION_MS = 120;
const MOVEMENT_SPEED_SCALE = 2;

const STEP_FRAMES_BY_SPEED: Record<string, number> = {
  slow: 32,
  normal: 16,
  fast: 8,
};

const IDLE_FRAMES_BY_SPEED: Record<string, number> = {
  slow: 48,
  normal: 32,
  fast: 20,
};

const SPIN_INTERVAL_BY_SPEED: Record<string, number> = {
  slow: 700,
  normal: 540,
  fast: 360,
};

const STEP_FACING_KEYS: Record<CardinalDirection, string[]> = {
  down: ["FACING_STEP_DOWN_0", "FACING_STEP_DOWN_1", "FACING_STEP_DOWN_2", "FACING_STEP_DOWN_3"],
  up: ["FACING_STEP_UP_0", "FACING_STEP_UP_1", "FACING_STEP_UP_2", "FACING_STEP_UP_3"],
  left: ["FACING_STEP_LEFT_0", "FACING_STEP_LEFT_1", "FACING_STEP_LEFT_2", "FACING_STEP_LEFT_3"],
  right: ["FACING_STEP_RIGHT_0", "FACING_STEP_RIGHT_1", "FACING_STEP_RIGHT_2", "FACING_STEP_RIGHT_3"],
};

const CLOCKWISE_SEQUENCE: CardinalDirection[] = ["right", "down", "left", "up"];
const COUNTERCLOCKWISE_SEQUENCE: CardinalDirection[] = ["right", "up", "left", "down"];

const DIRECTION_DELTAS: Record<CardinalDirection, Offset> = {
  down: { dx: 0, dy: 1 },
  up: { dx: 0, dy: -1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

function movementSpeedToStepDuration(speed: MovementSummary["model"]["speed"] | undefined): number {
  const frames = speed ? STEP_FRAMES_BY_SPEED[speed] : undefined;
  const frameCount = Number.isFinite(frames) ? (frames as number) : STEP_FRAMES_BY_SPEED.normal;
  return frameCount * FRAME_DURATION_MS * MOVEMENT_SPEED_SCALE;
}

function movementSpeedToIdleDuration(speed: MovementSummary["model"]["speed"] | undefined): number {
  const frames = speed ? IDLE_FRAMES_BY_SPEED[speed] : undefined;
  const frameCount = Number.isFinite(frames) ? (frames as number) : IDLE_FRAMES_BY_SPEED.normal;
  return frameCount * FRAME_DURATION_MS * MOVEMENT_SPEED_SCALE;
}

function movementSpeedToSpinInterval(speed: MovementSummary["model"]["speed"] | undefined): number {
  const interval = speed ? SPIN_INTERVAL_BY_SPEED[speed] : undefined;
  const base = Number.isFinite(interval) ? (interval as number) : SPIN_INTERVAL_BY_SPEED.normal;
  return base * MOVEMENT_SPEED_SCALE;
}

function resolveDirectionFromFacingKey(key: string | null | undefined): CardinalDirection | null {
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

function createSpriteFrameRef(
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

function createSeededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0xffffffff;
  };
}

function deltaToDirection(dx: number, dy: number): CardinalDirection | null {
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

function oppositeDirection(direction: CardinalDirection): CardinalDirection {
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

function buildStaticAnimationFrames(
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

function buildMovementFrameSet(
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
    const staticFrames = buildStaticAnimationFrames(cache, spriteKey, paletteName ?? null, defaultDirection ?? null);
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

function buildPokemonIconFrameSet(
  cache: ObjectSpriteCache,
  objectEntry: ObjectEventEntry,
  _spriteDef: ObjectSpriteDefinition,
  facingKey: string,
  paletteName: string | null,
  logContext: string,
): { baseFrame: SpriteFrameRef | null; frameSet: MovementFrameSet | null; frameDurationMs: number | null } {
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

    const frames: SpriteFrameRef[] = iconData.frames.map((frameRecord, index) => convertFrame(frameRecord, index));
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

function createAxisPathAnimator(
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
  let currentDirection: CardinalDirection = frameSet?.defaultDirection ?? (summary.axis === "x" ? "right" : "down");
  let lastStepIndex: number = recordedSteps.length > 0 ? recordedSteps[0].index : 0;
  let nextStepCursor = 0;
  let moveSegmentCount = 0;

  const rngSeedBase = ((objectEntry.index ?? 0) * 1103515245 + start.x * 1237 + start.y * 1999) >>> 0;
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
    const fallbackStep = recordedSteps[Math.min(recordedSteps.length - 1, nextStepCursor)] ?? recordedSteps[recordedSteps.length - 1];
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
  const totalDuration = segments.reduce((total, segment) => total + Math.max(0, segment.durationMs), 0);
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

function createWanderAnimator(
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

  const seedBase = (objectEntry.index ?? 0) * 1103515245 + summary.startCell.x * 1237 + summary.startCell.y * 1999;
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

  const totalDuration = segments.reduce((total, segment) => total + Math.max(0, segment.durationMs), 0);
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

function createSpinAnimator(
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
    const rngSeed = (objectEntry.index ?? 0) * 214013 + summary.startCell.x * 2531011 + summary.startCell.y * 1376312589;
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

function createIdleAnimator(
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
  const seed = ((objectEntry.index ?? 0) * 2147483647 + summary.startCell.x * 2654435761 + summary.startCell.y * 40503) >>> 0;
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

function createPokemonIconAnimator(
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

function createMovementAnimator(
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

function applySpriteFrame(marker: ObjectMarkerEntry, direction: CardinalDirection | null, frameIndex: number): void {
  const frameSet = marker.frameSet;
  if (!frameSet) {
    if (direction) {
      marker.lastDirection = direction;
    }
    return;
  }
  let frames = direction && frameSet.framesByDirection[direction]?.length
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
      (spriteName === "SPRITE_SAILBOAT" || spriteName === "SPRITE_BIG_GYARADOS" || spriteName === "SPRITE_BIG_SNORLAX")
    ) {
      const tex = frame.texture;
      console.info(
        `[SpriteCache] ${spriteName} frame ${frame.key} resolved ${tex.width}x${tex.height} (offset=${frame.offsetX},${frame.offsetY})`
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

function updateMarkerAnimation(marker: ObjectMarkerEntry, elapsedMs: number): void {
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
      applySpriteFrame(marker, marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null, 0);
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
      const interpDx = activeSegment.from.dx + (activeSegment.to.dx - activeSegment.from.dx) * progress;
      const interpDy = activeSegment.from.dy + (activeSegment.to.dy - activeSegment.from.dy) * progress;
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
    const cycleTime = ((elapsedMs + animator.phaseOffsetMs) % loopDuration + loopDuration) % loopDuration;
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
      applySpriteFrame(marker, marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null, 0);
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

function snapToHalf(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 2) / 2;
}

export default function MapCanvas({
  atlas,
  loading,
  editing = false,
  warpMetadata = null,
  resolveAssetHref,
  baseOffsets = null,
  offsetOverrides = null,
  zOverrides = null,
  selectedNeighborhoodId = null,
  onSelectNeighborhood,
  onOffsetChange,
  objectMetadata = null,
  timeOfDay = "day",
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const scaleRef = useRef(1);
  const boundsRef = useRef<{ width: number; height: number } | null>(null);
  const resetViewRef = useRef<() => void>(() => undefined);
  const animationsRef = useRef<SyncedAnimation[]>([]);
  const spriteEntryMapRef = useRef<WeakMap<AnimatedSprite, SyncedAnimation>>(new WeakMap());
  const syncStartRef = useRef(0);
  const persistTimerRef = useRef<number | null>(null);
  const editDragStateRef = useRef<{
    pointerId: number;
    neighborhoodId: string;
    sprite: AnimatedSprite;
    startOffset: OffsetTuple;
    startPoint: { x: number; y: number };
  } | null>(null);
  const warpMetadataRef = useRef<WarpMetadata | null>(null);
  const overlayRef = useRef<Container | null>(null);
  const overlayStateRef = useRef<OverlayState | null>(null);
  const overlayTokenRef = useRef(0);
  const warpsLayerRef = useRef<Container | null>(null);
  const highlightTimersRef = useRef<Map<string, number>>(new Map());
  const backlinkRef = useRef<WarpBacklink | null>(null);
  const handleOverlayWarpRef = useRef<((warp: MapWarp) => void) | null>(null);
  const objectMetadataRef = useRef<ObjectMetadata | null>(null);
  const objectSpriteCacheRef = useRef<ObjectSpriteCache | null>(null);
  const objectCacheSourceRef = useRef<ObjectMetadata | null>(null);
  const [ready, setReady] = useState(false);

  // Sprite limits UI state
  const [spriteLimitEnabled, setSpriteLimitEnabled] = useState(false);
  const [spriteIssues, setSpriteIssues] = useState<SpriteLimitIssue[] | null>(null);
  const [spriteIssuesAll, setSpriteIssuesAll] = useState<SpriteLimitIssue[] | null>(null);
  const [spriteIssueIndex, setSpriteIssueIndex] = useState<number>(0);
  const [spriteScope, setSpriteScope] = useState<MapScope>("all");
  const [spriteScanlineLimit, setSpriteScanlineLimit] = useState<number>(10);
  const [spriteTotalLimit, setSpriteTotalLimit] = useState<number>(40);
  const [spriteIncludeFollower, setSpriteIncludeFollower] = useState<boolean>(false);
  const [spriteIncludeWeather, setSpriteIncludeWeather] = useState<boolean>(false);
  const [spriteOnlyErrors, setSpriteOnlyErrors] = useState<boolean>(false);
  const [spriteAnalyzing, setSpriteAnalyzing] = useState<boolean>(false);
  const worldIssueHighlightRef = useRef<Graphics | null>(null);
  const [resultsCollapsed, setResultsCollapsed] = useState<boolean>(false);

  const baseOffsetsRef = useRef<Record<string, OffsetTuple>>({});
  const offsetOverridesRef = useRef<Record<string, OffsetTuple>>({});
  const zOverridesRef = useRef<Record<string, number>>({});

  useEffect(() => {
    baseOffsetsRef.current = baseOffsets ?? {};
  }, [baseOffsets]);

  useEffect(() => {
    offsetOverridesRef.current = offsetOverrides ?? {};
  }, [offsetOverrides]);

  useEffect(() => {
    zOverridesRef.current = zOverrides ?? {};
  }, [zOverrides]);

  useEffect(() => {
    warpMetadataRef.current = warpMetadata ?? null;
  }, [warpMetadata]);

  useEffect(() => {
    objectMetadataRef.current = objectMetadata ?? null;
  }, [objectMetadata]);

  const applySpriteTransforms = useCallback((): void => {
    const world = worldRef.current;
    if (!world || !atlas) {
      return;
    }
    const blockPixelSize = atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize !== 0
      ? Math.max(1, Math.abs(atlas.blockPixelSize))
      : 16;
    const editingEnabled = Boolean(editing && onOffsetChange);
    const baseMap = baseOffsetsRef.current;
    const overrideMap = offsetOverridesRef.current;
    const zMap = zOverridesRef.current;
    const selectedId = selectedNeighborhoodId ?? null;

    for (const entry of animationsRef.current) {
      const { sprite, placement, order, neighborhoodId } = entry;
      const baseOffset = neighborhoodId && baseMap[neighborhoodId] ? baseMap[neighborhoodId] : [0, 0];
      const targetOffset = editingEnabled && neighborhoodId ? overrideMap[neighborhoodId] ?? baseOffset : baseOffset;
      const deltaXBlocks = targetOffset[0] - baseOffset[0];
      const deltaYBlocks = targetOffset[1] - baseOffset[1];
      sprite.x = placement.x + deltaXBlocks * blockPixelSize;
      sprite.y = placement.y + deltaYBlocks * blockPixelSize;

      const baseZ = placement.metadata?.neighborhoodZ ?? 0;
      const targetZ = editingEnabled && neighborhoodId ? zMap[neighborhoodId] ?? baseZ : baseZ;
      const localMapZ = Number.isFinite(placement.metadata?.mapZ as number)
        ? Math.trunc((placement.metadata?.mapZ as number) || 0)
        : order;
      sprite.zIndex = targetZ * 1_000_000 + localMapZ * 1_000 + order;

      // Update global warp marker positions to follow sprite world transforms
      const warpsLayer = warpsLayerRef.current;
      if (warpsLayer && Array.isArray(entry.warpMarkers) && entry.warpMarkers.length > 0) {
        for (const marker of entry.warpMarkers) {
          marker.graphic.x = sprite.x + marker.localX;
          marker.graphic.y = sprite.y + marker.localY;
        }
      }

      if (editingEnabled) {
        const isSelected = selectedId ? neighborhoodId === selectedId : false;
        sprite.alpha = isSelected ? 1 : 0.85;
      } else {
        sprite.alpha = 1;
      }
    }

    world.sortChildren();
  }, [atlas, editing, onOffsetChange, selectedNeighborhoodId]);

  const clearHighlightTimers = useCallback((): void => {
    if (typeof window === "undefined") {
      highlightTimersRef.current.clear();
      return;
    }
    for (const timerId of highlightTimersRef.current.values()) {
      window.clearTimeout(timerId);
    }
    highlightTimersRef.current.clear();
  }, []);

  const computeCellSize = useCallback((): number => {
    const blockPixelSize = atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize > 0
      ? Math.abs(atlas.blockPixelSize)
      : 32;
    const metadata = warpMetadataRef.current;
    if (metadata) {
      const explicit = Number(metadata.cellPixelSize);
      if (Number.isFinite(explicit) && explicit > 0) {
        return explicit;
      }
      const cellsPerBlock = Number(metadata.cellsPerBlock);
      if (Number.isFinite(cellsPerBlock) && cellsPerBlock > 0) {
        return blockPixelSize / cellsPerBlock;
      }
    }
    return blockPixelSize / 2;
  }, [atlas]);

  const highlightWarpMarker = useCallback(
    (entry: SyncedAnimation, warpIndex: number | null | undefined): void => {
      if (!entry || !Array.isArray(entry.warpMarkers)) {
        return;
      }
      if (typeof warpIndex !== "number" || !Number.isFinite(warpIndex)) {
        return;
      }
      const marker = entry.warpMarkers.find((item) => item.warp.index === warpIndex);
      if (!marker) {
        return;
      }
      const key = `${entry.placement.label}:${warpIndex}`;
      const baseAlpha = editing ? 0.5 : 0.9;
      if (typeof window !== "undefined") {
        const timers = highlightTimersRef.current;
        const existing = timers.get(key);
        if (existing !== undefined) {
          window.clearTimeout(existing);
        }
        marker.graphic.alpha = 1;
        marker.graphic.scale.set(1.15);
        const timeout = window.setTimeout(() => {
          marker.graphic.alpha = baseAlpha;
          marker.graphic.scale.set(1);
          timers.delete(key);
        }, 900);
        timers.set(key, timeout);
        return;
      }
      marker.graphic.alpha = baseAlpha;
      marker.graphic.scale.set(1);
    },
    [editing]
  );

  const drawSpriteIssueHighlight = useCallback((issue: SpriteLimitIssue | null): void => {
    const state = overlayStateRef.current;
    if (!state || !state.sprite) {
      return;
    }
    // Remove previous
    if (state.spriteIssueHighlight) {
      try {
        state.spriteIssueHighlight.destroy({ children: true });
      } catch {
        /* ignore */
      }
      state.spriteIssueHighlight = undefined;
    }
    if (!issue) {
      setSpriteIssueIndex(0);
      return;
    }
    const g = new Graphics();
    // Viewport rectangle
    g.lineStyle(Math.max(1, state.cellSize * 0.1), issue.severity === "exceeds" ? 0xe74c3c : 0xf1c40f, 0.95);
    g.beginFill(issue.severity === "exceeds" ? 0xe74c3c : 0xf39c12, 0.15);
    g.drawRect(issue.viewportPx.x, issue.viewportPx.y, issue.viewportPx.width, issue.viewportPx.height);
    g.endFill();
    // Scanline indicator
    if (issue.type === "scanline-limit" && Number.isFinite(issue.scanlineY)) {
      const y = issue.viewportPx.y + (issue.scanlineY ?? 0);
      g.lineStyle(Math.max(1, state.cellSize * 0.15), 0xe74c3c, 0.9);
      g.moveTo(issue.viewportPx.x, y);
      g.lineTo(issue.viewportPx.x + issue.viewportPx.width, y);
    }
    g.zIndex = 50;
    state.sprite.addChild(g);
    state.sprite.sortChildren();
    state.spriteIssueHighlight = g;
  }, []);

  const clearOverlayIssueHighlight = useCallback((): void => {
    const state = overlayStateRef.current;
    if (!state) return;
    if (state.spriteIssueHighlight) {
      try {
        state.spriteIssueHighlight.destroy({ children: true });
      } catch {
        /* ignore */
      }
      state.spriteIssueHighlight = undefined;
    }
  }, []);

  const clearWorldIssueHighlight = useCallback((): void => {
    const g = worldIssueHighlightRef.current;
    if (g) {
      try { g.destroy({ children: true }); } catch { /* ignore */ }
      worldIssueHighlightRef.current = null;
    }
  }, []);

  const drawWorldIssueHighlight = useCallback((entry: SyncedAnimation, issue: SpriteLimitIssue | null): void => {
    clearWorldIssueHighlight();
    if (!entry || !issue) return;
    const g = new Graphics();
    g.lineStyle(Math.max(1, (entry.placement.blockPixelSize ?? 16) * 0.1), issue.severity === "exceeds" ? 0xe74c3c : 0xf1c40f, 0.95);
    g.beginFill(issue.severity === "exceeds" ? 0xe74c3c : 0xf39c12, 0.15);
    g.drawRect(issue.viewportPx.x, issue.viewportPx.y, issue.viewportPx.width, issue.viewportPx.height);
    g.endFill();
    g.zIndex = 50;
    entry.sprite.addChild(g);
    entry.sprite.sortChildren();
    worldIssueHighlightRef.current = g;
  }, [clearWorldIssueHighlight]);

  const computeSpriteLimitAnalysis = useCallback(() => {
    const warp = warpMetadataRef.current;
    const objects = objectMetadataRef.current;
    if (!objects || !warp) {
      setSpriteIssues([]);
      return;
    }
    try {
      const results = analyzeAllSpriteLimits(objects, warp, {
        timeOfDay,
        stopAtFirst: false,
        scope: spriteScope,
        scanlineLimit: Math.max(0, Math.trunc(spriteScanlineLimit || 0)),
        totalLimit: Math.max(0, Math.trunc(spriteTotalLimit || 0)),
        includeFollower: Boolean(spriteIncludeFollower),
        includeWeather: Boolean(spriteIncludeWeather),
      });
      const filtered = spriteOnlyErrors ? results.filter((r) => r.severity === "exceeds") : results;
      setSpriteIssuesAll(results);
      setSpriteIssues(filtered);
      setSpriteIssueIndex(filtered.length > 0 ? 0 : 0);
    } catch (err) {
      console.warn("Sprite limit analysis (all) failed", err);
      setSpriteIssuesAll([]);
      setSpriteIssues([]);
    }
  }, [timeOfDay, spriteScope, spriteScanlineLimit, spriteTotalLimit, spriteIncludeFollower, spriteIncludeWeather, spriteOnlyErrors]);

  const runSpriteLimitAnalysis = useCallback(() => {
    setSpriteAnalyzing(true);
    // Defer compute to allow UI (button state) to update before heavy work
    setTimeout(() => {
      try {
        computeSpriteLimitAnalysis();
      } finally {
        setSpriteAnalyzing(false);
      }
    }, 0);
  }, [computeSpriteLimitAnalysis]);

  // Re-filter without re-analyzing when toggling the severity filter
  useEffect(() => {
    if (!spriteIssuesAll) return;
    const filtered = spriteOnlyErrors ? spriteIssuesAll.filter((r) => r.severity === "exceeds") : spriteIssuesAll;
    setSpriteIssues(filtered);
    setSpriteIssueIndex(0);
  }, [spriteOnlyErrors, spriteIssuesAll]);

  const positionOverlayContents = useCallback((): void => {
    const state = overlayStateRef.current;
    const overlay = overlayRef.current;
    const app = appRef.current;
    if (!state || !overlay || !app) {
      return;
    }
    const renderer = app.renderer;
    const sprite = state.sprite;
    const background = state.background;
    const rendererWidth = Math.max(1, renderer.width ?? renderer.screen?.width ?? 0);
    const rendererHeight = Math.max(1, renderer.height ?? renderer.screen?.height ?? 0);

    if (background) {
      background.clear();
      background.beginFill(0x000000, Math.max(0, Math.min(1, state.baseAlpha ?? 0.9)));
      background.drawRect(0, 0, rendererWidth, rendererHeight);
      background.endFill();
    }

    const baseWidth = state.baseWidth || sprite.width || 1;
    const baseHeight = state.baseHeight || sprite.height || 1;
    const padding = Math.max(12, Math.min(rendererWidth, rendererHeight) * 0.05);
    const availableWidth = Math.max(1, rendererWidth - padding * 2);
    const availableHeight = Math.max(1, rendererHeight - padding * 2);

    const fitWidthScale = availableWidth / baseWidth;
    const fitHeightScale = availableHeight / baseHeight;
    const rawFitScale = Math.min(fitWidthScale, fitHeightScale, MAX_SCALE);
    const fitScale = Math.max(MIN_SCALE, rawFitScale);
    const minScale = Math.min(fitScale, Math.max(MIN_SCALE, fitScale * 0.5));
    const maxScale = Math.min(MAX_SCALE, Math.max(fitScale * 2, minScale * 2));

    state.fitScale = fitScale;
    state.minScale = minScale;
    state.maxScale = maxScale;

    let scale = state.scale;
    if (!Number.isFinite(scale) || scale <= 0) {
      scale = fitScale;
    }
    scale = Math.min(maxScale, Math.max(minScale, scale));
    if (scale !== state.scale) {
      state.scale = scale;
    }

    sprite.scale.set(scale);

    const scaledWidth = baseWidth * scale;
    const scaledHeight = baseHeight * scale;

    const clampAxis = (value: number, total: number, viewport: number): number => {
      if (!(total > 0) || !(viewport > 0)) {
        return value;
      }
      if (total <= viewport) {
        return Math.max(0, (viewport - total) / 2);
      }
      const overscroll = computeOverscrollPx(viewport, viewport);
      const min = viewport - total - overscroll;
      const max = 0 + overscroll;
      return Math.min(max, Math.max(min, value));
    };

    const nextX = state.positioned ? sprite.x - padding : 0;
    const nextY = state.positioned ? sprite.y - padding : 0;

    sprite.x = clampAxis(nextX, scaledWidth, availableWidth) + padding;
    sprite.y = clampAxis(nextY, scaledHeight, availableHeight) + padding;
    state.positioned = true;
  }, []);

  const closeOverlay = useCallback((): void => {
    overlayTokenRef.current += 1;
    const overlay = overlayRef.current;
    const state = overlayStateRef.current;
    const app = appRef.current;
    if (!overlay || !state) {
      return;
    }
    const backlink = backlinkRef.current;
    if (backlink && backlink.applicableTo === state.mapLabel) {
      backlinkRef.current = backlink.previous ?? null;
    }
    if (typeof window !== "undefined" && state.keyHandler) {
      window.removeEventListener("keydown", state.keyHandler);
    }
    if (app) {
      rendererOff(app, "resize", positionOverlayContents);
    }
    if (state.objectContainer) {
      const removedSprites = state.objectContainer.removeChildren();
      for (const child of removedSprites) {
        if (typeof (child as { destroy?: () => void }).destroy === "function") {
          (child as { destroy: () => void }).destroy();
        }
      }
      if (state.objectContainer.parent === state.sprite) {
        state.sprite.removeChild(state.objectContainer);
      }
      state.objectContainer.destroy({ children: true });
    }
    if (state.spriteIssueHighlight) {
      try {
        state.spriteIssueHighlight.destroy({ children: true });
      } catch {
        /* ignore */
      }
      state.spriteIssueHighlight = undefined;
    }
    state.objectMarkers = [];
    for (const marker of state.markers) {
      marker.graphic.removeAllListeners();
      marker.graphic.destroy();
    }
    const children = overlay.removeChildren();
    for (const child of children) {
      if (typeof (child as { destroy?: () => void }).destroy === "function") {
        (child as { destroy: () => void }).destroy();
      }
    }
    disposeAnimationResource(state.resource);
    overlay.visible = false;
    overlayStateRef.current = null;
    const world = worldRef.current;
    if (world) {
      world.visible = true;
    }
  }, [positionOverlayContents]);


  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    return () => {
      const cache = objectSpriteCacheRef.current;
      if (cache) {
        cache.destroy();
        objectSpriteCacheRef.current = null;
      }
      objectCacheSourceRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (editing && overlayStateRef.current) {
      closeOverlay();
    }
  }, [editing, closeOverlay]);

  useEffect(() => {
    if (overlayStateRef.current) {
      closeOverlay();
    }
  }, [closeOverlay, resolveAssetHref]);

  const clampWorldToBounds = useCallback((): void => {
    const app = appRef.current;
    const world = worldRef.current;
    const bounds = boundsRef.current;
    const scale = scaleRef.current;
    if (!app || !world || !bounds || !isFiniteNumber(scale) || scale <= 0) {
      return;
    }
  const { width: viewWidth, height: viewHeight } = getEffectiveViewSize(app);
    const overscroll = computeOverscrollPx(viewWidth, viewHeight);
    const scaledWidth = bounds.width * scale;
    const scaledHeight = bounds.height * scale;

    if (!(scaledWidth > 0)) {
      world.x = 0;
    } else if (scaledWidth <= viewWidth) {
      world.x = (viewWidth - scaledWidth) / 2;
    } else {
      const minX = viewWidth - scaledWidth - overscroll;
      const maxX = 0 + overscroll;
      world.x = Math.min(maxX, Math.max(minX, world.x));
    }

    if (!(scaledHeight > 0)) {
      world.y = 0;
    } else if (scaledHeight <= viewHeight) {
      world.y = (viewHeight - scaledHeight) / 2;
    } else {
      const extraBottom = computeBottomExtraPx(viewHeight);
      const minY = viewHeight - scaledHeight - overscroll - extraBottom; // allow more past bottom
      const maxY = 0 + overscroll; // top overscroll
      world.y = Math.min(maxY, Math.max(minY, world.y));
    }
  }, []);

  const persistViewState = useCallback((): void => {
    const app = appRef.current;
    const world = worldRef.current;
    const bounds = boundsRef.current;
    const scale = scaleRef.current;
    if (!app || !world || !bounds || !isFiniteNumber(scale) || scale <= 0) {
      return;
    }
    const renderer = app.renderer;
    const centerX = (-world.x + renderer.width / 2) / scale;
    const centerY = (-world.y + renderer.height / 2) / scale;
    const normalizedX = bounds.width > 0 ? clampUnit(centerX / bounds.width, 0.5) : 0.5;
    const normalizedY = bounds.height > 0 ? clampUnit(centerY / bounds.height, 0.5) : 0.5;
    writeStoredViewState({
      version: VIEW_STATE_VERSION,
      scale,
      center: { x: normalizedX, y: normalizedY },
    });
  }, []);

  const schedulePersistViewState = useCallback((): void => {
    if (typeof window === "undefined") {
      return;
    }
    if (persistTimerRef.current !== null) {
      window.clearTimeout(persistTimerRef.current);
    }
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = null;
      persistViewState();
    }, 120);
  }, [persistViewState]);

  const focusWorldOn = useCallback(
    (worldX: number, worldY: number): void => {
      const app = appRef.current;
      const world = worldRef.current;
      const scale = scaleRef.current;
      if (!app || !world || !isFiniteNumber(scale) || scale <= 0) {
        return;
      }
      const { width: viewW, height: viewH } = getEffectiveViewSize(app);
      world.x = viewW / 2 - worldX * scale;
      world.y = viewH / 2 - worldY * scale;
      clampWorldToBounds();
      schedulePersistViewState();
    },
    [clampWorldToBounds, schedulePersistViewState]
  );

  const resolveTargetLabel = useCallback((target: MapWarp["target"] | null | undefined): string | null => {
    if (!target) {
      return null;
    }
    const direct = typeof target.mapLabel === "string" ? target.mapLabel.trim() : "";
    if (direct.length > 0) {
      return direct;
    }
    const constant = typeof target.mapConstant === "string" ? target.mapConstant.trim() : "";
    if (constant.length === 0) {
      return null;
    }
    const lookup = warpMetadataRef.current?.constantLookup ?? {};
    const mapped = lookup[constant];
    if (typeof mapped === "string" && mapped.trim().length > 0) {
      return mapped.trim();
    }
    return null;
  }, []);

  const getMapMetadata = useCallback((mapLabel: string | null | undefined) => {
    if (typeof mapLabel !== "string" || mapLabel.trim().length === 0) {
      return null;
    }
    const metadata = warpMetadataRef.current?.maps?.[mapLabel];
    return metadata ?? null;
  }, []);

  const getWarpMetadata = useCallback(
    (mapLabel: string | null | undefined, warpIndex: number | null | undefined) => {
      if (typeof warpIndex !== "number" || !Number.isFinite(warpIndex)) {
        return null;
      }
      const mapMeta = getMapMetadata(mapLabel);
      if (!mapMeta || !Array.isArray(mapMeta.warps)) {
        return null;
      }
      return mapMeta.warps.find((item) => item.index === warpIndex) ?? null;
    },
    [getMapMetadata]
  );

  const getCollisionMetadata = useCallback(
    (mapLabel: string | null | undefined) => {
      if (typeof mapLabel !== "string" || mapLabel.trim().length === 0) {
        return null;
      }
      const collision = warpMetadataRef.current?.maps?.[mapLabel]?.collision ?? null;
      if (!collision || collision.cellBytes.length === 0) {
        return null;
      }
      return collision;
    },
    []
  );

  const findWorldEntry = useCallback((mapLabel: string | null | undefined): SyncedAnimation | null => {
    if (typeof mapLabel !== "string" || mapLabel.trim().length === 0) {
      return null;
    }
    return animationsRef.current.find((item) => item.placement.label === mapLabel) ?? null;
  }, []);

  const focusEntryOnWarp = useCallback(
    (entry: SyncedAnimation | null, coordinates: { xCells: number | null; yCells: number | null } | null | undefined): void => {
      if (!entry) {
        return;
      }
      const cellSize = computeCellSize();
      if (
        coordinates &&
        typeof coordinates.xCells === "number" && Number.isFinite(coordinates.xCells) &&
        typeof coordinates.yCells === "number" && Number.isFinite(coordinates.yCells)
      ) {
        const worldX = entry.sprite.x + coordinates.xCells * cellSize + cellSize / 2;
        const worldY = entry.sprite.y + coordinates.yCells * cellSize + cellSize / 2;
        focusWorldOn(worldX, worldY);
        return;
      }
      const worldX = entry.sprite.x + entry.placement.widthPx / 2;
      const worldY = entry.sprite.y + entry.placement.heightPx / 2;
      focusWorldOn(worldX, worldY);
    },
    [computeCellSize, focusWorldOn]
  );

  const refreshOverlayObjects = useCallback((): void => {
    const state = overlayStateRef.current;
    if (!state) {
      return;
    }
    const metadata = objectMetadataRef.current;
    const cache = objectSpriteCacheRef.current;
    const sprite = state.sprite;

    if (!state.collisionHelper) {
      const collisionMeta = getCollisionMetadata(state.mapLabel);
      const permissions = warpMetadataRef.current?.collisionPermissions ?? null;
      state.collisionHelper = createCollisionHelper(collisionMeta, permissions);
    }

    const disposeContainer = (): void => {
      if (!state.objectContainer) {
        return;
      }
      const removedSprites = state.objectContainer.removeChildren();
      for (const child of removedSprites) {
        if (typeof (child as { destroy?: () => void }).destroy === "function") {
          (child as { destroy: () => void }).destroy();
        }
      }
      if (state.objectContainer.parent === sprite) {
        sprite.removeChild(state.objectContainer);
      }
      state.objectContainer.destroy({ children: true });
      state.objectContainer = null;
      state.objectMarkers = [];
    };

    if (!metadata || !cache) {
      disposeContainer();
      return;
    }

    const mapData = metadata.maps?.[state.mapLabel];
    if (!mapData || !Array.isArray(mapData.objects) || mapData.objects.length === 0) {
      disposeContainer();
      return;
    }

    const metadataBlockSize = Number.isFinite(metadata.blockPixelSize) && metadata.blockPixelSize > 0
      ? Math.abs(metadata.blockPixelSize)
      : 32;
    const cellsPerBlock = Number.isFinite(metadata.cellsPerBlock) && metadata.cellsPerBlock > 0
      ? Math.trunc(metadata.cellsPerBlock)
      : 2;
    const baseCellPixelSize = Number.isFinite(metadata.eventCellPixelSize) && metadata.eventCellPixelSize > 0
      ? Math.abs(metadata.eventCellPixelSize)
      : Math.max(1, Math.trunc(metadataBlockSize / Math.max(1, cellsPerBlock)));

    const widthBlocks = Number.isFinite(mapData.widthBlocks) && mapData.widthBlocks && mapData.widthBlocks > 0
      ? Math.abs(mapData.widthBlocks)
      : null;
    const baseWidth = state.baseWidth || sprite.texture.width || sprite.width || 1;
    let atlasBlockPixelSize: number;
    if (widthBlocks && baseWidth > 0) {
      atlasBlockPixelSize = baseWidth / widthBlocks;
    } else if (Number.isFinite(metadata.blockPixelSize) && metadata.blockPixelSize > 0) {
      atlasBlockPixelSize = Math.abs(metadata.blockPixelSize);
    } else if (atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize > 0) {
      atlasBlockPixelSize = Math.abs(atlas.blockPixelSize);
    } else {
      atlasBlockPixelSize = 32;
    }
    if (!(atlasBlockPixelSize > 0)) {
      atlasBlockPixelSize = 32;
    }

    const placementContext: PlacementContext = {
      atlasBlockPixelSize,
      metadataBlockPixelSize: metadataBlockSize,
      cellsPerBlock,
      eventCellPixelSize: baseCellPixelSize,
    };
    const pixelScale = metadataBlockSize !== 0 ? atlasBlockPixelSize / metadataBlockSize : 1;
    const atlasCellPixelSize = cellsPerBlock > 0 ? atlasBlockPixelSize / cellsPerBlock : atlasBlockPixelSize;

    let container = state.objectContainer;
    if (!container) {
      container = new Container();
      container.eventMode = "none";
      container.interactiveChildren = false;
      container.zIndex = 5;
      sprite.addChild(container);
      state.objectContainer = container;
    }

    const removedSprites = container.removeChildren();
    for (const child of removedSprites) {
      if (typeof (child as { destroy?: () => void }).destroy === "function") {
        (child as { destroy: () => void }).destroy();
      }
    }

    state.objectMarkers = [];

    for (const objectEntry of mapData.objects) {
      if (!isObjectVisibleAtTime(objectEntry, timeOfDay)) {
        continue;
      }
      if (objectEntry.eventFlagSet) {
        continue;
      }
      if (!isObjectWithinMapBounds(objectEntry, mapData, cellsPerBlock, baseCellPixelSize)) {
        continue;
      }
      const spriteKey = objectEntry.sprite.constant;
      if (!spriteKey) {
        continue;
      }
      const spriteDef = metadata.sprites[spriteKey];
      if (!spriteDef) {
        continue;
      }
      const facingKey = resolveFacingConstant(objectEntry, metadata);
      if (!facingKey) {
        continue;
      }
      const paletteName = objectEntry.paletteOverride.constant ?? spriteDef.defaultPalette;
      let baseFrame: SpriteFrameRef | null = null;
      let frameSet: MovementFrameSet | null = null;
      let iconFrameDurationMs: number | null = null;

      if (spriteKey === "SPRITE_MON_ICON") {
        const iconResult = buildPokemonIconFrameSet(
          cache,
          objectEntry,
          spriteDef,
          facingKey,
          paletteName ?? null,
          "overlay",
        );
        baseFrame = iconResult.baseFrame;
        frameSet = iconResult.frameSet;
        iconFrameDurationMs = iconResult.frameDurationMs;
      } else {
        const record = cache.getFacingTexture(spriteKey, facingKey, paletteName);
        if (!record) {
          continue;
        }
        baseFrame = createSpriteFrameRef(facingKey, record);
        frameSet = buildMovementFrameSet(cache, spriteKey, spriteDef, paletteName, facingKey, record);
      }

      if (!baseFrame || !frameSet) {
        continue;
      }
      const spriteInstance = new Sprite(baseFrame.texture);
      spriteInstance.eventMode = "none";
      spriteInstance.cursor = "auto";
      const { x: baseX, y: baseY } = computeObjectPosition(objectEntry, placementContext);
      const offsetX = baseFrame.offsetX * pixelScale;
      const offsetY = baseFrame.offsetY * pixelScale;
      spriteInstance.x = baseX + offsetX;
      spriteInstance.y = baseY + offsetY;
      spriteInstance.scale.set(pixelScale);
      container.addChild(spriteInstance);
      const movementSummary = computeMovementSummaryForObject(objectEntry, state.collisionHelper);
      let animator = createMovementAnimator(movementSummary, objectEntry, frameSet);
      if (!animator && spriteKey === "SPRITE_MON_ICON" && iconFrameDurationMs) {
        const idleAnimator = createPokemonIconAnimator(objectEntry, frameSet, iconFrameDurationMs);
        if (idleAnimator) {
          animator = idleAnimator;
        }
      }
      const stepCount = animator?.kind === "path" ? animator.stepCount : null;
      state.objectMarkers.push({
        object: objectEntry,
        sprite: spriteInstance,
        movementSummary,
        animator,
        basePosition: { x: baseX, y: baseY },
        spriteOffset: { x: offsetX, y: offsetY },
        cellPixelSize: atlasCellPixelSize,
        frameSet,
        currentFrameKey: baseFrame.key,
        spriteScale: pixelScale,
        lastDirection: frameSet?.defaultDirection ?? resolveDirectionFromFacingKey(facingKey),
        currentStepIndex: stepCount && stepCount > 0 ? 0 : null,
        stepProgress: 0,
        stepCount,
      });
    }

    const overlayElapsed = appRef.current?.ticker?.lastTime ?? 0;
    for (const marker of state.objectMarkers) {
      updateMarkerAnimation(marker, overlayElapsed);
    }

    if (container.children.length === 0) {
      if (container.parent === sprite) {
        sprite.removeChild(container);
      }
      container.destroy({ children: true });
      state.objectContainer = null;
      state.objectMarkers = [];
      return;
    }

    sprite.sortChildren();
  }, [atlas, timeOfDay, getCollisionMetadata]);

  const openOverlay = useCallback(
    async (
      mapLabel: string,
      highlight?: {
        xCells?: number | null;
        yCells?: number | null;
      }
    ): Promise<void> => {
      if (!resolveAssetHref) {
        return;
      }
      const overlay = overlayRef.current;
      const app = appRef.current;
      if (!overlay || !app) {
        return;
      }
      // Fast path: if the requested overlay is already open for this map, reuse it
      const existing = overlayStateRef.current;
      if (existing && existing.mapLabel === mapLabel) {
        overlay.visible = true;
        const world = worldRef.current;
        if (world) world.visible = false;
        // Update optional tile highlight
        if (highlight && typeof highlight.xCells === "number" && typeof highlight.yCells === "number") {
          if (existing.highlight) {
            try { existing.highlight.destroy({ children: true }); } catch { /* ignore */ }
          }
          const cellSize = existing.cellSize || computeCellSize();
          const g = new Graphics();
          const margin = Math.max(0, cellSize * 0.1);
          const radius = Math.max(4, cellSize * 0.25);
          g.lineStyle(Math.max(1, cellSize * 0.1), 0xf1c40f, 0.95);
          g.beginFill(0xf39c12, 0.3);
          g.drawRoundedRect(margin, margin, cellSize - margin * 2, cellSize - margin * 2, radius);
          g.endFill();
          g.x = (highlight.xCells ?? 0) * cellSize;
          g.y = (highlight.yCells ?? 0) * cellSize;
          g.eventMode = "none";
          g.zIndex = 4;
          existing.sprite.addChild(g);
          existing.sprite.sortChildren();
          existing.highlight = g;
        }
        rendererOn(app, "resize", positionOverlayContents);
        positionOverlayContents();
        return;
      }
      const assetUrl = resolveAssetHref(mapLabel);
      if (!assetUrl) {
        return;
      }
      const token = overlayTokenRef.current + 1;
      overlayTokenRef.current = token;
      try {
        const resource = await loadMapAnimation(assetUrl);
        if (overlayTokenRef.current !== token) {
          disposeAnimationResource(resource);
          return;
        }
        closeOverlay();
        if (!overlayRef.current) {
          disposeAnimationResource(resource);
          return;
        }
        const background = new Graphics();
        background.eventMode = "static";
        background.cursor = "pointer";
        background.on("pointertap", () => {
          closeOverlay();
        });

        const sprite = new AnimatedSprite(resource.textures);
        sprite.loop = true;
        sprite.autoUpdate = false;
        sprite.animationSpeed = 0;
        sprite.gotoAndStop(0);
        sprite.eventMode = "static";
        sprite.on("pointertap", (event) => {
          event.stopPropagation();
        });

        sprite.sortableChildren = true;

        overlay.addChild(background);
        overlay.addChild(sprite);

        const objectContainer = new Container();
        objectContainer.eventMode = "none";
        objectContainer.interactiveChildren = false;
        objectContainer.zIndex = 5;
        sprite.addChild(objectContainer);

  const cellSize = computeCellSize();
  const baseAlpha = 0.9;
        const markers: WarpMarkerEntry[] = [];
        const mapMeta = getMapMetadata(mapLabel);
        const collisionMeta = getCollisionMetadata(mapLabel);
        const permissions = warpMetadataRef.current?.collisionPermissions ?? null;
        const collisionHelper = createCollisionHelper(collisionMeta, permissions);

        if (mapMeta && Array.isArray(mapMeta.warps)) {
          for (const warp of mapMeta.warps) {
            const { xCells, yCells } = warp;
            if (typeof xCells !== "number" || !Number.isFinite(xCells) || typeof yCells !== "number" || !Number.isFinite(yCells)) {
              continue;
            }
            const graphic = new Graphics();
            const margin = Math.max(0, cellSize * 0.1);
            const radius = Math.max(4, cellSize * 0.25);
            graphic.beginFill(0x1abc9c, 0.35);
            graphic.lineStyle(Math.max(1, cellSize * 0.08), 0xffffff, 0.9);
            graphic.drawRoundedRect(margin, margin, cellSize - margin * 2, cellSize - margin * 2, radius);
            graphic.endFill();
            graphic.alpha = baseAlpha;
            graphic.x = xCells * cellSize;
            graphic.y = yCells * cellSize;
            graphic.eventMode = "static";
            graphic.cursor = "pointer";
            graphic.on("pointertap", (event) => {
              event.stopPropagation();
              if (typeof event.preventDefault === "function") {
                event.preventDefault();
              }
              const handler = handleOverlayWarpRef.current;
              if (handler) {
                handler(warp);
              }
            });
            graphic.on("pointerover", () => {
              graphic.alpha = 1;
            });
            graphic.on("pointerout", () => {
              graphic.alpha = baseAlpha;
            });
            graphic.zIndex = 10;
            sprite.addChild(graphic);
            markers.push({ warp, graphic, localX: xCells * cellSize, localY: yCells * cellSize });
          }
        }

        let highlightGraphic: Graphics | undefined;
        if (
          highlight &&
          typeof highlight.xCells === "number" && Number.isFinite(highlight.xCells) &&
          typeof highlight.yCells === "number" && Number.isFinite(highlight.yCells)
        ) {
          highlightGraphic = new Graphics();
          const margin = Math.max(0, cellSize * 0.1);
          const radius = Math.max(4, cellSize * 0.25);
          highlightGraphic.lineStyle(Math.max(1, cellSize * 0.1), 0xf1c40f, 0.95);
          highlightGraphic.beginFill(0xf39c12, 0.3);
          highlightGraphic.drawRoundedRect(margin, margin, cellSize - margin * 2, cellSize - margin * 2, radius);
          highlightGraphic.endFill();
          highlightGraphic.x = highlight.xCells * cellSize;
          highlightGraphic.y = highlight.yCells * cellSize;
          highlightGraphic.eventMode = "none";
          highlightGraphic.interactive = false;
          highlightGraphic.cursor = "auto";
          highlightGraphic.zIndex = 4;
          sprite.addChild(highlightGraphic);
        }

        sprite.sortChildren();

        const frame = resource.textures[0];
        const baseWidth = frame?.width ?? sprite.width;
        const baseHeight = frame?.height ?? sprite.height;

        const keyHandler = (event: KeyboardEvent): void => {
          if (event.key === "Escape") {
            if (typeof event.preventDefault === "function") {
              event.preventDefault();
            }
            closeOverlay();
          }
        };

        overlay.visible = true;
        overlayStateRef.current = {
          mapLabel,
          sprite,
          resource,
          background,
          markers,
          highlight: highlightGraphic,
          baseWidth,
          baseHeight,
          cellSize,
          baseAlpha,
          keyHandler,
          objectContainer,
          objectMarkers: [],
          collisionHelper,
          scale: Number.NaN,
          fitScale: 1,
          minScale: MIN_SCALE,
          maxScale: MAX_SCALE,
          positioned: false,
        };
        const elapsed = Math.max(0, app.ticker.lastTime - syncStartRef.current);
        const initialFrame = frameIndexForTime(elapsed, resource.frameDurations, resource.loopDuration);
        if (sprite.currentFrame !== initialFrame) {
          sprite.gotoAndStop(initialFrame);
        }
        refreshOverlayObjects();
        const world = worldRef.current;
        if (world) {
          world.visible = false;
        }
        if (typeof window !== "undefined") {
          window.addEventListener("keydown", keyHandler);
        }
  rendererOff(app, "resize", positionOverlayContents);
  rendererOn(app, "resize", positionOverlayContents);
        positionOverlayContents();
      } catch (err) {
        if (overlayTokenRef.current === token) {
          console.error(`Failed to open overlay for ${mapLabel}`, err);
        }
      }
    },
    [closeOverlay, computeCellSize, getMapMetadata, getCollisionMetadata, positionOverlayContents, refreshOverlayObjects, resolveAssetHref]
  );

  const handleWarpMarkerTap = useCallback(
    (entry: SyncedAnimation, warp: MapWarp): void => {
      if (editing) {
        return;
      }
      highlightWarpMarker(entry, warp.index);
      const target = warp.target;
      const targetLabel = resolveTargetLabel(target);
      if (targetLabel) {
        const targetEntry = findWorldEntry(targetLabel);
        if (targetEntry) {
          focusEntryOnWarp(targetEntry, target);
          if (typeof target.warpIndex === "number") {
            highlightWarpMarker(targetEntry, target.warpIndex);
          }
          backlinkRef.current = null;
          return;
        }
        const sourceMeta = getMapMetadata(entry.placement.label);
        backlinkRef.current = {
          applicableTo: targetLabel,
          mapLabel: entry.placement.label,
          mapConstant: sourceMeta?.mapConstant ?? null,
          warpIndex: warp.index,
          previous: backlinkRef.current,
        };
        void openOverlay(targetLabel, {
          xCells: target.xCells,
          yCells: target.yCells,
        });
        return;
      }
      focusEntryOnWarp(entry, warp);
    },
    [editing, findWorldEntry, focusEntryOnWarp, getMapMetadata, highlightWarpMarker, openOverlay, resolveTargetLabel]
  );

  const handleOverlayWarp = useCallback(
    (warp: MapWarp): void => {
      const state = overlayStateRef.current;
      if (!state) {
        return;
      }
      const currentMapLabel = state.mapLabel;
      const target = warp.target;
      const targetLabel = resolveTargetLabel(target);
      const highlightOverlayMarker = (warpIndex: number): void => {
        const entry = overlayStateRef.current;
        if (!entry) {
          return;
        }
        const marker = entry.markers.find((item) => item.warp.index === warpIndex);
        if (!marker) {
          return;
        }
        marker.graphic.alpha = 1;
        marker.graphic.scale.set(1.15);
        if (typeof window !== "undefined") {
          window.setTimeout(() => {
            const active = overlayStateRef.current;
            if (!active || active.mapLabel !== entry.mapLabel) {
              return;
            }
            if ((marker.graphic as { destroyed?: boolean }).destroyed) {
              return;
            }
            marker.graphic.alpha = entry.baseAlpha;
            marker.graphic.scale.set(1);
          }, 900);
          return;
        }
        marker.graphic.alpha = entry.baseAlpha;
        marker.graphic.scale.set(1);
      };

      if (
        typeof target.warpIndex === "number" &&
        target.warpIndex >= 0 &&
        (!targetLabel || targetLabel === currentMapLabel)
      ) {
        // In-map warp: just highlight the destination tile and stay within the same overlay.
        highlightOverlayMarker(target.warpIndex);
        return;
      }

      if (typeof target.warpIndex === "number" && target.warpIndex === -1) {
        const backlink = backlinkRef.current;
        if (!backlink || backlink.applicableTo !== currentMapLabel) {
          return;
        }
        backlinkRef.current = backlink.previous ?? null;
        const fallbackLabel = backlink.mapLabel;
        const fallbackEntry = findWorldEntry(fallbackLabel);
        if (fallbackEntry) {
          closeOverlay();
          const fallbackWarp = getWarpMetadata(fallbackLabel, backlink.warpIndex);
          focusEntryOnWarp(fallbackEntry, fallbackWarp ?? null);
          highlightWarpMarker(fallbackEntry, backlink.warpIndex);
          return;
        }
        const fallbackWarp = getWarpMetadata(fallbackLabel, backlink.warpIndex);
        void openOverlay(fallbackLabel, {
          xCells: fallbackWarp?.xCells ?? null,
          yCells: fallbackWarp?.yCells ?? null,
        });
        return;
      }

      if (targetLabel) {
        const targetEntry = findWorldEntry(targetLabel);
        if (targetEntry) {
          const backlink = backlinkRef.current;
          if (backlink && backlink.applicableTo === currentMapLabel) {
            backlinkRef.current = backlink.previous ?? null;
          }
          closeOverlay();
          focusEntryOnWarp(targetEntry, target);
          if (typeof target.warpIndex === "number") {
            highlightWarpMarker(targetEntry, target.warpIndex);
          }
          return;
        }
        const sourceMeta = getMapMetadata(currentMapLabel);
        backlinkRef.current = {
          applicableTo: targetLabel,
          mapLabel: currentMapLabel,
          mapConstant: sourceMeta?.mapConstant ?? null,
          warpIndex: warp.index,
          previous: backlinkRef.current,
        };
        void openOverlay(targetLabel, {
          xCells: target.xCells,
          yCells: target.yCells,
        });
        return;
      }

      if (typeof target.warpIndex === "number" && target.warpIndex >= 0) {
        highlightOverlayMarker(target.warpIndex);
      }
    },
    [closeOverlay, findWorldEntry, focusEntryOnWarp, getMapMetadata, getWarpMetadata, highlightWarpMarker, openOverlay, resolveTargetLabel]
  );

  useEffect(() => {
    handleOverlayWarpRef.current = handleOverlayWarp;
    return () => {
      if (handleOverlayWarpRef.current === handleOverlayWarp) {
        handleOverlayWarpRef.current = null;
      }
    };
  }, [handleOverlayWarp]);

  const refreshWarpMarkers = useCallback((): void => {
    const metadata = warpMetadataRef.current;
    const cellSize = computeCellSize();
    const baseAlpha = editing ? 0.5 : 0.9;
    clearHighlightTimers();
    const warpsLayer = warpsLayerRef.current;
    const hasWarpsLayer = Boolean(warpsLayer);
    for (const entry of animationsRef.current) {
      for (const marker of entry.warpMarkers) {
        marker.graphic.removeAllListeners();
        marker.graphic.destroy();
      }
      entry.warpMarkers = [];
      const mapLabel = entry.placement.label;
      const mapMeta = metadata?.maps?.[mapLabel];
      if (!mapMeta || !Array.isArray(mapMeta.warps) || mapMeta.warps.length === 0) {
        continue;
      }
      for (const warp of mapMeta.warps) {
        const { xCells, yCells } = warp;
        if (typeof xCells !== "number" || !Number.isFinite(xCells) || typeof yCells !== "number" || !Number.isFinite(yCells)) {
          continue;
        }
        const graphic = new Graphics();
        const margin = Math.max(0, cellSize * 0.1);
        const radius = Math.max(4, cellSize * 0.25);
        graphic.beginFill(0x1abc9c, 0.35);
        graphic.lineStyle(Math.max(1, cellSize * 0.08), 0xffffff, 0.9);
        graphic.drawRoundedRect(margin, margin, cellSize - margin * 2, cellSize - margin * 2, radius);
        graphic.endFill();
        graphic.alpha = baseAlpha;
        const localX = xCells * cellSize;
        const localY = yCells * cellSize;
        // Position in world coordinates if using the global warps layer; otherwise relative to the sprite
        if (hasWarpsLayer && warpsLayer) {
          graphic.x = (entry.sprite?.x ?? 0) + localX;
          graphic.y = (entry.sprite?.y ?? 0) + localY;
        } else {
          graphic.x = localX;
          graphic.y = localY;
        }
        graphic.eventMode = editing ? "none" : "static";
        graphic.cursor = editing ? "not-allowed" : "pointer";
        graphic.on("pointertap", (event) => {
          if (editing) {
            return;
          }
          event.stopPropagation();
          if (typeof event.preventDefault === "function") {
            event.preventDefault();
          }
          handleWarpMarkerTap(entry, warp);
        });
        graphic.on("pointerover", () => {
          if (editing) {
            return;
          }
          graphic.alpha = 1;
        });
        graphic.on("pointerout", () => {
          if (editing) {
            return;
          }
          graphic.alpha = baseAlpha;
        });
        graphic.zIndex = 10;
        if (hasWarpsLayer && warpsLayer) {
          warpsLayer.addChild(graphic);
        } else {
          entry.sprite.addChild(graphic);
        }
        entry.warpMarkers.push({ warp, graphic, localX, localY });
      }
      if (hasWarpsLayer && warpsLayer) {
        warpsLayer.sortChildren();
      } else {
        entry.sprite.sortChildren();
      }
    }
  }, [computeCellSize, editing, handleWarpMarkerTap]);

  const refreshObjectSprites = useCallback((): void => {
    const metadata = objectMetadataRef.current;
    const cache = objectSpriteCacheRef.current;
    const atlasBlockSize = atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize > 0
      ? Math.abs(atlas.blockPixelSize)
      : 32;

    if (!metadata || !cache) {
      for (const entry of animationsRef.current) {
        if (entry.objectContainer) {
          const removedChildren = entry.objectContainer.removeChildren();
          for (const child of removedChildren) {
            if (typeof (child as { destroy?: () => void }).destroy === "function") {
              (child as { destroy: () => void }).destroy();
            }
          }
          entry.sprite.removeChild(entry.objectContainer);
          entry.objectContainer.destroy();
          entry.objectContainer = null;
        }
        entry.objectMarkers = [];
      }
      return;
    }

    cache.setTimeOfDay(timeOfDay);

    const metadataBlockSize = Number.isFinite(metadata.blockPixelSize) && metadata.blockPixelSize > 0
      ? Math.abs(metadata.blockPixelSize)
      : atlasBlockSize;
    const cellsPerBlock = Number.isFinite(metadata.cellsPerBlock) && metadata.cellsPerBlock > 0
      ? Math.trunc(metadata.cellsPerBlock)
      : 2;
    const baseCellPixelSize = Number.isFinite(metadata.eventCellPixelSize) && metadata.eventCellPixelSize > 0
      ? Math.abs(metadata.eventCellPixelSize)
      : Math.max(1, Math.trunc(metadataBlockSize / Math.max(1, cellsPerBlock)));
  const pixelScale = metadataBlockSize !== 0 ? atlasBlockSize / metadataBlockSize : 1;
  const atlasCellPixelSize = cellsPerBlock > 0 ? atlasBlockSize / cellsPerBlock : atlasBlockSize;
    const placementContext: PlacementContext = {
      atlasBlockPixelSize: atlasBlockSize,
      metadataBlockPixelSize: metadataBlockSize,
      cellsPerBlock,
      eventCellPixelSize: baseCellPixelSize,
    };

    for (const entry of animationsRef.current) {
      const collisionMeta = getCollisionMetadata(entry.placement.label);
      const permissions = warpMetadataRef.current?.collisionPermissions ?? null;
      entry.collisionHelper = createCollisionHelper(collisionMeta, permissions);

      let container = entry.objectContainer;
      if (!container) {
        container = new Container();
        container.eventMode = "none";
        container.interactiveChildren = false;
        container.zIndex = 5;
        entry.sprite.addChild(container);
        entry.objectContainer = container;
      }
      const removedChildren = container.removeChildren();
      for (const child of removedChildren) {
        if (typeof (child as { destroy?: () => void }).destroy === "function") {
          (child as { destroy: () => void }).destroy();
        }
      }
      entry.objectMarkers = [];

      const mapData = metadata.maps[entry.placement.label];
      if (!mapData || !Array.isArray(mapData.objects) || mapData.objects.length === 0) {
        if (container.children.length === 0) {
          entry.sprite.removeChild(container);
          container.destroy();
          entry.objectContainer = null;
        }
        continue;
      }

      for (const objectEntry of mapData.objects) {
        if (!isObjectVisibleAtTime(objectEntry, timeOfDay)) {
          continue;
        }
        if (objectEntry.eventFlagSet) {
          continue;
        }
        if (!isObjectWithinMapBounds(objectEntry, mapData, cellsPerBlock, baseCellPixelSize)) {
          continue;
        }
        const spriteKey = objectEntry.sprite.constant;
        if (!spriteKey) {
          continue;
        }
        const spriteDef = metadata.sprites[spriteKey];
        if (!spriteDef) {
          continue;
        }
        const facingKey = resolveFacingConstant(objectEntry, metadata);
        if (!facingKey) {
          continue;
        }
        const paletteName = objectEntry.paletteOverride.constant ?? spriteDef.defaultPalette;
        let baseFrame: SpriteFrameRef | null = null;
        let frameSet: MovementFrameSet | null = null;
        let iconFrameDurationMs: number | null = null;

        if (spriteKey === "SPRITE_MON_ICON") {
          const iconResult = buildPokemonIconFrameSet(
            cache,
            objectEntry,
            spriteDef,
            facingKey,
            paletteName ?? null,
            "world",
          );
          baseFrame = iconResult.baseFrame;
          frameSet = iconResult.frameSet;
          iconFrameDurationMs = iconResult.frameDurationMs;
        } else {
          const record = cache.getFacingTexture(spriteKey, facingKey, paletteName);
          if (!record) {
            continue;
          }
          baseFrame = createSpriteFrameRef(facingKey, record);
          frameSet = buildMovementFrameSet(cache, spriteKey, spriteDef, paletteName, facingKey, record);
        }

        if (!baseFrame || !frameSet) {
          continue;
        }

        const sprite = new Sprite(baseFrame.texture);
        sprite.eventMode = "none";
        sprite.cursor = "auto";
        const { x: baseX, y: baseY } = computeObjectPosition(objectEntry, placementContext);
        const offsetX = baseFrame.offsetX * pixelScale;
        const offsetY = baseFrame.offsetY * pixelScale;
        sprite.x = baseX + offsetX;
        sprite.y = baseY + offsetY;
        sprite.scale.set(pixelScale);
        container.addChild(sprite);
        const movementSummary = computeMovementSummaryForObject(objectEntry, entry.collisionHelper);
        let animator = createMovementAnimator(movementSummary, objectEntry, frameSet);
        if (!animator && spriteKey === "SPRITE_MON_ICON" && iconFrameDurationMs) {
          const idleAnimator = createPokemonIconAnimator(objectEntry, frameSet, iconFrameDurationMs);
          if (idleAnimator) {
            animator = idleAnimator;
          }
        }
        const stepCount = animator?.kind === "path" ? animator.stepCount : null;
        entry.objectMarkers.push({
          object: objectEntry,
          sprite,
          movementSummary,
          animator,
          basePosition: { x: baseX, y: baseY },
          spriteOffset: { x: offsetX, y: offsetY },
          cellPixelSize: atlasCellPixelSize,
          frameSet,
          currentFrameKey: baseFrame.key,
          spriteScale: pixelScale,
          lastDirection: frameSet?.defaultDirection ?? resolveDirectionFromFacingKey(facingKey),
          currentStepIndex: stepCount && stepCount > 0 ? 0 : null,
          stepProgress: 0,
          stepCount,
        });
      }

      const entryElapsed = appRef.current?.ticker?.lastTime ?? 0;
      for (const marker of entry.objectMarkers) {
        updateMarkerAnimation(marker, entryElapsed);
      }

      if (container.children.length === 0) {
        entry.sprite.removeChild(container);
        container.destroy();
        entry.objectContainer = null;
      }
      entry.sprite.sortChildren();
    }
  }, [atlas, timeOfDay, getCollisionMetadata]);

  useEffect(() => {
    const metadata = objectMetadata ?? null;
    objectMetadataRef.current = metadata;
    const cache = objectSpriteCacheRef.current;
    const currentSource = objectCacheSourceRef.current;
    if (!metadata) {
      objectCacheSourceRef.current = null;
      if (cache) {
        cache.destroy();
        objectSpriteCacheRef.current = null;
      }
      refreshObjectSprites();
      refreshOverlayObjects();
      return;
    }
    if (!cache || currentSource !== metadata) {
      if (cache) {
        cache.destroy();
      }
      const nextCache = new ObjectSpriteCache(metadata, timeOfDay);
      objectSpriteCacheRef.current = nextCache;
      objectCacheSourceRef.current = metadata;
    } else {
      cache.setTimeOfDay(timeOfDay);
    }
    refreshObjectSprites();
    refreshOverlayObjects();
  }, [objectMetadata, timeOfDay, refreshObjectSprites, refreshOverlayObjects]);

  const restoreViewState = useCallback((): boolean => {
    const stored = readStoredViewState();
    if (!stored) {
      return false;
    }
    const app = appRef.current;
    const world = worldRef.current;
    const bounds = boundsRef.current;
    if (!app || !world || !bounds) {
      return false;
    }
    const scale = clampScale(isFiniteNumber(stored.scale) ? stored.scale : 1);
    world.scale.set(scale);
    scaleRef.current = scale;
    const normalizedX = clampUnit(stored.center?.x, 0.5);
    const normalizedY = clampUnit(stored.center?.y, 0.5);
    const centerX = bounds.width > 0 ? normalizedX * bounds.width : 0;
    const centerY = bounds.height > 0 ? normalizedY * bounds.height : 0;
  const { width: viewW, height: viewH } = getEffectiveViewSize(app);
  world.x = viewW / 2 - centerX * scale;
  world.y = viewH / 2 - centerY * scale;
    clampWorldToBounds();
    persistViewState();
    return true;
  }, [clampWorldToBounds, persistViewState]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let destroyed = false;

    const boot = async (): Promise<void> => {
      const isMobile = (() => {
        if (typeof navigator === "undefined") return false;
        const ua = navigator.userAgent || "";
        return /Android|iPhone|iPad|iPod|Mobile|Silk\//i.test(ua);
      })();
      const targetResolution = (() => {
        const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
        // Cap resolution on mobile to reduce fill-rate; allow a bit higher on desktop
        return isMobile ? Math.min(1.5, Math.max(1, dpr)) : Math.min(2, Math.max(1, dpr));
      })();

      const app = new Application({
        backgroundAlpha: 0,
        resizeTo: container,
        // Disable antialias so canvas doesn't blur pixel-art edges when scaled.
        antialias: false,
        // Prefer integrated/low-power GPU on devices that support it.
        powerPreference: "low-power",
        // Lower internal backing resolution on high-DPR devices to reduce GPU load.
        resolution: targetResolution,
        hello: false,
      });
      if (destroyed) {
        app.destroy(true, { children: true });
        return;
      }
      container.appendChild(app.view as unknown as HTMLCanvasElement);
      appRef.current = app;
      const world = new Container();
      world.sortableChildren = true;
      app.stage.eventMode = "static";
      app.stage.hitArea = app.screen;
      world.eventMode = "static";
      world.interactiveChildren = true;
      app.stage.addChild(world);
      worldRef.current = world;
      const overlay = new Container();
      overlay.visible = false;
      overlay.sortableChildren = true;
      overlay.eventMode = "static";
      overlay.interactiveChildren = true;
      app.stage.addChild(overlay);
      overlayRef.current = overlay;
      // Add a dedicated warps overlay layer above all map sprites
      const warpsLayer = new Container();
      warpsLayer.sortableChildren = true;
      warpsLayer.eventMode = "static";
      warpsLayer.interactiveChildren = true;
      // Assign a very high zIndex so it renders atop any map sprite ordering
      warpsLayer.zIndex = 10_000_000_000;
      world.addChild(warpsLayer);
      world.sortChildren();
      warpsLayerRef.current = warpsLayer;
      setReady(true);

      // Cap FPS to reduce main-thread and GPU work, especially on mobile.
      try {
        app.ticker.maxFPS = isMobile ? 30 : 60;
      } catch {
        /* ignore if older pixi */
      }

      // Pause updates when the tab is hidden to avoid background CPU usage.
      const handleVisibility = (): void => {
        if (document.hidden) app.ticker.stop();
        else app.ticker.start();
      };
      document.addEventListener("visibilitychange", handleVisibility);
      // Ensure we clean up the listener when this effect unmounts/app is destroyed
      const cleanupVisibility = (): void => {
        document.removeEventListener("visibilitychange", handleVisibility);
      };
      // Attach cleanup to app destroy path as well
      (app.view as unknown as HTMLCanvasElement).addEventListener("_pixi_cleanup", cleanupVisibility, { once: true } as any);
    };

    boot().catch((err) => {
      console.error("Failed to initialise Pixi application", err);
    });

    return () => {
      destroyed = true;
      setReady(false);
      closeOverlay();
      clearHighlightTimers();
      const app = appRef.current;
      if (app) {
        // Fire a synthetic cleanup hook for any per-app listeners we attached above
        const view = app.view as unknown as HTMLCanvasElement;
        try {
          const evt = new Event("_pixi_cleanup");
          view.dispatchEvent(evt);
        } catch {
          /* noop */
        }
        app.destroy(true, { children: true });
        appRef.current = null;
      }
      const world = worldRef.current;
      if (world) {
        world.destroy({ children: true });
        worldRef.current = null;
      }
      overlayRef.current = null;
      warpsLayerRef.current = null;
      overlayStateRef.current = null;
      scaleRef.current = 1;
      boundsRef.current = null;
      resetViewRef.current = () => undefined;
      if (container.firstChild instanceof HTMLCanvasElement) {
        container.removeChild(container.firstChild);
      }
    };
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const world = worldRef.current;
    const app = appRef.current;
    if (!world || !app) {
      return;
    }

    const disposeAnimations = (): void => {
      clearHighlightTimers();
      const entries = animationsRef.current.splice(0, animationsRef.current.length);
      for (const entry of entries) {
        if (entry.objectContainer) {
          const removedChildren = entry.objectContainer.removeChildren();
          for (const child of removedChildren) {
            if (typeof (child as { destroy?: () => void }).destroy === "function") {
              (child as { destroy: () => void }).destroy();
            }
          }
          entry.objectContainer.destroy();
          entry.objectContainer = null;
        }
        entry.objectMarkers = [];
        spriteEntryMapRef.current.delete(entry.sprite);
        entry.sprite.destroy();
        for (const marker of entry.warpMarkers ?? []) {
          marker.graphic.removeAllListeners();
          marker.graphic.destroy();
        }
        entry.warpMarkers = [];
        disposeAnimationResource(entry.resource);
      }
    };

    const disposeChildren = (): void => {
      closeOverlay();
      disposeAnimations();
      const removed = world.removeChildren();
      for (const child of removed) {
        if (typeof (child as { destroy?: () => void }).destroy === "function") {
          child.destroy();
        }
      }
      // Recreate the global warps layer after clearing the world so future markers have a visible parent
      const warpsLayer = new Container();
      warpsLayer.sortableChildren = true;
      warpsLayer.eventMode = "static";
      warpsLayer.interactiveChildren = true;
      warpsLayer.zIndex = 10_000_000_000;
      world.addChild(warpsLayer);
      world.sortChildren();
      warpsLayerRef.current = warpsLayer;
    };

    let cancelled = false;
    disposeChildren();

    if (!atlas) {
      boundsRef.current = null;
      resetViewRef.current = () => undefined;
      return;
    }

    boundsRef.current = {
      width: atlas.bounds.width,
      height: atlas.bounds.height,
    };

    const resetView = (): void => {
      const bounds = boundsRef.current;
      if (!bounds) {
        scaleRef.current = 1;
        world.scale.set(1);
        world.position.set(0, 0);
        persistViewState();
        return;
      }
  const { width: viewWidth, height: viewHeight } = getEffectiveViewSize(app);
      const width = bounds.width || viewWidth || 1;
      const height = bounds.height || viewHeight || 1;
      const candidate = Math.min(viewWidth / width, viewHeight / height) || 1;
      const clamped = clampScale(candidate * 0.95);
      scaleRef.current = clamped;
      world.scale.set(clamped);
      const scaledWidth = width * clamped;
      const scaledHeight = height * clamped;
      world.x = (viewWidth - scaledWidth) / 2;
      world.y = (viewHeight - scaledHeight) / 2;
       clampWorldToBounds();
       persistViewState();
    };

    resetViewRef.current = resetView;

    const tasks = atlas.placements.map(async (placement: MapPlacement, index: number): Promise<AnimatedSprite | null> => {
      if (!placement.asset) {
        return null;
      }
      try {
        const resource = await loadMapAnimation(placement.asset);
        if (cancelled) {
          disposeAnimationResource(resource);
          return null;
        }
        const sprite = new AnimatedSprite(resource.textures);
        sprite.loop = true;
        sprite.autoUpdate = false;
        sprite.animationSpeed = 0;
        sprite.gotoAndStop(0);
        sprite.x = placement.x;
        sprite.y = placement.y;
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        sprite.sortableChildren = true;
        const neighborhoodId = typeof placement.metadata?.neighborhoodId === "string" ? placement.metadata.neighborhoodId : null;
        const neighborhoodZ = placement.metadata?.neighborhoodZ ?? 0;
        const localMapZ = Number.isFinite(placement.metadata?.mapZ as number)
          ? Math.trunc((placement.metadata?.mapZ as number) || 0)
          : index;
        sprite.zIndex = neighborhoodZ * 1_000_000 + localMapZ * 1_000 + index;
        world.addChild(sprite);
        world.sortChildren();
        const collisionMeta = getCollisionMetadata(placement.label);
        const permissions = warpMetadataRef.current?.collisionPermissions ?? null;
        const collisionHelper = createCollisionHelper(collisionMeta, permissions);
        const entry: SyncedAnimation = {
          sprite,
          resource,
          placement,
          order: index,
          neighborhoodId,
          warpMarkers: [],
          objectContainer: null,
          objectMarkers: [],
          collisionHelper,
        };
        animationsRef.current.push(entry);
        spriteEntryMapRef.current.set(sprite, entry);
        return sprite;
      } catch (err) {
        console.error(`Failed to load animation for ${placement.label}`, err);
        return null;
      }
    });

    Promise.all(tasks)
      .then((sprites: Array<AnimatedSprite | null>) => {
        if (cancelled) {
          sprites.forEach((sprite) => sprite?.destroy());
          return;
        }
        syncStartRef.current = app.ticker.lastTime;
        if (!restoreViewState()) {
          resetView();
        }
        applySpriteTransforms();
        refreshWarpMarkers();
        refreshObjectSprites();
        refreshOverlayObjects();
      })
      .catch((err) => {
        console.error("Failed to load map sprites", err);
      })
      .finally(() => {
        if (!cancelled) {
          app.resize();
        }
      });

    return () => {
      cancelled = true;
      disposeChildren();
    };
  }, [atlas, ready, clampWorldToBounds, persistViewState, restoreViewState, applySpriteTransforms, refreshOverlayObjects, refreshWarpMarkers, refreshObjectSprites, getCollisionMetadata]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    refreshWarpMarkers();
    refreshObjectSprites();
    refreshOverlayObjects();
    return () => {
      for (const entry of animationsRef.current) {
        for (const marker of entry.warpMarkers) {
          marker.graphic.removeAllListeners();
          marker.graphic.destroy();
        }
        entry.warpMarkers = [];
        if (entry.objectContainer) {
          const removedChildren = entry.objectContainer.removeChildren();
          for (const child of removedChildren) {
            if (typeof (child as { destroy?: () => void }).destroy === "function") {
              (child as { destroy: () => void }).destroy();
            }
          }
          entry.sprite.removeChild(entry.objectContainer);
          entry.objectContainer.destroy();
          entry.objectContainer = null;
        }
        entry.objectMarkers = [];
      }
    };
  }, [ready, refreshOverlayObjects, refreshWarpMarkers, refreshObjectSprites, warpMetadata, atlas, editing]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const app = appRef.current;
    if (!app) {
      return;
    }
    const ticker = app.ticker;
    const updateAnimations = (): void => {
      const elapsed = Math.max(0, ticker.lastTime - syncStartRef.current);
      const appInst = appRef.current;
      const world = worldRef.current;
      let cullX = 0, cullY = 0, cullW = 0, cullH = 0;
      if (appInst && world) {
        const worldScale = world.scale.x || 1;
        const viewX = -world.x / worldScale;
        const viewY = -world.y / worldScale;
        const viewW = appInst.renderer.width / worldScale;
        const viewH = appInst.renderer.height / worldScale;
        const margin = 256 / worldScale;
        cullX = viewX - margin;
        cullY = viewY - margin;
        cullW = viewW + margin * 2;
        cullH = viewH + margin * 2;
      }
      const rectsIntersect = (ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean =>
        ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

      for (const entry of animationsRef.current) {
        // Culling based on sprite position and first frame dimensions
        const texW = entry.resource.textures[0]?.width ?? entry.sprite.width;
        const texH = entry.resource.textures[0]?.height ?? entry.sprite.height;
        const isVisible = rectsIntersect(entry.sprite.x, entry.sprite.y, texW, texH, cullX, cullY, cullW, cullH);
        if (entry.visible !== isVisible) {
          entry.visible = isVisible;
          entry.sprite.renderable = isVisible;
        }

        if (entry.visible === false) {
          // Hide and skip updates for offscreen content
          for (const wm of entry.warpMarkers) wm.graphic.renderable = false;
          for (const om of entry.objectMarkers) om.sprite.renderable = false;
          continue;
        } else {
          for (const wm of entry.warpMarkers) wm.graphic.renderable = true;
          for (const om of entry.objectMarkers) om.sprite.renderable = true;
        }

        const nextFrame = frameIndexForTime(elapsed, entry.resource.frameDurations, entry.resource.loopDuration);
        if (entry.sprite.currentFrame !== nextFrame) {
          entry.sprite.gotoAndStop(nextFrame);
        }
        for (const marker of entry.objectMarkers) {
          updateMarkerAnimation(marker, elapsed);
        }
      }
      const overlayState = overlayStateRef.current;
      if (overlayState) {
        const nextFrame = frameIndexForTime(elapsed, overlayState.resource.frameDurations, overlayState.resource.loopDuration);
        if (overlayState.sprite.currentFrame !== nextFrame) {
          overlayState.sprite.gotoAndStop(nextFrame);
        }
        for (const marker of overlayState.objectMarkers) {
          updateMarkerAnimation(marker, elapsed);
        }
      }
    };
    ticker.add(updateAnimations);
    return () => {
      ticker.remove(updateAnimations);
    };
  }, [ready, clampWorldToBounds, schedulePersistViewState]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    applySpriteTransforms();
  }, [ready, applySpriteTransforms, baseOffsets, offsetOverrides, zOverrides, editing, selectedNeighborhoodId]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const world = worldRef.current;
    const app = appRef.current;
    if (!world || !app) {
      return;
    }
    const entries = animationsRef.current;
    if (!entries.length) {
      return;
    }
    const editingEnabled = Boolean(editing && onOffsetChange);
    const blockPixelSize = atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize !== 0
      ? Math.max(1, Math.abs(atlas.blockPixelSize))
      : 16;
    const canvas = app.view as unknown as HTMLCanvasElement | null;
    if (!canvas) {
      return;
    }

    const handlePointerDown = (event: FederatedPointerEvent): void => {
      if (!editingEnabled || !onOffsetChange) {
        return;
      }
      const target = event.currentTarget as AnimatedSprite | null;
      if (!target) {
        return;
      }
      const entry = spriteEntryMapRef.current.get(target);
      if (!entry || !entry.neighborhoodId) {
        return;
      }
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : event.data?.pointerId ?? 0;
      const worldPoint = world.toLocal(event.global);
      const baseOffset = baseOffsetsRef.current[entry.neighborhoodId] ?? [0, 0];
      const currentOffset = offsetOverridesRef.current[entry.neighborhoodId] ?? baseOffset;
      const startOffset: OffsetTuple = [currentOffset[0], currentOffset[1]];
      editDragStateRef.current = {
        pointerId,
        neighborhoodId: entry.neighborhoodId,
        sprite: target,
        startOffset,
        startPoint: { x: worldPoint.x, y: worldPoint.y },
      };
      target.cursor = "grabbing";
      if (entry.neighborhoodId) {
        onSelectNeighborhood?.(entry.neighborhoodId);
      }
      event.stopPropagation();
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
      if (canvas && typeof canvas.setPointerCapture === "function" && Number.isFinite(pointerId)) {
        try {
          canvas.setPointerCapture(pointerId);
        } catch {
          /* ignore pointer capture failures */
        }
      }
    };

    const handleStagePointerMove = (event: FederatedPointerEvent): void => {
      if (!editingEnabled || !onOffsetChange) {
        return;
      }
      const state = editDragStateRef.current;
      if (!state) {
        return;
      }
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : event.data?.pointerId ?? 0;
      if (pointerId !== state.pointerId) {
        return;
      }
      const worldPoint = world.toLocal(event.global);
      const dx = worldPoint.x - state.startPoint.x;
      const dy = worldPoint.y - state.startPoint.y;
      const nextOffset: OffsetTuple = [
        snapToHalf(state.startOffset[0] + dx / blockPixelSize),
        snapToHalf(state.startOffset[1] + dy / blockPixelSize),
      ];
      onOffsetChange(state.neighborhoodId, nextOffset);
      event.stopPropagation();
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
    };

    const handleStagePointerUp = (event: FederatedPointerEvent): void => {
      const state = editDragStateRef.current;
      if (!state) {
        return;
      }
      const pointerId = typeof event.pointerId === "number" ? event.pointerId : event.data?.pointerId ?? 0;
      if (pointerId !== state.pointerId) {
        return;
      }
      state.sprite.cursor = "grab";
      editDragStateRef.current = null;
      if (canvas && typeof canvas.releasePointerCapture === "function" && canvas.hasPointerCapture(pointerId)) {
        try {
          canvas.releasePointerCapture(pointerId);
        } catch {
          /* ignore pointer capture release issues */
        }
      }
      event.stopPropagation();
      if (typeof event.preventDefault === "function") {
        event.preventDefault();
      }
    };

    const detach: Array<() => void> = [];

    for (const entry of entries) {
      const sprite = entry.sprite;
      sprite.off("pointerdown", handlePointerDown);
      if (!editingEnabled || !entry.neighborhoodId) {
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        continue;
      }
      sprite.eventMode = "static";
      sprite.cursor = "grab";
      sprite.on("pointerdown", handlePointerDown);
      detach.push(() => {
        sprite.off("pointerdown", handlePointerDown);
      });
    }

    const stage = app.stage;
    stage.off("pointermove", handleStagePointerMove);
    stage.off("pointerup", handleStagePointerUp);
    stage.off("pointerupoutside", handleStagePointerUp);
    stage.off("pointercancel", handleStagePointerUp);

    if (editingEnabled) {
      stage.on("pointermove", handleStagePointerMove);
      stage.on("pointerup", handleStagePointerUp);
      stage.on("pointerupoutside", handleStagePointerUp);
      stage.on("pointercancel", handleStagePointerUp);
      detach.push(() => {
        stage.off("pointermove", handleStagePointerMove);
        stage.off("pointerup", handleStagePointerUp);
        stage.off("pointerupoutside", handleStagePointerUp);
        stage.off("pointercancel", handleStagePointerUp);
      });
    }

    return () => {
      for (const entry of entries) {
        entry.sprite.cursor = "pointer";
      }
      detach.forEach((fn) => fn());
      const state = editDragStateRef.current;
      if (state) {
        state.sprite.cursor = "pointer";
        editDragStateRef.current = null;
        if (canvas && typeof canvas.releasePointerCapture === "function" && Number.isFinite(state.pointerId) && canvas.hasPointerCapture(state.pointerId)) {
          try {
            canvas.releasePointerCapture(state.pointerId);
          } catch {
            /* ignore release failures */
          }
        }
      }
    };
  }, [ready, editing, onOffsetChange, onSelectNeighborhood, atlas]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const app = appRef.current;
    const world = worldRef.current;
    const container = containerRef.current;
    if (!app || !world || !container) {
      return;
    }

    const canvas = app.view as unknown as HTMLCanvasElement | null;
    if (!canvas) {
      return () => undefined;
    }
  const pointers = new Map<number, { clientX: number; clientY: number }>();
  let dragPointer: number | null = null;
  let lastDrag = { x: 0, y: 0 };
  let pinchStartDistance: number | null = null;
  let pinchStartScale = scaleRef.current;

    const getRect = (): DOMRect => canvas.getBoundingClientRect();

    const applyScale = (nextScale: number, focus?: { x: number; y: number }): void => {
      const bounds = boundsRef.current;
      if (!bounds) {
        return;
      }
      const clamped = clampScale(nextScale);
      const rect = getRect();
      const focusX = focus ? focus.x : rect.left + rect.width / 2;
      const focusY = focus ? focus.y : rect.top + rect.height / 2;
      const localX = focusX - rect.left;
      const localY = focusY - rect.top;
      const worldX = (localX - world.x) / world.scale.x;
      const worldY = (localY - world.y) / world.scale.y;

      world.scale.set(clamped);
      scaleRef.current = clamped;

      world.x = localX - worldX * clamped;
      world.y = localY - worldY * clamped;

      clampWorldToBounds();
      schedulePersistViewState();
    };

  const applyOverlayScale = (nextScale: number, focus?: { x: number; y: number }): void => {
      const state = overlayStateRef.current;
      const appInstance = appRef.current;
      if (!state || !appInstance) {
        return;
      }
      const overlaySprite = state.sprite;
      const canvasElement = appInstance.view as HTMLCanvasElement | null;
      if (!canvasElement) {
        return;
      }
      const rect = canvasElement.getBoundingClientRect();
      const renderer = appInstance.renderer;
      const minScale = state.minScale ?? Math.max(MIN_SCALE, (state.fitScale || 1) * 0.5);
      const maxScale = state.maxScale ?? MAX_SCALE;
      const clamped = Math.min(maxScale, Math.max(minScale, nextScale));
      const focusLocalX = focus ? focus.x - rect.left : rect.width / 2;
      const focusLocalY = focus ? focus.y - rect.top : rect.height / 2;
      const currentScale = overlaySprite.scale.x || 1;
      const spriteLocalX = (focusLocalX - overlaySprite.x) / currentScale;
      const spriteLocalY = (focusLocalY - overlaySprite.y) / currentScale;
      const baseWidth = state.baseWidth || overlaySprite.texture.width || (currentScale ? overlaySprite.width / currentScale : overlaySprite.width) || 1;
      const baseHeight = state.baseHeight || overlaySprite.texture.height || (currentScale ? overlaySprite.height / currentScale : overlaySprite.height) || 1;

      overlaySprite.scale.set(clamped);
      state.scale = clamped;

      overlaySprite.x = focusLocalX - spriteLocalX * clamped;
      overlaySprite.y = focusLocalY - spriteLocalY * clamped;

      const scaledWidth = baseWidth * clamped;
      const scaledHeight = baseHeight * clamped;

      const { width: viewW, height: viewH } = getEffectiveViewSize(appInstance);

      if (scaledWidth > 0 && viewW > 0) {
        const over = computeOverscrollPx(viewW, viewH);
        if (scaledWidth <= viewW) {
          overlaySprite.x = Math.max(0, (viewW - scaledWidth) / 2);
        } else {
          const minX = viewW - scaledWidth - over;
          const maxX = 0 + over;
          overlaySprite.x = Math.min(maxX, Math.max(minX, overlaySprite.x));
        }
      }

      if (scaledHeight > 0 && viewH > 0) {
        const over = computeOverscrollPx(viewW, viewH);
        if (scaledHeight <= viewH) {
          overlaySprite.y = Math.max(0, (viewH - scaledHeight) / 2);
        } else {
          const extraBottom = computeBottomExtraPx(viewH);
          const minY = viewH - scaledHeight - over - extraBottom;
          const maxY = 0 + over;
          overlaySprite.y = Math.min(maxY, Math.max(minY, overlaySprite.y));
        }
      }

      state.positioned = true;
    };

    const clampOverlayPosition = (): void => {
      const state = overlayStateRef.current;
      const appInstance = appRef.current;
      if (!state || !appInstance) return;
      const overlaySprite = state.sprite;
      const { width: viewW, height: viewH } = getEffectiveViewSize(appInstance);
      const scale = overlaySprite.scale.x || 1;
      const baseWidth = state.baseWidth || overlaySprite.texture.width || (scale ? overlaySprite.width / scale : overlaySprite.width) || 1;
      const baseHeight = state.baseHeight || overlaySprite.texture.height || (scale ? overlaySprite.height / scale : overlaySprite.height) || 1;
      const scaledWidth = baseWidth * scale;
      const scaledHeight = baseHeight * scale;
      if (scaledWidth > 0 && viewW > 0) {
        const over = computeOverscrollPx(viewW, viewH);
        if (scaledWidth <= viewW) {
          overlaySprite.x = Math.max(0, (viewW - scaledWidth) / 2);
        } else {
          const minX = viewW - scaledWidth - over;
          const maxX = 0 + over;
          overlaySprite.x = Math.min(maxX, Math.max(minX, overlaySprite.x));
        }
      }
      if (scaledHeight > 0 && viewH > 0) {
        const over = computeOverscrollPx(viewW, viewH);
        if (scaledHeight <= viewH) {
          overlaySprite.y = Math.max(0, (viewH - scaledHeight) / 2);
        } else {
          const extraBottom = computeBottomExtraPx(viewH);
          const minY = viewH - scaledHeight - over - extraBottom;
          const maxY = 0 + over;
          overlaySprite.y = Math.min(maxY, Math.max(minY, overlaySprite.y));
        }
      }
      state.positioned = true;
    };

    const updatePinchStart = (): void => {
      if (pointers.size < 2) {
        pinchStartDistance = null;
        pinchStartScale = scaleRef.current;
        return;
      }
      const iterator = pointers.values();
      const first = iterator.next().value;
      const second = iterator.next().value;
      if (!first || !second) {
        return;
      }
      pinchStartDistance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
      pinchStartScale = scaleRef.current;
    };

    const handlePointerDown = (event: PointerEvent): void => {
      if (editing) return;
      const overlayState = overlayStateRef.current;
      // Track pointers for both world and overlay interactions
      pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      if (pointers.size === 1) {
        dragPointer = event.pointerId;
        lastDrag = { x: event.clientX, y: event.clientY };
      } else if (pointers.size === 2) {
        dragPointer = null;
        updatePinchStart();
      }
      canvas.setPointerCapture(event.pointerId);
    };

    const handlePointerMove = (event: PointerEvent): void => {
      if (editing) return;
      if (!pointers.has(event.pointerId)) {
        return;
      }
      pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });
      const overlayState = overlayStateRef.current;
      if (overlayState) {
        // Overlay interaction
        if (pointers.size === 1 && dragPointer === event.pointerId) {
          const dx = event.clientX - lastDrag.x;
          const dy = event.clientY - lastDrag.y;
          lastDrag = { x: event.clientX, y: event.clientY };
          overlayState.sprite.x += dx;
          overlayState.sprite.y += dy;
          clampOverlayPosition();
          return;
        }
        if (pointers.size >= 2 && pinchStartDistance && pinchStartDistance > 0) {
          const iterator = pointers.values();
          const first = iterator.next().value;
          const second = iterator.next().value;
          if (!first || !second) return;
          const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
          if (!distance) return;
          const center = { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
          const scaleFactor = distance / pinchStartDistance;
          applyOverlayScale(pinchStartScale * scaleFactor, center);
        }
        return;
      }

      // World interaction
      if (pointers.size === 1 && dragPointer === event.pointerId) {
        const dx = event.clientX - lastDrag.x;
        const dy = event.clientY - lastDrag.y;
        lastDrag = { x: event.clientX, y: event.clientY };
        world.x += dx;
        world.y += dy;
        clampWorldToBounds();
        schedulePersistViewState();
        return;
      }
      if (pointers.size >= 2 && pinchStartDistance && pinchStartDistance > 0) {
        const iterator = pointers.values();
        const first = iterator.next().value;
        const second = iterator.next().value;
        if (!first || !second) return;
        const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
        if (!distance) return;
        const center = { x: (first.clientX + second.clientX) / 2, y: (first.clientY + second.clientY) / 2 };
        const scaleFactor = distance / pinchStartDistance;
        applyScale(pinchStartScale * scaleFactor, center);
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      if (editing) return;
      if (!pointers.has(event.pointerId)) {
        return;
      }
      pointers.delete(event.pointerId);
      if (dragPointer === event.pointerId) {
        dragPointer = null;
      }
      if (pointers.size === 1) {
        const [remainingId] = pointers.keys();
        if (remainingId !== undefined) {
          dragPointer = remainingId;
          const remaining = pointers.get(remainingId);
          if (remaining) {
            lastDrag = { x: remaining.clientX, y: remaining.clientY };
          }
        }
      }
      updatePinchStart();
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      if (!overlayStateRef.current) {
        schedulePersistViewState();
      }
    };

    const handleWheel = (event: WheelEvent): void => {
      const overlayState = overlayStateRef.current;
      if (overlayState) {
        event.preventDefault();
        const delta = event.deltaY;
        const currentScale = Number.isFinite(overlayState.scale) && overlayState.scale > 0
          ? overlayState.scale
          : overlayState.fitScale || 1;
        const factor = Math.exp(-delta / 500);
        applyOverlayScale(currentScale * factor, { x: event.clientX, y: event.clientY });
        return;
      }
      event.preventDefault();
      const delta = event.deltaY;
      const factor = Math.exp(-delta / 500);
      applyScale(scaleRef.current * factor, { x: event.clientX, y: event.clientY });
    };

    const handleDoubleClick = (event: MouseEvent): void => {
      const overlayState = overlayStateRef.current;
      const factor = 1.5;
      if (overlayState) {
        const currentScale = Number.isFinite(overlayState.scale) && overlayState.scale > 0
          ? overlayState.scale
          : overlayState.fitScale || 1;
        applyOverlayScale(currentScale * factor, { x: event.clientX, y: event.clientY });
        return;
      }
      // Zoom in centered on the double-clicked point in world view
      applyScale(scaleRef.current * factor, { x: event.clientX, y: event.clientY });
    };

    const handleRendererResize = (): void => {
      if (overlayStateRef.current) {
        positionOverlayContents();
      }
      clampWorldToBounds();
      schedulePersistViewState();
    };

    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", handlePointerUp);
    canvas.addEventListener("pointercancel", handlePointerUp);
    canvas.addEventListener("pointerleave", handlePointerUp);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("dblclick", handleDoubleClick);
  rendererOn(app, "resize", handleRendererResize);

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
      canvas.removeEventListener("pointerleave", handlePointerUp);
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("dblclick", handleDoubleClick);
  rendererOff(app, "resize", handleRendererResize);
      pointers.clear();
      dragPointer = null;
      pinchStartDistance = null;
    };
  }, [ready, editing, clampWorldToBounds, positionOverlayContents, schedulePersistViewState]);

  // Keyboard pan/zoom when not editing and no overlay is open
  useEffect(() => {
    if (!ready) return;
    const app = appRef.current;
    const world = worldRef.current;
    if (!app || !world) return;

    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
      return target.isContentEditable;
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (editing) return;
      if (overlayStateRef.current) return;
      if (isInteractiveTarget(event.target)) return;

      let consumed = false;
      const panStep = event.shiftKey ? 120 : 60; // screen-space px per keypress

      const pan = (dx: number, dy: number): void => {
        world.x += dx;
        world.y += dy;
        clampWorldToBounds();
        schedulePersistViewState();
      };

      const zoom = (factor: number): void => {
        const { width: viewW, height: viewH } = getEffectiveViewSize(app);
        const current = scaleRef.current;
        const next = clampScale(current * factor);
        const k = next / current;
        // Zoom around viewport center
        const cx = viewW / 2;
        const cy = viewH / 2;
        world.scale.set(next);
        scaleRef.current = next;
        world.x = world.x + (1 - k) * (cx - world.x);
        world.y = world.y + (1 - k) * (cy - world.y);
        clampWorldToBounds();
        schedulePersistViewState();
      };

      switch (event.key) {
        case "ArrowUp":
        case "w":
        case "W":
        case "i":
        case "I":
          pan(0, panStep);
          consumed = true;
          break;
        case "ArrowDown":
        case "s":
        case "S":
        case "k":
        case "K":
          pan(0, -panStep);
          consumed = true;
          break;
        case "ArrowLeft":
        case "a":
        case "A":
        case "j":
        case "J":
          pan(panStep, 0);
          consumed = true;
          break;
        case "ArrowRight":
        case "d":
        case "D":
        case "l":
        case "L":
          pan(-panStep, 0);
          consumed = true;
          break;
        case "+":
        case "=":
          zoom(event.shiftKey ? 1.35 : 1.2);
          consumed = true;
          break;
        case "-":
        case "_":
          zoom(event.shiftKey ? 1 / 1.35 : 1 / 1.2);
          consumed = true;
          break;
        default:
          break;
      }

      if (consumed) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", handleKeyDown, { capture: true } as AddEventListenerOptions);
    };
  }, [ready, editing, clampWorldToBounds, schedulePersistViewState]);

  // Responsive UI hints for analysis panels
  const [narrowUI, setNarrowUI] = useState(false);
  useEffect(() => {
    const recompute = (): void => {
      const app = appRef.current;
      const { width, height } = getEffectiveViewSize(app);
      const w = width || (typeof window !== "undefined" ? window.innerWidth : 1024);
      const h = height || (typeof window !== "undefined" ? window.innerHeight : 768);
      const portrait = h >= w;
      setNarrowUI(portrait || w <= 560);
    };
    recompute();
  const app = appRef.current;
  const onResize = (): void => recompute();
  if (app) rendererOn(app, "resize", onResize);
    if (typeof window !== "undefined") {
      window.addEventListener("resize", onResize);
      if ((window as any).visualViewport) {
        (window as any).visualViewport.addEventListener("resize", onResize as any);
      }
    }
    return () => {
  if (app) rendererOff(app, "resize", onResize);
      if (typeof window !== "undefined") {
        window.removeEventListener("resize", onResize);
        if ((window as any).visualViewport) {
          (window as any).visualViewport.removeEventListener("resize", onResize as any);
        }
      }
    };
  }, []);

  return (
    <div className="canvas-stage" ref={containerRef}>
      {loading && <div className="status-banner info">Loading atlas…</div>}
      {!loading && !atlas && <div className="status-banner warning">No map data available.</div>}
      {/* Sprite Limits Panel */}
      <div
        style={{
          position: "absolute",
          right: 12,
          top: 12,
          padding: 8,
          background: "rgba(0,0,0,0.5)",
          color: "#fff",
          borderRadius: 6,
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          maxWidth: "calc(100% - 24px)",
          overflow: "hidden",
          zIndex: 1000,
        }}
      >
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
          <input
            type="checkbox"
            checked={spriteLimitEnabled}
            onChange={(e) => setSpriteLimitEnabled(e.target.checked)}
          />
          <span>Sprite Limits</span>
        </label>
        {spriteLimitEnabled && (
          <>
            {/* Severity filter */}
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={spriteOnlyErrors}
                onChange={(e) => setSpriteOnlyErrors(e.target.checked)}
              />
              <span>Only errors (&gt; limit)</span>
            </label>
            {/* Follower toggle */}
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={spriteIncludeFollower}
                onChange={(e) => setSpriteIncludeFollower(e.target.checked)}
              />
              <span>Follower Pokémon</span>
            </label>
            {/* Weather toggle (overworld only when applied in analysis) */}
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12 }}>
              <input
                type="checkbox"
                checked={spriteIncludeWeather}
                onChange={(e) => setSpriteIncludeWeather(e.target.checked)}
              />
              <span>Weather (reserve 1)</span>
            </label>
            {/* Scope selector */}
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
              <span>Scope</span>
              <select
                value={spriteScope}
                onChange={(e) => setSpriteScope((e.target.value as MapScope) ?? "all")}
                style={{ fontSize: 12, maxWidth: 140 }}
              >
                <option value="all">All</option>
                <option value="overworld">Overworld</option>
                <option value="indoor">Indoor</option>
              </select>
            </label>
            {/* Limits */}
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
              <span>Scanline</span>
              <input
                type="number"
                value={spriteScanlineLimit}
                onChange={(e) => setSpriteScanlineLimit(Number.isFinite(parseInt(e.target.value)) ? parseInt(e.target.value) : 10)}
                min={0}
                step={1}
                style={{ width: 64, fontSize: 12 }}
              />
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12 }}>
              <span>Total</span>
              <input
                type="number"
                value={spriteTotalLimit}
                onChange={(e) => setSpriteTotalLimit(Number.isFinite(parseInt(e.target.value)) ? parseInt(e.target.value) : 40)}
                min={0}
                step={1}
                style={{ width: 64, fontSize: 12 }}
              />
            </label>
            <button
              type="button"
              onClick={() => runSpriteLimitAnalysis()}
              disabled={spriteAnalyzing}
            >
              {spriteAnalyzing ? "Analyzing…" : "Analyze"}
            </button>
          </>
        )}
      </div>
      {/* When no overlay is open, Analyze scans the entire overworld. */}
      {spriteLimitEnabled && spriteIssues && spriteIssues.length > 0 && (
        resultsCollapsed ? (
          <div
            style={{
              position: "absolute",
              right: narrowUI ? undefined : 12,
              left: narrowUI ? 12 : undefined,
              bottom: 12,
              padding: "6px 10px",
              background: "rgba(0,0,0,0.6)",
              color: "#fff",
              borderRadius: 16,
              zIndex: 1000,
              cursor: "pointer",
              userSelect: "none",
            }}
          >
            <button
              type="button"
              onClick={() => setResultsCollapsed(false)}
              style={{
                background: "transparent",
                color: "#fff",
                border: "none",
                fontWeight: 600,
                cursor: "pointer",
              }}
            >
              Show results ({spriteIssues.length})
            </button>
          </div>
        ) : (
        <div
          style={{
            position: "absolute",
            right: narrowUI ? undefined : 12,
            left: narrowUI ? 12 : undefined,
            top: narrowUI ? undefined : 56,
            bottom: narrowUI ? 12 : undefined,
            width: narrowUI ? "calc(100% - 24px)" : "min(320px, calc(100% - 24px))",
            maxHeight: narrowUI ? "40vh" : "min(50vh, 360px)",
            overflow: "auto",
            padding: 8,
            background: "rgba(0,0,0,0.6)",
            color: "#fff",
            borderRadius: 6,
            zIndex: 1000,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <strong>{spriteIssues.length} issue{spriteIssues.length === 1 ? "" : "s"}</strong>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <button
                type="button"
                onClick={() => setResultsCollapsed(true)}
                title="Hide results"
              >
                Hide
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!spriteIssues) return;
                  const next = (spriteIssueIndex - 1 + spriteIssues.length) % spriteIssues.length;
                  setSpriteIssueIndex(next);
                  const issue = spriteIssues[next];
                  const overlay = overlayStateRef.current;
                  if (issue && issue.mapLabel) {
                    const entry = findWorldEntry(issue.mapLabel);
                    if (entry) {
                      // Overworld map – show in world view
                      if (overlay) {
                        closeOverlay();
                      }
                      const cx = entry.sprite.x + issue.viewportPx.x + issue.viewportPx.width / 2;
                      const cy = entry.sprite.y + issue.viewportPx.y + issue.viewportPx.height / 2;
                      focusWorldOn(cx, cy);
                      drawWorldIssueHighlight(entry, issue);
                    } else {
                      // Not in world (likely indoor) – use overlay
                      void openOverlay(issue.mapLabel).then(() => {
                        drawSpriteIssueHighlight(issue);
                        clearWorldIssueHighlight();
                      });
                    }
                  }
                }}
              >
                ◀
              </button>
              <span>{spriteIssueIndex + 1}/{spriteIssues.length}</span>
              <button
                type="button"
                onClick={() => {
                  if (!spriteIssues) return;
                  const next = (spriteIssueIndex + 1) % spriteIssues.length;
                  setSpriteIssueIndex(next);
                  const issue = spriteIssues[next];
                  const overlay = overlayStateRef.current;
                  if (issue && issue.mapLabel) {
                    const entry = findWorldEntry(issue.mapLabel);
                    if (entry) {
                      if (overlay) {
                        closeOverlay();
                      }
                      const cx = entry.sprite.x + issue.viewportPx.x + issue.viewportPx.width / 2;
                      const cy = entry.sprite.y + issue.viewportPx.y + issue.viewportPx.height / 2;
                      focusWorldOn(cx, cy);
                      drawWorldIssueHighlight(entry, issue);
                    } else {
                      void openOverlay(issue.mapLabel).then(() => {
                        drawSpriteIssueHighlight(issue);
                        clearWorldIssueHighlight();
                      });
                    }
                  }
                }}
              >
                ▶
              </button>
              <button
                type="button"
                onClick={() => {
                  // Clear results and any highlights
                  setSpriteIssues(null);
                  setSpriteIssuesAll(null);
                  setSpriteIssueIndex(0);
                  clearWorldIssueHighlight();
                  clearOverlayIssueHighlight();
                }}
                title="Clear results"
              >
                Clear
              </button>
            </div>
          </div>
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {spriteIssues.map((issue, idx) => (
              <li key={`${issue.type}-${idx}`}>
                <button
                  type="button"
                  onClick={() => {
                    setSpriteIssueIndex(idx);
                    const overlay = overlayStateRef.current;
                    if (issue && issue.mapLabel) {
                      const entry = findWorldEntry(issue.mapLabel);
                      if (entry) {
                        if (overlay) {
                          closeOverlay();
                        }
                        const cx = entry.sprite.x + issue.viewportPx.x + issue.viewportPx.width / 2;
                        const cy = entry.sprite.y + issue.viewportPx.y + issue.viewportPx.height / 2;
                        focusWorldOn(cx, cy);
                        drawWorldIssueHighlight(entry, issue);
                      } else {
                        void openOverlay(issue.mapLabel).then(() => {
                          drawSpriteIssueHighlight(issue);
                          clearWorldIssueHighlight();
                        });
                      }
                    }
                  }}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    background: idx === spriteIssueIndex ? "rgba(241,196,15,0.3)" : "rgba(255,255,255,0.08)",
                    color: "#fff",
                    border: "1px solid rgba(255,255,255,0.15)",
                    borderRadius: 4,
                    padding: "6px 8px",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span>
                      {issue.type === "scanline-limit" ? "Scanline" : "Total"} {issue.severity === "exceeds" ? ">" : "="}{issue.limit}
                    </span>
                    <span>
                      count: {issue.count}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, opacity: 0.85 }}>
                    {issue.mapLabel ? `${issue.mapLabel} • ` : ""}Player @ ({issue.playerCell.x},{issue.playerCell.y})
                    {issue.type === "scanline-limit" && typeof issue.scanlineY === "number" ? ` • y=${issue.scanlineY}` : ""}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {/* Contributors for the selected issue */}
          {spriteIssues[spriteIssueIndex] && (
            <div style={{ marginTop: 8 }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Contributors</div>
              <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
                {spriteIssues[spriteIssueIndex].contributors.slice(0, 20).map((ref, i) => (
                  <li key={`${ref.kind}-${ref.index ?? -1}-${ref.cell.x}-${ref.cell.y}-${i}`} style={{ fontSize: 12, opacity: 0.9 }}>
                    {ref.kind === "player"
                      ? "Player"
                      : ref.kind === "follower"
                        ? "Follower"
                        : `NPC #${ref.index ?? "?"}`}
                    {` at (${ref.cell.x},${ref.cell.y})`}
                    {ref.label ? ` • ${ref.label}` : ""}
                  </li>
                ))}
                {spriteIssues[spriteIssueIndex].contributors.length > 20 && (
                  <li style={{ fontSize: 12, opacity: 0.7 }}>(+ more)</li>
                )}
              </ul>
            </div>
          )}
        </div>
        )
      )}
    </div>
  );
}
