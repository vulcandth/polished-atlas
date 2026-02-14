import type { Texture, Graphics, Sprite, AnimatedSprite, Container } from "pixi.js";
import type { WeatherSystem } from "@/lib/weather";
import type {
  MapPlacement,
  MapWarp,
  ObjectEventEntry,
  MovementSummary,
} from "@/types";
import type { MapAnimationResource } from "@/lib/loadMapAnimation";
import type { ObjectSpriteCache } from "@/lib/objectSprites";
import type { CollisionHelper } from "@/lib/collision";
import type { SpriteLimitIssue } from "@/lib/spriteLimitAnalysis";

export type OffsetTuple = [number, number];

export type WarpMarkerEntry = {
  warp: MapWarp;
  graphic: Graphics;
  // Local pixel offsets within the map sprite
  localX: number;
  localY: number;
};

export type WarpBacklink = {
  applicableTo: string | null;
  mapLabel: string;
  mapConstant: string | null;
  warpIndex: number;
  previous: WarpBacklink | null;
};

export type CardinalDirection = "down" | "up" | "left" | "right";

export type Offset = { dx: number; dy: number };

export type SpriteFrameRef = {
  key: string;
  texture: Texture;
  offsetX: number;
  offsetY: number;
};

export type MovementFrameSet = {
  framesByDirection: Partial<Record<CardinalDirection, SpriteFrameRef[]>>;
  availableDirections: CardinalDirection[];
  defaultFrame: SpriteFrameRef;
  defaultDirection: CardinalDirection | null;
};

export type PokemonIconFrameRecord = NonNullable<
  ReturnType<ObjectSpriteCache["getPokemonIconFrameTextures"]>
>["frames"][number];

export type MovementSegment =
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

export type PathMovementAnimator = {
  kind: "path";
  segments: MovementSegment[];
  totalDurationMs: number;
  stepCount: number;
};

export type SpinStep = {
  direction: CardinalDirection;
  durationMs: number;
};

export type SpinMovementAnimator = {
  kind: "spin";
  steps: SpinStep[];
  totalDurationMs: number;
};

export type IdleMovementAnimator = {
  kind: "idle";
  direction: CardinalDirection | null;
  frameCount: number;
  frameDurationMs: number;
  phaseOffsetMs: number;
};

export type MovementAnimator = PathMovementAnimator | SpinMovementAnimator | IdleMovementAnimator;

export type ObjectMarkerEntry = {
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

export type SyncedAnimation = {
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
  weather?: WeatherSystem | null;
};

export type OverlayState = {
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
