import { useCallback, useEffect, useRef, useState } from "react";
import { Application, Container, AnimatedSprite, FederatedPointerEvent, Assets, Graphics, Sprite } from "pixi.js";
import { AtlasLayout, MapPlacement, MapWarp, ObjectMetadata, ObjectEventEntry, WarpMetadata } from "@/types";
import { registerPixiExtensions } from "@/pixi/registerExtensions";
import { loadMapAnimation, type MapAnimationResource } from "@/lib/loadMapAnimation";
import { ObjectSpriteCache } from "@/lib/objectSprites";
import { computeObjectPosition, type PlacementContext } from "@/lib/objectPlacement";

type OffsetTuple = [number, number];

type WarpMarkerEntry = {
  warp: MapWarp;
  graphic: Graphics;
};

type WarpBacklink = {
  applicableTo: string | null;
  mapLabel: string;
  mapConstant: string | null;
  warpIndex: number;
  previous: WarpBacklink | null;
};

type ObjectMarkerEntry = {
  object: ObjectEventEntry;
  sprite: Sprite;
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
  for (const texture of resource.textures) {
    if (texture && !texture.destroyed) {
      texture.destroy();
    }
  }
  if (!resource.baseTexture.destroyed) {
    resource.baseTexture.destroy();
  }
  void Assets.unload(resource.imageUrl);
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
  scale: number;
  fitScale: number;
  minScale: number;
  maxScale: number;
  positioned: boolean;
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
  const highlightTimersRef = useRef<Map<string, number>>(new Map());
  const backlinkRef = useRef<WarpBacklink | null>(null);
  const handleOverlayWarpRef = useRef<((warp: MapWarp) => void) | null>(null);
  const objectMetadataRef = useRef<ObjectMetadata | null>(null);
  const objectSpriteCacheRef = useRef<ObjectSpriteCache | null>(null);
  const objectCacheSourceRef = useRef<ObjectMetadata | null>(null);
  const [ready, setReady] = useState(false);

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
      sprite.zIndex = targetZ * 1_000_000 + order;

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

  const positionOverlayContents = useCallback((): void => {
    const state = overlayStateRef.current;
    const app = appRef.current;
    if (!state || !app) {
      return;
    }
    const renderer = app.renderer;
    const background = state.background;
    background.clear();
    background.beginFill(0x000000, 0.6);
    background.drawRect(0, 0, renderer.width, renderer.height);
    background.endFill();
    const sprite = state.sprite;
    const baseWidth = state.baseWidth || sprite.texture.width || sprite.width || 1;
    const baseHeight = state.baseHeight || sprite.texture.height || sprite.height || 1;

    const availableWidth = renderer.width * 0.9;
    const availableHeight = renderer.height * 0.9;
    const fitScale = baseWidth > 0 && baseHeight > 0
      ? Math.min(1, availableWidth / baseWidth, availableHeight / baseHeight)
      : 1;
    const minScale = Math.max(MIN_SCALE, fitScale * 0.5);
    const maxScale = MAX_SCALE;

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
      const min = viewport - total;
      const max = 0;
      return Math.min(max, Math.max(min, value));
    };

    const nextX = state.positioned ? sprite.x : 0;
    const nextY = state.positioned ? sprite.y : 0;

    sprite.x = clampAxis(nextX, scaledWidth, renderer.width);
    sprite.y = clampAxis(nextY, scaledHeight, renderer.height);
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
      app.renderer.off("resize", positionOverlayContents);
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
    const renderer = app.renderer;
    const viewWidth = renderer.width;
    const viewHeight = renderer.height;
    const scaledWidth = bounds.width * scale;
    const scaledHeight = bounds.height * scale;

    if (!(scaledWidth > 0)) {
      world.x = 0;
    } else if (scaledWidth <= viewWidth) {
      world.x = (viewWidth - scaledWidth) / 2;
    } else {
      const minX = viewWidth - scaledWidth;
      const maxX = 0;
      world.x = Math.min(maxX, Math.max(minX, world.x));
    }

    if (!(scaledHeight > 0)) {
      world.y = 0;
    } else if (scaledHeight <= viewHeight) {
      world.y = (viewHeight - scaledHeight) / 2;
    } else {
      const minY = viewHeight - scaledHeight;
      const maxY = 0;
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
      const renderer = app.renderer;
      world.x = renderer.width / 2 - worldX * scale;
      world.y = renderer.height / 2 - worldY * scale;
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
      const record = cache.getFacingTexture(spriteKey, facingKey, paletteName);
      if (!record) {
        continue;
      }
      const spriteInstance = new Sprite(record.texture);
      spriteInstance.eventMode = "none";
      spriteInstance.cursor = "auto";
      const { x: baseX, y: baseY } = computeObjectPosition(objectEntry, placementContext);
      const offsetX = record.offsetX * pixelScale;
      const offsetY = record.offsetY * pixelScale;
      spriteInstance.x = baseX + offsetX;
      spriteInstance.y = baseY + offsetY;
      spriteInstance.scale.set(pixelScale);
      container.addChild(spriteInstance);
      state.objectMarkers.push({ object: objectEntry, sprite: spriteInstance });
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
  }, [atlas, timeOfDay]);

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
            markers.push({ warp, graphic });
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
        app.renderer.off("resize", positionOverlayContents);
        app.renderer.on("resize", positionOverlayContents);
        positionOverlayContents();
      } catch (err) {
        if (overlayTokenRef.current === token) {
          console.error(`Failed to open overlay for ${mapLabel}`, err);
        }
      }
    },
    [closeOverlay, computeCellSize, getMapMetadata, positionOverlayContents, refreshOverlayObjects, resolveAssetHref]
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

      if (typeof target.warpIndex === "number" && target.warpIndex >= 0 && (!targetLabel || targetLabel === currentMapLabel)) {
        highlightOverlayMarker(target.warpIndex);
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
        graphic.x = xCells * cellSize;
        graphic.y = yCells * cellSize;
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
        entry.sprite.addChild(graphic);
        entry.warpMarkers.push({ warp, graphic });
      }
      entry.sprite.sortChildren();
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
    const placementContext: PlacementContext = {
      atlasBlockPixelSize: atlasBlockSize,
      metadataBlockPixelSize: metadataBlockSize,
      cellsPerBlock,
      eventCellPixelSize: baseCellPixelSize,
    };

    for (const entry of animationsRef.current) {
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
        const record = cache.getFacingTexture(spriteKey, facingKey, paletteName);
        if (!record) {
          continue;
        }
        const sprite = new Sprite(record.texture);
        sprite.eventMode = "none";
        sprite.cursor = "auto";
        const { x: baseX, y: baseY } = computeObjectPosition(objectEntry, placementContext);
        const offsetX = record.offsetX * pixelScale;
        const offsetY = record.offsetY * pixelScale;
        sprite.x = baseX + offsetX;
        sprite.y = baseY + offsetY;
        sprite.scale.set(pixelScale);
        container.addChild(sprite);
        entry.objectMarkers.push({ object: objectEntry, sprite });
      }

      if (container.children.length === 0) {
        entry.sprite.removeChild(container);
        container.destroy();
        entry.objectContainer = null;
      }
      entry.sprite.sortChildren();
    }
  }, [atlas, timeOfDay]);

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
    const renderer = app.renderer;
    world.x = renderer.width / 2 - centerX * scale;
    world.y = renderer.height / 2 - centerY * scale;
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
      const app = new Application({
        backgroundAlpha: 0,
        resizeTo: container,
        antialias: true,
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
      setReady(true);
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
        app.destroy(true, { children: true });
        appRef.current = null;
      }
      const world = worldRef.current;
      if (world) {
        world.destroy({ children: true });
        worldRef.current = null;
      }
      overlayRef.current = null;
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
      const renderer = app.renderer;
      const viewWidth = renderer.width;
      const viewHeight = renderer.height;
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
        sprite.zIndex = neighborhoodZ * 1_000_000 + index;
        world.addChild(sprite);
        world.sortChildren();
        const entry: SyncedAnimation = {
          sprite,
          resource,
          placement,
          order: index,
          neighborhoodId,
          warpMarkers: [],
          objectContainer: null,
          objectMarkers: [],
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
  }, [atlas, ready, clampWorldToBounds, persistViewState, restoreViewState, applySpriteTransforms, refreshOverlayObjects, refreshWarpMarkers, refreshObjectSprites]);

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
      for (const entry of animationsRef.current) {
        const nextFrame = frameIndexForTime(elapsed, entry.resource.frameDurations, entry.resource.loopDuration);
        if (entry.sprite.currentFrame !== nextFrame) {
          entry.sprite.gotoAndStop(nextFrame);
        }
      }
      const overlayState = overlayStateRef.current;
      if (overlayState) {
        const nextFrame = frameIndexForTime(elapsed, overlayState.resource.frameDurations, overlayState.resource.loopDuration);
        if (overlayState.sprite.currentFrame !== nextFrame) {
          overlayState.sprite.gotoAndStop(nextFrame);
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

      if (scaledWidth > 0 && renderer.width > 0) {
        if (scaledWidth <= renderer.width) {
          overlaySprite.x = Math.max(0, (renderer.width - scaledWidth) / 2);
        } else {
          const minX = renderer.width - scaledWidth;
          overlaySprite.x = Math.min(0, Math.max(minX, overlaySprite.x));
        }
      }

      if (scaledHeight > 0 && renderer.height > 0) {
        if (scaledHeight <= renderer.height) {
          overlaySprite.y = Math.max(0, (renderer.height - scaledHeight) / 2);
        } else {
          const minY = renderer.height - scaledHeight;
          overlaySprite.y = Math.min(0, Math.max(minY, overlaySprite.y));
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
      if (editing) {
        return;
      }
      if (overlayStateRef.current) {
        return;
      }
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
      if (editing) {
        return;
      }
      if (overlayStateRef.current) {
        return;
      }
      if (!pointers.has(event.pointerId)) {
        return;
      }
      pointers.set(event.pointerId, { clientX: event.clientX, clientY: event.clientY });

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
        if (!first || !second) {
          return;
        }
        const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
        if (!distance) {
          return;
        }
        const center = {
          x: (first.clientX + second.clientX) / 2,
          y: (first.clientY + second.clientY) / 2,
        };
        const scaleFactor = distance / pinchStartDistance;
        applyScale(pinchStartScale * scaleFactor, center);
      }
    };

    const handlePointerUp = (event: PointerEvent): void => {
      if (editing) {
        return;
      }
      if (overlayStateRef.current) {
        return;
      }
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
      schedulePersistViewState();
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

    const handleDoubleClick = (): void => {
      if (overlayStateRef.current) {
        return;
      }
      resetViewRef.current?.();
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
    app.renderer.on("resize", handleRendererResize);

    return () => {
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", handlePointerUp);
      canvas.removeEventListener("pointercancel", handlePointerUp);
      canvas.removeEventListener("pointerleave", handlePointerUp);
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("dblclick", handleDoubleClick);
      app.renderer.off("resize", handleRendererResize);
      pointers.clear();
      dragPointer = null;
      pinchStartDistance = null;
    };
  }, [ready, editing, clampWorldToBounds, positionOverlayContents, schedulePersistViewState]);

  return (
    <div className="canvas-stage" ref={containerRef}>
      {loading && <div className="status-banner info">Loading atlas…</div>}
      {!loading && !atlas && <div className="status-banner warning">No map data available.</div>}
    </div>
  );
}
