import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  Application,
  Container,
  AnimatedSprite,
  FederatedPointerEvent,
  Graphics,
  Sprite,
} from "pixi.js";
import { WeatherSystem } from "@/lib/weather";
import { joinBasePath, withBasePath, withVersion } from "@/lib/basePath";
import {
  AtlasLayout,
  MapWarp,
  ObjectMetadata,
  WarpMetadata,
  BgPalettesMetadata,
  MapPlacement,
} from "@/types";
import { registerPixiExtensions } from "@/pixi/registerExtensions";
import { loadMapAnimation } from "@/lib/loadMapAnimation";
import { ObjectSpriteCache } from "@/lib/objectSprites";
import { computeObjectPosition, type PlacementContext } from "@/lib/objectPlacement";
import { createCollisionHelper } from "@/lib/collision";
import {
  analyzeAllSpriteLimits,
  type SpriteLimitIssue,
  type MapScope,
} from "@/lib/spriteLimitAnalysis";
import {
  readStoredViewState,
  writeStoredViewState,
  readPerfSettings,
  writePerfSettings,
  clampUnit,
  isFiniteNumber,
  VIEW_STATE_VERSION
} from "@/lib/storage";
import { cn } from "@/lib/utils";

// Tooltip state type
interface TooltipData {
  title: string;
  subtitle?: string;
}

// Extracted types
import type {
  OffsetTuple,
  WarpMarkerEntry,
  WarpBacklink,
  SpriteFrameRef,
  MovementFrameSet,
  SyncedAnimation,
  OverlayState,
} from "./MapCanvas/MapCanvas.types";

export type { WarpBacklink };

// Extracted constants
import { MIN_SCALE, MAX_SCALE } from "./MapCanvas/constants";

// Extracted utilities
import {
  computeOverscrollPx,
  computeBottomExtraPx,
  clampScale,
  disposeAnimationResource,
  rendererOn,
  rendererOff,
  getEffectiveViewSize,
  snapToHalf,
} from "@/lib/map-canvas/viewport-utils";
import {
  frameIndexForTime,
  isObjectVisibleAtTime,
  resolveFacingConstant,
  computeMovementSummaryForObject,
  isObjectWithinMapBounds,
  resolveDirectionFromFacingKey,
  buildMovementFrameSet,
  buildPokemonIconFrameSet,
  createSpriteFrameRef,
} from "@/lib/map-canvas/animation-frames";
import {
  createMovementAnimator,
  createPokemonIconAnimator,
} from "@/lib/map-canvas/movement-animators";
import {
  applySpriteFrame,
  updateMarkerAnimation,
} from "@/lib/map-canvas/sprite-animation";

// Local event typings to avoid React typing dependency issues
type CheckboxChangeEvent = { target: { checked: boolean } };
type InputNumberChangeEvent = { target: { value: string } };
type SelectChangeEvent = { target: { value: string } };

/**
 * View state exposed via callbacks and imperative handle
 */
export interface MapViewState {
  x: number;
  y: number;
  scale: number;
  centerWorldX: number;
  centerWorldY: number;
}

/**
 * Imperative handle for MapCanvas component
 */
export interface MapCanvasHandle {
  /** Navigate to a specific world coordinate */
  focusWorldOn: (worldX: number, worldY: number) => void;
  /** Set the zoom scale */
  setScale: (scale: number) => void;
  /** Get the current view state */
  getViewState: () => MapViewState | null;
  /** Get the Pixi Application (for screenshots) */
  getApp: () => Application | null;
  /** Reset view to fit the entire atlas */
  resetView: () => void;
  /** Close the current overlay and return to the atlas view */
  closeOverlay: () => void;
  /** Open an overlay for a specific map */
  openOverlay: (mapLabel: string, highlight?: { xCells?: number | null; yCells?: number | null }) => Promise<void>;
  /** Set the backlink chain (for breadcrumb navigation) */
  setBacklink: (backlink: WarpBacklink | null) => void;
}

interface MapCanvasProps {
  atlas: AtlasLayout | null;
  loading: boolean;
  editing?: boolean;
  warpMetadata?: WarpMetadata | null;
  bgPalettes?: BgPalettesMetadata | null;
  resolveAssetHref?: (mapLabel: string) => string;
  baseOffsets?: Record<string, OffsetTuple> | null;
  offsetOverrides?: Record<string, OffsetTuple> | null;
  zOverrides?: Record<string, number> | null;
  selectedNeighborhoodId?: string | null;
  onSelectNeighborhood?: (id: string) => void;
  onOffsetChange?: (id: string, next: OffsetTuple) => void;
  objectMetadata?: ObjectMetadata | null;
  timeOfDay?: string;
  // Optional controlled perf toggles passed from parent header
  disableMapAnimations?: boolean;
  disableObjectAnimations?: boolean;
  // Optional controlled weather/sprite-limit toggles
  weatherEnabled?: boolean;
  onWeatherEnabledChange?: (enabled: boolean) => void;
  spriteLimitEnabled?: boolean;
  onSpriteLimitEnabledChange?: (enabled: boolean) => void;
  // Optional map borders toggle
  mapBordersEnabled?: boolean;
  // View state callbacks
  onViewStateChange?: (state: MapViewState) => void;
  // Overlay navigation callback
  onOverlayChange?: (state: { mapLabel: string | null; backlink: WarpBacklink | null }) => void;
  // Initial view state (from URL params)
  initialViewState?: Partial<MapViewState>;
}

registerPixiExtensions();

const MapCanvas = forwardRef<MapCanvasHandle, MapCanvasProps>(function MapCanvas(
  {
    atlas,
    loading,
    editing = false,
    warpMetadata = null,
    bgPalettes = null,
    resolveAssetHref,
    baseOffsets = null,
    offsetOverrides = null,
    zOverrides = null,
    selectedNeighborhoodId = null,
    onSelectNeighborhood,
    onOffsetChange,
    objectMetadata = null,
    timeOfDay = "day",
    // Optional controlled perf toggles (when provided by parent header)
    disableMapAnimations: controlledDisableMapAnimations,
    disableObjectAnimations: controlledDisableObjectAnimations,
    // Optional controlled weather/sprite-limit toggles
    weatherEnabled: controlledWeatherEnabled,
    onWeatherEnabledChange,
    spriteLimitEnabled: controlledSpriteLimitEnabled,
    onSpriteLimitEnabledChange,
    // Optional map borders toggle
    mapBordersEnabled = false,
    // View state callbacks
    onViewStateChange,
    // Overlay navigation callback
    onOverlayChange,
    initialViewState: _initialViewState,
  },
  ref,
) {
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
  const weatherSystemRef = useRef<WeatherSystem | null>(null);
  const weatherTickerRef = useRef<((delta: number) => void) | null>(null);
  const warpsLayerRef = useRef<Container | null>(null);
  const highlightTimersRef = useRef<Map<string, number>>(new Map());
  const backlinkRef = useRef<WarpBacklink | null>(null);
  const handleOverlayWarpRef = useRef<((warp: MapWarp) => void) | null>(null);
  const objectMetadataRef = useRef<ObjectMetadata | null>(null);
  const objectSpriteCacheRef = useRef<ObjectSpriteCache | null>(null);
  const objectCacheSourceRef = useRef<ObjectMetadata | null>(null);
  const onViewStateChangeRef = useRef(onViewStateChange);
  const onOverlayChangeRef = useRef(onOverlayChange);
  const [ready, setReady] = useState(false);

  // Keep onViewStateChange ref up to date
  useEffect(() => {
    onViewStateChangeRef.current = onViewStateChange;
  }, [onViewStateChange]);

  // Keep onOverlayChange ref up to date
  useEffect(() => {
    onOverlayChangeRef.current = onOverlayChange;
  }, [onOverlayChange]);

  // Tooltip state (React-based instead of DOM manipulation)
  const [tooltipState, setTooltipState] = useState<{
    data: TooltipData | null;
    x: number;
    y: number;
  }>({ data: null, x: 0, y: 0 });

  const showTooltip = useCallback(
    (data: TooltipData, clientX: number, clientY: number) => {
      setTooltipState({
        data,
        x: Math.max(8, clientX + 12),
        y: Math.max(8, clientY + 12),
      });
    },
    []
  );

  const hideTooltip = useCallback(() => {
    setTooltipState((prev) => ({ ...prev, data: null }));
  }, []);

  // Performance toggles
  const initialPerf = readPerfSettings();
  const [disableMapAnimations, setDisableMapAnimations] = useState<boolean>(
    initialPerf.disableMapAnimations,
  );
  const [disableObjectAnimations, setDisableObjectAnimations] = useState<boolean>(
    initialPerf.disableObjectAnimations,
  );

  // When parent provides controlled values, mirror them into local state
  const perfControlled =
    typeof controlledDisableMapAnimations === "boolean" &&
    typeof controlledDisableObjectAnimations === "boolean";

  useEffect(() => {
    if (
      typeof controlledDisableMapAnimations === "boolean" &&
      controlledDisableMapAnimations !== disableMapAnimations
    ) {
      setDisableMapAnimations(controlledDisableMapAnimations);
    }
  }, [controlledDisableMapAnimations, disableMapAnimations]);

  useEffect(() => {
    if (
      typeof controlledDisableObjectAnimations === "boolean" &&
      controlledDisableObjectAnimations !== disableObjectAnimations
    ) {
      setDisableObjectAnimations(controlledDisableObjectAnimations);
    }
  }, [controlledDisableObjectAnimations, disableObjectAnimations]);

  useEffect(() => {
    if (!perfControlled) {
      writePerfSettings({ disableMapAnimations, disableObjectAnimations });
    }
  }, [disableMapAnimations, disableObjectAnimations, perfControlled]);

  // Sprite limits UI state
  const [spriteLimitEnabled, setSpriteLimitEnabledInternal] = useState(false);
  const [spriteIssues, setSpriteIssues] = useState<SpriteLimitIssue[] | null>(null);
  const [spriteIssuesAll, setSpriteIssuesAll] = useState<SpriteLimitIssue[] | null>(null);
  const [spriteIssueIndex, setSpriteIssueIndex] = useState<number>(0);
  const [spriteScope, setSpriteScope] = useState<MapScope>("all");
  const [spriteScanlineLimit, setSpriteScanlineLimit] = useState<number>(10);
  const [spriteTotalLimit, setSpriteTotalLimit] = useState<number>(40);
  const [spriteIncludeFollower, setSpriteIncludeFollower] = useState<boolean>(false);
  const [spriteIncludeWeather, setSpriteIncludeWeather] = useState<boolean>(false);
  const [spriteOnlyErrors, setSpriteOnlyErrors] = useState<boolean>(false);
  // Weather UI state
  const [weatherEnabled, setWeatherEnabledInternal] = useState<boolean>(true);
  const [spriteAnalyzing, setSpriteAnalyzing] = useState<boolean>(false);
  const worldIssueHighlightRef = useRef<Graphics | null>(null);
  const mapBordersContainerRef = useRef<Container | null>(null);
  const [resultsCollapsed, setResultsCollapsed] = useState<boolean>(false);

  // Controlled weather/sprite-limit sync
  const weatherControlled = typeof controlledWeatherEnabled === "boolean";
  const spriteLimitControlled = typeof controlledSpriteLimitEnabled === "boolean";

  useEffect(() => {
    if (typeof controlledWeatherEnabled === "boolean" && controlledWeatherEnabled !== weatherEnabled) {
      setWeatherEnabledInternal(controlledWeatherEnabled);
    }
  }, [controlledWeatherEnabled, weatherEnabled]);

  useEffect(() => {
    if (typeof controlledSpriteLimitEnabled === "boolean" && controlledSpriteLimitEnabled !== spriteLimitEnabled) {
      setSpriteLimitEnabledInternal(controlledSpriteLimitEnabled);
    }
  }, [controlledSpriteLimitEnabled, spriteLimitEnabled]);

  const setWeatherEnabled = useCallback((enabled: boolean) => {
    setWeatherEnabledInternal(enabled);
    if (weatherControlled && onWeatherEnabledChange) {
      onWeatherEnabledChange(enabled);
    }
  }, [weatherControlled, onWeatherEnabledChange]);

  const setSpriteLimitEnabled = useCallback((enabled: boolean) => {
    setSpriteLimitEnabledInternal(enabled);
    if (spriteLimitControlled && onSpriteLimitEnabledChange) {
      onSpriteLimitEnabledChange(enabled);
    }
  }, [spriteLimitControlled, onSpriteLimitEnabledChange]);

  const baseOffsetsRef = useRef<Record<string, OffsetTuple>>({});
  const offsetOverridesRef = useRef<Record<string, OffsetTuple>>({});
  const zOverridesRef = useRef<Record<string, number>>({});

  // Ticker control: stop the PIXI ticker when both animations are disabled and render on-demand
  const updateTickerMode = useCallback((): void => {
    const app = appRef.current;
    if (!app) return;
    const staticMode = disableMapAnimations && disableObjectAnimations;
    try {
      if (staticMode) {
        if (app.ticker.started) app.ticker.stop();
      } else {
        if (!app.ticker.started) app.ticker.start();
      }
    } catch {
      /* ignore */
    }
  }, [disableMapAnimations, disableObjectAnimations]);

  const maybeRender = useCallback((): void => {
    const app = appRef.current;
    if (!app) return;
    if (disableMapAnimations && disableObjectAnimations) {
      try {
        app.render();
      } catch {
        /* ignore */
      }
    }
  }, [disableMapAnimations, disableObjectAnimations]);

  // Keep ticker mode in sync with performance toggles; render once when switching to static
  useEffect(() => {
    if (!ready) return;
    updateTickerMode();
    maybeRender();
  }, [ready, disableMapAnimations, disableObjectAnimations, updateTickerMode, maybeRender]);

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
    const blockPixelSize =
      atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize !== 0
        ? Math.max(1, Math.abs(atlas.blockPixelSize))
        : 16;
    const editingEnabled = Boolean(editing && onOffsetChange);
    const baseMap = baseOffsetsRef.current;
    const overrideMap = offsetOverridesRef.current;
    const zMap = zOverridesRef.current;
    const selectedId = selectedNeighborhoodId ?? null;

    for (const entry of animationsRef.current) {
      const { sprite, placement, order, neighborhoodId } = entry;
      const baseOffset =
        neighborhoodId && baseMap[neighborhoodId] ? baseMap[neighborhoodId] : [0, 0];
      const targetOffset =
        editingEnabled && neighborhoodId ? (overrideMap[neighborhoodId] ?? baseOffset) : baseOffset;
      const deltaXBlocks = targetOffset[0] - baseOffset[0];
      const deltaYBlocks = targetOffset[1] - baseOffset[1];
      sprite.x = placement.x + deltaXBlocks * blockPixelSize;
      sprite.y = placement.y + deltaYBlocks * blockPixelSize;

      const baseZ = placement.metadata?.neighborhoodZ ?? 0;
      const targetZ = editingEnabled && neighborhoodId ? (zMap[neighborhoodId] ?? baseZ) : baseZ;
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
    // In static mode, render on demand when transforms change
    maybeRender();
  }, [atlas, editing, onOffsetChange, selectedNeighborhoodId, maybeRender]);

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
    const blockPixelSize =
      atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize > 0
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
    [editing],
  );

  const drawSpriteIssueHighlight = useCallback(
    (issue: SpriteLimitIssue | null): void => {
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
      g.lineStyle(
        Math.max(1, state.cellSize * 0.1),
        issue.severity === "exceeds" ? 0xe74c3c : 0xf1c40f,
        0.95,
      );
      g.beginFill(issue.severity === "exceeds" ? 0xe74c3c : 0xf39c12, 0.15);
      g.drawRect(
        issue.viewportPx.x,
        issue.viewportPx.y,
        issue.viewportPx.width,
        issue.viewportPx.height,
      );
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
      // In static mode, ensure the highlight appears immediately
      maybeRender();
    },
    [maybeRender],
  );

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
      try {
        g.destroy({ children: true });
      } catch {
        /* ignore */
      }
      worldIssueHighlightRef.current = null;
    }
  }, []);

  const drawWorldIssueHighlight = useCallback(
    (entry: SyncedAnimation, issue: SpriteLimitIssue | null): void => {
      clearWorldIssueHighlight();
      if (!entry || !issue) return;
      const g = new Graphics();
      const blockPx =
        atlas && Number.isFinite(atlas.blockPixelSize) && (atlas.blockPixelSize as number) > 0
          ? Math.abs(atlas.blockPixelSize as number)
          : 16;
      g.lineStyle(
        Math.max(1, blockPx * 0.1),
        issue.severity === "exceeds" ? 0xe74c3c : 0xf1c40f,
        0.95,
      );
      g.beginFill(issue.severity === "exceeds" ? 0xe74c3c : 0xf39c12, 0.15);
      g.drawRect(
        issue.viewportPx.x,
        issue.viewportPx.y,
        issue.viewportPx.width,
        issue.viewportPx.height,
      );
      g.endFill();
      g.zIndex = 50;
      entry.sprite.addChild(g);
      entry.sprite.sortChildren();
      worldIssueHighlightRef.current = g;
      // Render once in static mode so the rectangle appears immediately
      maybeRender();
    },
    [atlas, clearWorldIssueHighlight, maybeRender],
  );

  // Map borders functions
  const clearMapBorders = useCallback((): void => {
    const container = mapBordersContainerRef.current;
    if (container) {
      try {
        container.destroy({ children: true });
      } catch {
        /* ignore */
      }
      mapBordersContainerRef.current = null;
    }
  }, []);

  const drawMapBorders = useCallback((): void => {
    clearMapBorders();
    const world = worldRef.current;
    if (!world || !mapBordersEnabled || animationsRef.current.length === 0) return;

    const container = new Container();
    container.zIndex = 10_000_001; // Just above warps layer
    container.eventMode = "none";

    const blockPx =
      atlas && Number.isFinite(atlas.blockPixelSize) && (atlas.blockPixelSize as number) > 0
        ? Math.abs(atlas.blockPixelSize as number)
        : 16;

    for (const entry of animationsRef.current) {
      const g = new Graphics();
      g.lineStyle(Math.max(1, blockPx * 0.15), 0x00ffff, 0.85); // Cyan border
      g.drawRect(
        entry.placement.x,
        entry.placement.y,
        entry.placement.widthPx,
        entry.placement.heightPx
      );
      container.addChild(g);
    }

    world.addChild(container);
    world.sortChildren();
    mapBordersContainerRef.current = container;
    maybeRender();
  }, [atlas, clearMapBorders, mapBordersEnabled, maybeRender]);

  // Update map borders when toggle changes
  useEffect(() => {
    if (!ready) return;
    if (mapBordersEnabled) {
      drawMapBorders();
    } else {
      clearMapBorders();
      maybeRender();
    }
  }, [ready, mapBordersEnabled, drawMapBorders, clearMapBorders, maybeRender]);

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
      const filtered = spriteOnlyErrors
        ? results.filter((r: SpriteLimitIssue) => r.severity === "exceeds")
        : results;
      setSpriteIssuesAll(results);
      setSpriteIssues(filtered);
      setSpriteIssueIndex(filtered.length > 0 ? 0 : 0);
    } catch (err) {
      console.warn("Sprite limit analysis (all) failed", err);
      setSpriteIssuesAll([]);
      setSpriteIssues([]);
    }
  }, [
    timeOfDay,
    spriteScope,
    spriteScanlineLimit,
    spriteTotalLimit,
    spriteIncludeFollower,
    spriteIncludeWeather,
    spriteOnlyErrors,
  ]);

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
    const filtered = spriteOnlyErrors
      ? spriteIssuesAll.filter((r: SpriteLimitIssue) => r.severity === "exceeds")
      : spriteIssuesAll;
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
    const resolution = renderer.resolution || 1;
    // Divide by resolution to get CSS pixels (PixiJS positions in CSS coords, not device pixels)
    const rendererWidth = Math.max(1, (renderer.width ?? renderer.screen?.width ?? 0) / resolution);
    const rendererHeight = Math.max(1, (renderer.height ?? renderer.screen?.height ?? 0) / resolution);

    if (background) {
      background.clear();
      background.beginFill(0x000000, Math.max(0, Math.min(1, state.baseAlpha ?? 0.9)));
      // Background needs to cover the full device pixel area
      background.drawRect(0, 0, rendererWidth * resolution, rendererHeight * resolution);
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

    // Helper to clamp position within bounds (with overscroll allowance)
    const clampAxis = (value: number, total: number, viewport: number): number => {
      if (!(total > 0) || !(viewport > 0)) {
        return value;
      }
      if (total <= viewport) {
        // Content fits - center it
        return (viewport - total) / 2;
      }
      // Content larger than viewport - allow some overscroll
      const overscroll = computeOverscrollPx(viewport, viewport);
      const min = viewport - total - overscroll;
      const max = 0 + overscroll;
      return Math.min(max, Math.max(min, value));
    };

    // Calculate centered position (works for both small and large content)
    const centeredX = (availableWidth - scaledWidth) / 2;
    const centeredY = (availableHeight - scaledHeight) / 2;

    let nextX: number;
    let nextY: number;

    if (state.userPanned) {
      // User has interacted - preserve their position but apply bounds
      nextX = clampAxis(sprite.x - padding, scaledWidth, availableWidth);
      nextY = clampAxis(sprite.y - padding, scaledHeight, availableHeight);
    } else {
      // No user interaction yet - always center the content
      nextX = centeredX;
      nextY = centeredY;
    }

    sprite.x = nextX + padding;
    sprite.y = nextY + padding;
    // Render once in static mode to reflect layout changes
    maybeRender();
  }, [maybeRender]);

  const closeOverlay = useCallback((): void => {
    overlayTokenRef.current += 1;
    const overlay = overlayRef.current;
    const state = overlayStateRef.current;
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
  // Overlay assets are short-lived; fully unload their BaseTexture via Assets
  // after destroying display objects to free GPU/CPU memory.
  disposeAnimationResource(state.resource, { unload: true });
    overlay.visible = false;
    overlayStateRef.current = null;
    // Notify parent of overlay close
    if (onOverlayChangeRef.current) {
      onOverlayChangeRef.current({ mapLabel: null, backlink: backlinkRef.current });
    }
    const world = worldRef.current;
    if (world) {
      world.visible = true;
    }
    // Reflect visibility change immediately in static mode
    maybeRender();
  }, [maybeRender]);

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

  const getViewState = useCallback((): MapViewState | null => {
    const app = appRef.current;
    const world = worldRef.current;
    const scale = scaleRef.current;
    if (!app || !world || !isFiniteNumber(scale) || scale <= 0) {
      return null;
    }
    const renderer = app.renderer;
    const centerWorldX = (-world.x + renderer.width / 2) / scale;
    const centerWorldY = (-world.y + renderer.height / 2) / scale;
    return {
      x: world.x,
      y: world.y,
      scale,
      centerWorldX,
      centerWorldY,
    };
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
      // Notify parent of view state change via ref to avoid dependency cycle
      const viewState = getViewState();
      if (viewState && onViewStateChangeRef.current) {
        onViewStateChangeRef.current(viewState);
      }
    }, 120);
  }, [persistViewState, getViewState]);

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
      maybeRender();
    },
    [clampWorldToBounds, schedulePersistViewState, maybeRender],
  );

  const setScaleAt = useCallback(
    (newScale: number, pivotX?: number, pivotY?: number): void => {
      const app = appRef.current;
      const world = worldRef.current;
      const bounds = boundsRef.current;
      if (!app || !world || !bounds) {
        return;
      }
      const { width: viewW, height: viewH } = getEffectiveViewSize(app);
      const oldScale = scaleRef.current;
      const clampedScale = clampScale(newScale);
      scaleRef.current = clampedScale;

      // Pivot defaults to center of view
      const px = pivotX !== undefined ? pivotX : viewW / 2;
      const py = pivotY !== undefined ? pivotY : viewH / 2;

      // Zoom towards the pivot point
      const worldPx = (px - world.x) / oldScale;
      const worldPy = (py - world.y) / oldScale;
      world.x = px - worldPx * clampedScale;
      world.y = py - worldPy * clampedScale;

      clampWorldToBounds();
      schedulePersistViewState();
      maybeRender();
    },
    [clampWorldToBounds, schedulePersistViewState, maybeRender],
  );

  const resolveTargetLabel = useCallback(
    (target: MapWarp["target"] | null | undefined): string | null => {
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
    },
    [],
  );

  const getMapMetadata = useCallback((mapLabel: string | null | undefined) => {
    if (typeof mapLabel !== "string" || mapLabel.trim().length === 0) {
      return null;
    }
    const metadata = warpMetadataRef.current?.maps?.[mapLabel];
    return metadata ?? null;
  }, []);

  // Load per-map weather state generated by the build pipeline
  type WeatherStateEntry = {
    constant?: string;
    overcast_index?: number | null;
    weather?: string | null;
  };
  type WeatherStatePayload = { maps?: Record<string, WeatherStateEntry> };
  const weatherStateRef = useRef<WeatherStatePayload | null>(null);

  const resolveWeatherStateUrl = useCallback((): string => {
    const override =
      typeof import.meta.env.VITE_WEATHER_STATE_URL === "string"
        ? import.meta.env.VITE_WEATHER_STATE_URL.trim()
        : "";
    if (override) {
      return withVersion(withBasePath(override));
    }
    if (import.meta.env.DEV) {
      const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
      if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
        const raw = `${repoRoot}/maps/weather_state.json`.replace(/\\/g, "/");
        const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
        return withVersion(`${window.location.origin}/@fs${encodeURI(withSlash)}`);
      }
    }
    return withVersion(joinBasePath("maps", "weather_state.json"));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      try {
        const url = resolveWeatherStateUrl();
        const res = await fetch(url, { signal: controller.signal });
        if (!res.ok) return;
        const payload = (await res.json()) as WeatherStatePayload;
        if (!cancelled) {
          weatherStateRef.current = payload;
        }
      } catch {
        // non-fatal; fall back to heuristic
      }
    };
    run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [resolveWeatherStateUrl]);

  // Determine weather for a map by constant/name using simplified game logic
  const computeMapWeather = useCallback(
    (mapLabel: string): "none" | "rain" | "thunderstorm" | "snow" | "sandstorm" => {
      const ws = weatherStateRef.current?.maps?.[mapLabel]?.weather;
      if (
        ws === "rain" ||
        ws === "thunderstorm" ||
        ws === "snow" ||
        ws === "sandstorm" ||
        ws === "none"
      ) {
        return ws;
      }
      const meta = getMapMetadata(mapLabel);
      const constant = meta?.mapConstant ?? "";
      const isOverworld = Boolean(meta?.isOverworld);
      const c = (constant || "").toUpperCase();
      // Snow maps
      const SNOW = new Set(["SNOWTOP_MOUNTAIN_OUTSIDE", "SNOWTOP_MOUNTAIN_INSIDE"]);
      // Sandstorm maps
      const SAND = new Set(["RUGGED_ROAD_NORTH", "RUGGED_ROAD_SOUTH"]);
      if (SNOW.has(c)) return "snow";
      if (SAND.has(c)) return "sandstorm";
      // Overcast-related (rain/thunderstorm); overworld only
      if (!isOverworld) return "none";
      const AZALEA = new Set(["AZALEA_TOWN", "ROUTE_33"]);
      const LOR = new Set(["LAKE_OF_RAGE", "ROUTE_43"]);
      const STORMY = new Set([
        "STORMY_BEACH",
        "GOLDENROD_CITY",
        "MAGNET_TUNNEL_WEST",
        "ROUTE_34",
        "ROUTE_34_COAST",
      ]);
      let overcast = false;
      if (AZALEA.has(c)) {
        // Default weekday = 1 (Monday) like the Python tooling; Azalea days are {0,2,4,6} (not Monday)
        overcast = false;
      } else if (LOR.has(c)) {
        // Lake of Rage overcast days {1,3,5}; default Monday -> yes
        overcast = true;
      } else if (STORMY.has(c)) {
        overcast = true;
      }
      if (!overcast) return "none";
      // Stable 25% thunderstorm selection based on map label hash
      let h = 0;
      for (let i = 0; i < mapLabel.length; i++) h = (h * 31 + mapLabel.charCodeAt(i)) >>> 0;
      const ratio = (h % 1000) / 1000;
      return ratio < 0.25 ? "thunderstorm" : "rain";
    },
    [getMapMetadata],
  );

  const getWarpMetadata = useCallback(
    (mapLabel: string | null | undefined, warpIndex: number | null | undefined) => {
      if (typeof warpIndex !== "number" || !Number.isFinite(warpIndex)) {
        return null;
      }
      const mapMeta = getMapMetadata(mapLabel);
      if (!mapMeta || !Array.isArray(mapMeta.warps)) {
        return null;
      }
      return mapMeta.warps.find((item: MapWarp) => item.index === warpIndex) ?? null;
    },
    [getMapMetadata],
  );

  const getCollisionMetadata = useCallback((mapLabel: string | null | undefined) => {
    if (typeof mapLabel !== "string" || mapLabel.trim().length === 0) {
      return null;
    }
    const collision = warpMetadataRef.current?.maps?.[mapLabel]?.collision ?? null;
    if (!collision || collision.cellBytes.length === 0) {
      return null;
    }
    return collision;
  }, []);

  const findWorldEntry = useCallback(
    (mapLabel: string | null | undefined): SyncedAnimation | null => {
      if (typeof mapLabel !== "string" || mapLabel.trim().length === 0) {
        return null;
      }
      return (
        animationsRef.current.find((item: SyncedAnimation) => item.placement.label === mapLabel) ??
        null
      );
    },
    [],
  );

  const focusEntryOnWarp = useCallback(
    (
      entry: SyncedAnimation | null,
      coordinates: { xCells: number | null; yCells: number | null } | null | undefined,
    ): void => {
      if (!entry) {
        return;
      }
      const cellSize = computeCellSize();
      if (
        coordinates &&
        typeof coordinates.xCells === "number" &&
        Number.isFinite(coordinates.xCells) &&
        typeof coordinates.yCells === "number" &&
        Number.isFinite(coordinates.yCells)
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
    [computeCellSize, focusWorldOn],
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

    // Provide BG palettes for this overlay map to the cache (if available)
    try {
      const bg = bgPalettes?.maps?.[state.mapLabel]?.palettes?.[timeOfDay] ?? null;
      cache.setBgPalettes(bg ?? null);
    } catch {
      cache.setBgPalettes(null);
    }

    // Set palette selection context for overlay map
    try {
      const mapMeta = getMapMetadata(state.mapLabel);
      const isOverworld = Boolean(mapMeta?.isOverworld);
      const isIndoor = !isOverworld;
      const weatherType = computeMapWeather(state.mapLabel);
      const isOvercast = weatherType === "rain" || weatherType === "thunderstorm";
      const constant = (mapMeta?.mapConstant || "").toUpperCase();
      const label = (mapMeta?.label || state.mapLabel || "").toUpperCase();
      const isDarkness =
        constant.includes("DARK_CAVE") ||
        label.includes("DARKCAVE") ||
        constant.includes("WHIRL_ISLANDS") ||
        label.includes("WHIRLISLANDS");
      cache.setPaletteContext({ indoor: isIndoor, overcast: isOvercast && isOverworld, darkness: isDarkness });
    } catch {
      cache.setPaletteContext({ indoor: false, overcast: false, darkness: false });
    }

    const metadataBlockSize =
      Number.isFinite(metadata.blockPixelSize) && metadata.blockPixelSize > 0
        ? Math.abs(metadata.blockPixelSize)
        : 32;
    const cellsPerBlock =
      Number.isFinite(metadata.cellsPerBlock) && metadata.cellsPerBlock > 0
        ? Math.trunc(metadata.cellsPerBlock)
        : 2;
    const baseCellPixelSize =
      Number.isFinite(metadata.eventCellPixelSize) && metadata.eventCellPixelSize > 0
        ? Math.abs(metadata.eventCellPixelSize)
        : Math.max(1, Math.trunc(metadataBlockSize / Math.max(1, cellsPerBlock)));

    const widthBlocks =
      Number.isFinite(mapData.widthBlocks) && mapData.widthBlocks && mapData.widthBlocks > 0
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
    const atlasCellPixelSize =
      cellsPerBlock > 0 ? atlasBlockPixelSize / cellsPerBlock : atlasBlockPixelSize;

    let container = state.objectContainer;
    if (!container) {
      container = new Container();
      // Make container participate in hit testing so children can receive pointer events
      container.eventMode = "static";
      container.interactiveChildren = true;
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
        frameSet = buildMovementFrameSet(
          cache,
          spriteKey,
          spriteDef,
          paletteName,
          facingKey,
          record,
        );
      }

      if (!baseFrame || !frameSet) {
        continue;
      }
      const spriteInstance = new Sprite(baseFrame.texture);
      // Default to not interactive unless it's a clickable object
      spriteInstance.eventMode = "none";
      spriteInstance.cursor = "auto";
      const { x: baseX, y: baseY } = computeObjectPosition(objectEntry, placementContext);
      const offsetX = baseFrame.offsetX * pixelScale;
      const offsetY = baseFrame.offsetY * pixelScale;
      spriteInstance.x = baseX + offsetX;
      spriteInstance.y = baseY + offsetY;
      spriteInstance.scale.set(pixelScale);
      container.addChild(spriteInstance);
      // If this object is an item/key/TM/HM ball or fruit tree, enable pointer interactions and show tooltip
      try {
        const macro = objectEntry.macro ?? "";
        const isBall =
          macro === "itemball_event" || macro === "keyitemball_event" || macro === "tmhmball_event";
        const isFruitTree = macro === "fruittree_event";
        if (isBall) {
          spriteInstance.eventMode = "static";
          spriteInstance.cursor = editing ? "not-allowed" : "pointer";
          const label =
            (objectEntry.extra && (objectEntry.extra["item"] as string)) ||
            objectEntry.script?.argument ||
            "Item";
          spriteInstance.on("pointerover", (ev: FederatedPointerEvent) => {
            if (editing) return;
            const x = (ev as any).clientX ?? window.innerWidth / 2;
            const y = (ev as any).clientY ?? window.innerHeight / 2;
            showTooltip({ title: String(label) }, x, y);
          });
          spriteInstance.on("pointerout", () => {
            hideTooltip();
          });
        }
        if (isFruitTree && !editing) {
          spriteInstance.eventMode = "static";
          spriteInstance.cursor = "pointer";
          const berryName =
            (objectEntry.extra && (objectEntry.extra["berry"] as string)) || "Berry";
          // Format berry name for display (e.g., "WHT_APRICORN" -> "Wht Apricorn")
          const displayName = berryName
            .split("_")
            .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
            .join(" ");
          spriteInstance.on("pointerover", (ev: FederatedPointerEvent) => {
            const x = (ev as any).clientX ?? window.innerWidth / 2;
            const y = (ev as any).clientY ?? window.innerHeight / 2;
            showTooltip({ title: displayName, subtitle: "Berry Tree" }, x, y);
          });
          spriteInstance.on("pointerout", () => {
            hideTooltip();
          });
        }
      } catch {
        /* ignore tooltip wiring failures */
      }
      // Enable click-to-link for trainers
      try {
        const trainerConstant = objectEntry.objectType?.constant;
        const isTrainer = trainerConstant === "OBJECTTYPE_TRAINER" || trainerConstant === "OBJECTTYPE_GENERICTRAINER";
        if (isTrainer && !editing) {
          const trainerName = objectEntry.script?.argument ?? "";
          const mapLabel = state.mapLabel ?? "";
          if (trainerName && mapLabel) {
            spriteInstance.eventMode = "static";
            spriteInstance.cursor = "pointer";
            const mapSlug = mapLabel.toLowerCase().replace(/_/g, "");
            const url = `https://polisheddex.app/locations/${mapSlug}/#${trainerName}`;
            // Format trainer name for display (remove "Trainer" prefix and add spaces before capitals)
            const displayName = trainerName
              .replace(/^Trainer/, "")
              .replace(/([A-Z])/g, " $1")
              .trim();
            spriteInstance.on("pointerover", (ev: FederatedPointerEvent) => {
              const x = (ev as any).clientX ?? window.innerWidth / 2;
              const y = (ev as any).clientY ?? window.innerHeight / 2;
              showTooltip(
                { title: displayName, subtitle: "Click to view team" },
                x,
                y,
              );
            });
            spriteInstance.on("pointerout", () => {
              hideTooltip();
            });
            spriteInstance.on("pointertap", (ev: FederatedPointerEvent) => {
              ev.stopPropagation();
              hideTooltip();
              window.open(url, "_blank", "noopener,noreferrer");
            });
          }
        }
      } catch {
        /* ignore trainer link wiring failures */
      }
      const movementSummary = disableObjectAnimations
        ? null
        : computeMovementSummaryForObject(objectEntry, state.collisionHelper);
      let animator = disableObjectAnimations
        ? null
        : createMovementAnimator(movementSummary, objectEntry, frameSet);
      if (
        !disableObjectAnimations &&
        !animator &&
        spriteKey === "SPRITE_MON_ICON" &&
        iconFrameDurationMs
      ) {
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
      if (disableObjectAnimations) {
        applySpriteFrame(
          marker,
          marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null,
          0,
        );
        marker.sprite.x = marker.basePosition.x + marker.spriteOffset.x;
        marker.sprite.y = marker.basePosition.y + marker.spriteOffset.y;
        marker.stepCount = null;
        marker.currentStepIndex = null;
        marker.stepProgress = 0;
      } else {
        updateMarkerAnimation(marker, overlayElapsed);
      }
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
    // Render on demand to apply overlay object changes in static mode
    maybeRender();
  }, [atlas, maybeRender, getCollisionMetadata, bgPalettes?.maps, timeOfDay, getMapMetadata, computeMapWeather, disableObjectAnimations, editing, showTooltip, hideTooltip]);

  const openOverlay = useCallback(
    async (
      mapLabel: string,
      highlight?: {
        xCells?: number | null;
        yCells?: number | null;
      },
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
        if (
          highlight &&
          typeof highlight.xCells === "number" &&
          typeof highlight.yCells === "number"
        ) {
          if (existing.highlight) {
            try {
              existing.highlight.destroy({ children: true });
            } catch {
              /* ignore */
            }
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
        positionOverlayContents();
        // Force immediate render so the overlay appears centered right away
        try {
          app.render();
        } catch {
          /* ignore */
        }
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
          disposeAnimationResource(resource, { unload: true });
          return;
        }
        closeOverlay();
        if (!overlayRef.current) {
          disposeAnimationResource(resource, { unload: true });
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

        // Create warp transition flash effect
        const transitionFlash = new Graphics();
        transitionFlash.beginFill(0x88ddff, 0.6); // Light cyan flash
        transitionFlash.drawRect(0, 0, 10000, 10000); // Large enough to cover viewport
        transitionFlash.endFill();
        transitionFlash.zIndex = 1000; // Above everything
        transitionFlash.eventMode = "none";
        overlay.addChild(transitionFlash);
        overlay.sortChildren();
        // Animate flash fade-out
        let flashAlpha = 0.6;
        const fadeFlash = (): void => {
          flashAlpha -= 0.04;
          if (flashAlpha <= 0) {
            transitionFlash.visible = false;
            transitionFlash.alpha = 0;
            return;
          }
          transitionFlash.alpha = flashAlpha;
          requestAnimationFrame(fadeFlash);
        };
        requestAnimationFrame(fadeFlash);

        const objectContainer = new Container();
        // Make container interactive so children can receive pointer events
        objectContainer.eventMode = "static";
        objectContainer.interactiveChildren = true;
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
            if (
              typeof xCells !== "number" ||
              !Number.isFinite(xCells) ||
              typeof yCells !== "number" ||
              !Number.isFinite(yCells)
            ) {
              continue;
            }
            const graphic = new Graphics();
            const margin = Math.max(0, cellSize * 0.1);
            const radius = Math.max(4, cellSize * 0.25);
            graphic.beginFill(0x1abc9c, 0.35);
            graphic.lineStyle(Math.max(1, cellSize * 0.08), 0xffffff, 0.9);
            graphic.drawRoundedRect(
              margin,
              margin,
              cellSize - margin * 2,
              cellSize - margin * 2,
              radius,
            );
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
          typeof highlight.xCells === "number" &&
          Number.isFinite(highlight.xCells) &&
          typeof highlight.yCells === "number" &&
          Number.isFinite(highlight.yCells)
        ) {
          highlightGraphic = new Graphics();
          const margin = Math.max(0, cellSize * 0.1);
          const radius = Math.max(4, cellSize * 0.25);
          highlightGraphic.lineStyle(Math.max(1, cellSize * 0.1), 0xf1c40f, 0.95);
          highlightGraphic.beginFill(0xf39c12, 0.3);
          highlightGraphic.drawRoundedRect(
            margin,
            margin,
            cellSize - margin * 2,
            cellSize - margin * 2,
            radius,
          );
          highlightGraphic.endFill();
          highlightGraphic.x = highlight.xCells * cellSize;
          highlightGraphic.y = highlight.yCells * cellSize;
          highlightGraphic.eventMode = "none";
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

        overlayStateRef.current = {
          mapLabel,
          sprite,
          resource,
          background,
          markers,
          highlight: highlightGraphic,
          transitionFlash,
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
          userPanned: false,
        };
        const elapsed = Math.max(0, app.ticker.lastTime - syncStartRef.current);
        const initialFrame = frameIndexForTime(
          elapsed,
          resource.frameDurations,
          resource.loopDuration,
        );
        if (sprite.currentFrame !== initialFrame) {
          sprite.gotoAndStop(initialFrame);
        }
        refreshOverlayObjects();
        // Position overlay BEFORE making it visible to avoid flash at (0,0)
        positionOverlayContents();
        const world = worldRef.current;
        if (world) {
          world.visible = false;
        }
        overlay.visible = true;
        if (typeof window !== "undefined") {
          window.addEventListener("keydown", keyHandler);
        }
        // Force immediate render so the overlay appears centered right away
        try {
          app.render();
        } catch {
          /* ignore */
        }
        // Notify parent of overlay open
        if (onOverlayChangeRef.current) {
          onOverlayChangeRef.current({ mapLabel, backlink: backlinkRef.current });
        }
      } catch (err) {
        if (overlayTokenRef.current === token) {
          console.error(`Failed to open overlay for ${mapLabel}`, err);
        }
      }
    },
    [
      closeOverlay,
      computeCellSize,
      getMapMetadata,
      getCollisionMetadata,
      positionOverlayContents,
      refreshOverlayObjects,
      resolveAssetHref,
    ],
  );

  // Expose imperative handle for parent components
  useImperativeHandle(
    ref,
    () => ({
      focusWorldOn,
      setScale: (scale: number) => setScaleAt(scale),
      getViewState,
      getApp: () => appRef.current,
      resetView: () => resetViewRef.current?.(),
      closeOverlay,
      openOverlay,
      setBacklink: (backlink: WarpBacklink | null) => {
        backlinkRef.current = backlink;
      },
    }),
    [focusWorldOn, setScaleAt, getViewState, closeOverlay, openOverlay],
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
    [
      editing,
      findWorldEntry,
      focusEntryOnWarp,
      getMapMetadata,
      highlightWarpMarker,
      openOverlay,
      resolveTargetLabel,
    ],
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
        const marker = entry.markers.find((item: WarpMarkerEntry) => item.warp.index === warpIndex);
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
    [
      closeOverlay,
      findWorldEntry,
      focusEntryOnWarp,
      getMapMetadata,
      getWarpMetadata,
      highlightWarpMarker,
      openOverlay,
      resolveTargetLabel,
    ],
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
        if (
          typeof xCells !== "number" ||
          !Number.isFinite(xCells) ||
          typeof yCells !== "number" ||
          !Number.isFinite(yCells)
        ) {
          continue;
        }
        const graphic = new Graphics();
        const margin = Math.max(0, cellSize * 0.1);
        const radius = Math.max(4, cellSize * 0.25);
        graphic.beginFill(0x1abc9c, 0.35);
        graphic.lineStyle(Math.max(1, cellSize * 0.08), 0xffffff, 0.9);
        graphic.drawRoundedRect(
          margin,
          margin,
          cellSize - margin * 2,
          cellSize - margin * 2,
          radius,
        );
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
        graphic.on("pointerover", (ev: FederatedPointerEvent) => {
          if (editing) {
            return;
          }
          graphic.alpha = 1;
          // Show tooltip with destination
          const targetLabel = warp.target?.mapLabel;
          if (targetLabel) {
            // Format map label for display (add spaces before capitals, handle underscores)
            const displayLabel = targetLabel
              .replace(/_/g, " ")
              .replace(/([a-z])([A-Z])/g, "$1 $2")
              .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
            const x = (ev as any).clientX ?? window.innerWidth / 2;
            const y = (ev as any).clientY ?? window.innerHeight / 2;
            showTooltip({ title: `To: ${displayLabel}` }, x, y);
          }
        });
        graphic.on("pointerout", () => {
          if (editing) {
            return;
          }
          graphic.alpha = baseAlpha;
          hideTooltip();
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
    // Reflect marker changes in static mode
    maybeRender();
  }, [computeCellSize, editing, handleWarpMarkerTap, maybeRender, clearHighlightTimers, showTooltip, hideTooltip]);

  const refreshObjectSprites = useCallback((): void => {
    const metadata = objectMetadataRef.current;
    const cache = objectSpriteCacheRef.current;
    const atlasBlockSize =
      atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize > 0
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

    const metadataBlockSize =
      Number.isFinite(metadata.blockPixelSize) && metadata.blockPixelSize > 0
        ? Math.abs(metadata.blockPixelSize)
        : atlasBlockSize;
    const cellsPerBlock =
      Number.isFinite(metadata.cellsPerBlock) && metadata.cellsPerBlock > 0
        ? Math.trunc(metadata.cellsPerBlock)
        : 2;
    const baseCellPixelSize =
      Number.isFinite(metadata.eventCellPixelSize) && metadata.eventCellPixelSize > 0
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
        // Make container participate in hit testing so children can receive pointer events
        container.eventMode = "static";
        container.interactiveChildren = true;
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

      // Provide BG palettes for this world map to the cache (if available) before building sprite textures
      try {
        const bg = bgPalettes?.maps?.[entry.placement.label]?.palettes?.[timeOfDay] ?? null;
        cache.setBgPalettes(bg ?? null);
      } catch {
        cache.setBgPalettes(null);
      }

      // Compute and set palette selection context per map
      try {
        const mapMeta = getMapMetadata(entry.placement.label);
        const isOverworld = Boolean(mapMeta?.isOverworld);
        const isIndoor = !isOverworld;
        const weatherType = computeMapWeather(entry.placement.label);
        const isOvercast = weatherType === "rain" || weatherType === "thunderstorm";
        // Heuristic for darkness: prefer explicit Dark Cave variants; extendable later
        const constant = (mapMeta?.mapConstant || "").toUpperCase();
        const label = (mapMeta?.label || entry.placement.label || "").toUpperCase();
        const isDarkness =
          // Known darkness maps
          constant.includes("DARK_CAVE") ||
          label.includes("DARKCAVE") ||
          // Some multi-map areas that are dark in-game; broaden gently
          constant.includes("WHIRL_ISLANDS") ||
          label.includes("WHIRLISLANDS");
        cache.setPaletteContext({ indoor: isIndoor, overcast: isOvercast && isOverworld, darkness: isDarkness });
      } catch {
        cache.setPaletteContext({ indoor: false, overcast: false, darkness: false });
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
          frameSet = buildMovementFrameSet(
            cache,
            spriteKey,
            spriteDef,
            paletteName,
            facingKey,
            record,
          );
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
        // If this object is an item/key/TM/HM ball or fruit tree, enable pointer interactions and show tooltip
        try {
          const macro = objectEntry.macro ?? "";
          const isBall =
            macro === "itemball_event" ||
            macro === "keyitemball_event" ||
            macro === "tmhmball_event";
          const isFruitTree = macro === "fruittree_event";
          if (isBall) {
            sprite.eventMode = "static";
            sprite.cursor = editing ? "not-allowed" : "pointer";
            const label =
              (objectEntry.extra && (objectEntry.extra["item"] as string)) ||
              objectEntry.script?.argument ||
              "Item";
            sprite.on("pointerover", (ev: FederatedPointerEvent) => {
              if (editing) return;
              const x = (ev as any).clientX ?? window.innerWidth / 2;
              const y = (ev as any).clientY ?? window.innerHeight / 2;
              showTooltip({ title: String(label) }, x, y);
            });
            sprite.on("pointerout", () => {
              hideTooltip();
            });
          }
          if (isFruitTree && !editing) {
            sprite.eventMode = "static";
            sprite.cursor = "pointer";
            const berryName =
              (objectEntry.extra && (objectEntry.extra["berry"] as string)) || "Berry";
            // Format berry name for display (e.g., "WHT_APRICORN" -> "Wht Apricorn")
            const displayName = berryName
              .split("_")
              .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
              .join(" ");
            sprite.on("pointerover", (ev: FederatedPointerEvent) => {
              const x = (ev as any).clientX ?? window.innerWidth / 2;
              const y = (ev as any).clientY ?? window.innerHeight / 2;
              showTooltip({ title: displayName, subtitle: "Berry Tree" }, x, y);
            });
            sprite.on("pointerout", () => {
              hideTooltip();
            });
          }
        } catch {
          /* ignore tooltip wiring failures */
        }
        // Enable click-to-link for trainers
        try {
          const trainerConstant = objectEntry.objectType?.constant;
          const isTrainer = trainerConstant === "OBJECTTYPE_TRAINER" || trainerConstant === "OBJECTTYPE_GENERICTRAINER";
          if (isTrainer && !editing) {
            const trainerName = objectEntry.script?.argument ?? "";
            const mapLabel = entry.placement.label ?? "";
            if (trainerName && mapLabel) {
              sprite.eventMode = "static";
              sprite.cursor = "pointer";
              const mapSlug = mapLabel.toLowerCase().replace(/_/g, "");
              const url = `https://polisheddex.app/locations/${mapSlug}/#${trainerName}`;
              // Format trainer name for display (remove "Trainer" prefix and add spaces before capitals)
              const displayName = trainerName
                .replace(/^Trainer/, "")
                .replace(/([A-Z])/g, " $1")
                .trim();
              sprite.on("pointerover", (ev: FederatedPointerEvent) => {
                const x = (ev as any).clientX ?? window.innerWidth / 2;
                const y = (ev as any).clientY ?? window.innerHeight / 2;
                showTooltip(
                  { title: displayName, subtitle: "Click to view team" },
                  x,
                  y,
                );
              });
              sprite.on("pointerout", () => {
                hideTooltip();
              });
              sprite.on("pointertap", (ev: FederatedPointerEvent) => {
                ev.stopPropagation();
                hideTooltip();
                window.open(url, "_blank", "noopener,noreferrer");
              });
            }
          }
        } catch {
          /* ignore trainer link wiring failures */
        }
        const movementSummary = disableObjectAnimations
          ? null
          : computeMovementSummaryForObject(objectEntry, entry.collisionHelper);
        let animator = disableObjectAnimations
          ? null
          : createMovementAnimator(movementSummary, objectEntry, frameSet);
        if (
          !disableObjectAnimations &&
          !animator &&
          spriteKey === "SPRITE_MON_ICON" &&
          iconFrameDurationMs
        ) {
          const idleAnimator = createPokemonIconAnimator(
            objectEntry,
            frameSet,
            iconFrameDurationMs,
          );
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
        if (disableObjectAnimations) {
          applySpriteFrame(
            marker,
            marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null,
            0,
          );
          marker.sprite.x = marker.basePosition.x + marker.spriteOffset.x;
          marker.sprite.y = marker.basePosition.y + marker.spriteOffset.y;
          marker.stepCount = null;
          marker.currentStepIndex = null;
          marker.stepProgress = 0;
        } else {
          updateMarkerAnimation(marker, entryElapsed);
        }
      }

      if (container.children.length === 0) {
        entry.sprite.removeChild(container);
        container.destroy();
        entry.objectContainer = null;
      }
      entry.sprite.sortChildren();
    }
    // Render on demand to apply world object changes in static mode
    maybeRender();
  }, [
    atlas,
    timeOfDay,
    bgPalettes,
    getCollisionMetadata,
    getMapMetadata,
    computeMapWeather,
    maybeRender,
    editing,
    disableObjectAnimations,
    showTooltip,
    hideTooltip,
  ]);

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
      // Global weather overlay no longer used; per-map weather is attached to each map sprite.
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
      (app.view as unknown as HTMLCanvasElement).addEventListener(
        "_pixi_cleanup",
        cleanupVisibility,
        { once: true } as any,
      );
      // Weather ticker: update per-map systems using world pan delta
      const weatherTick = (_delta: number): void => {
        const w = worldRef.current;
        if (!w) return;
        // Compute camera step in screen pixels since last tick
        const prev: any = weatherTick as any;
        const lastX: number = typeof prev._lastX === "number" ? prev._lastX : w.x;
        const lastY: number = typeof prev._lastY === "number" ? prev._lastY : w.y;
        const stepX = w.x - lastX;
        const stepY = w.y - lastY;
        (weatherTick as any)._lastX = w.x;
        (weatherTick as any)._lastY = w.y;
        // In static mode, skip updates
        if (disableMapAnimations) return;
        // Update each weather field
        for (const entry of animationsRef.current) {
          if (entry.weather) {
            entry.weather.update(stepX, stepY);
          }
        }
      };
      try {
        app.ticker.add(weatherTick);
      } catch {
        /* ignore */
      }
      weatherTickerRef.current = weatherTick;
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
        // Detach weather ticker
        const weatherTick = weatherTickerRef.current;
        if (weatherTick) {
          try {
            app.ticker.remove(weatherTick);
          } catch {
            /* ignore */
          }
          weatherTickerRef.current = null;
        }
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
      // Destroy any lingering global weather (not used) and per-map instances will be destroyed in disposeAnimations
      if (weatherSystemRef.current) {
        try {
          weatherSystemRef.current.clear();
        } catch {
          /* ignore */
        }
        weatherSystemRef.current = null;
      }
      scaleRef.current = 1;
      boundsRef.current = null;
      resetViewRef.current = () => undefined;
      if (container.firstChild instanceof HTMLCanvasElement) {
        container.removeChild(container.firstChild);
      }
    };
  }, [closeOverlay, clearHighlightTimers, disableMapAnimations]);

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
        if (entry.weather) {
          try {
            entry.weather.destroy();
          } catch {
            /* ignore */
          }
          entry.weather = null;
        }
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
        // Do not destroy the map sprite here. We'll remove and destroy all remaining
        // world children in disposeChildren() to avoid double-destroy on the same
        // DisplayObject (which can crash PIXI internals in some versions).
        for (const marker of entry.warpMarkers ?? []) {
          // Detach listeners but defer actual destruction to the parent container
          // teardown in disposeChildren() to avoid double-destroy ordering issues.
          try {
            marker.graphic.removeAllListeners();
          } catch {
            /* ignore */
          }
          // Optionally detach from parent; it will be destroyed below anyway.
          const parent = (marker.graphic as any).parent as Container | null;
          if (parent) {
            try {
              parent.removeChild(marker.graphic);
            } catch {
              /* ignore */
            }
          }
        }
        entry.warpMarkers = [];
        // Do NOT unload via Assets here; multiple entries share the same BaseTexture by URL
        // and unloading can nuke textures still in use.
        // Important: do not dispose textures for world entries here. The associated
        // AnimatedSprite will be destroyed in disposeChildren() below, and destroying
        // the Texture wrappers first can lead to PIXI internals touching a null
        // baseTexture during sprite destruction. We rely on sprite.destroy() to
        // release its resources safely.
      }
    };

    const disposeChildren = (): void => {
      closeOverlay();
      disposeAnimations();
      const removed = world.removeChildren();
      for (const child of removed) {
        const anyChild: any = child as any;
        if (typeof anyChild.destroy === "function") {
          try {
            // Ensure we destroy container subtrees to clean up Graphics/Sprites safely.
            if (child instanceof Container) {
              anyChild.destroy({ children: true });
            } else {
              anyChild.destroy();
            }
          } catch {
            /* ignore destroy issues */
          }
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
      // Render once in static mode after resetting
      maybeRender();
    };

    resetViewRef.current = resetView;

    const tasks = atlas.placements.map(
      async (placement: MapPlacement, index: number): Promise<AnimatedSprite | null> => {
        if (!placement.asset) {
          return null;
        }
        try {
          const resource = await loadMapAnimation(placement.asset);
          if (cancelled) {
            // Cancelled world load: do not unload, just discard wrapper textures
            disposeAnimationResource(resource, { unload: false });
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
          // Only show pointer on truly clickable UI (e.g., warps, items). Default to auto for maps.
          sprite.cursor = "auto";
          sprite.sortableChildren = true;
          const neighborhoodId =
            typeof placement.metadata?.neighborhoodId === "string"
              ? placement.metadata.neighborhoodId
              : null;
          const neighborhoodZ = placement.metadata?.neighborhoodZ ?? 0;
          const localMapZ = Number.isFinite(placement.metadata?.mapZ as number)
            ? Math.trunc((placement.metadata?.mapZ as number) || 0)
            : index;
          sprite.zIndex = neighborhoodZ * 1_000_000 + localMapZ * 1_000 + index;
          world.addChild(sprite);
          world.sortChildren();
          // In static mode, force a render after adding each map sprite so cached textures appear immediately
          maybeRender();
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
            weather: null,
          };
          animationsRef.current.push(entry);
          spriteEntryMapRef.current.set(sprite, entry);
          // Attach per-map weather if applicable
          if (weatherEnabled) {
            const type = computeMapWeather(placement.label);
            if (type !== "none") {
              try {
                const appInst = appRef.current;
                if (appInst) {
                  const ws = new WeatherSystem(appInst, sprite);
                  ws.setBounds(placement.widthPx, placement.heightPx);
                  ws.setTimeOfDay(timeOfDay as any);
                  ws.setEnabled(!disableMapAnimations);
                  ws.setWeather(type as any);
                  entry.weather = ws;
                }
              } catch {
                /* ignore weather setup failures */
              }
            }
          }
          return sprite;
        } catch (err) {
          console.error(`Failed to load animation for ${placement.label}`, err);
          return null;
        }
      },
    );

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
        // Draw map borders if enabled
        if (mapBordersEnabled) {
          drawMapBorders();
        }
      })
      .catch((err) => {
        console.error("Failed to load map sprites", err);
      })
      .finally(() => {
        if (!cancelled) {
          app.resize();
          // Ensure ticker mode matches current settings and render once in static mode
          updateTickerMode();
          maybeRender();
          // Fallback: when in full static mode, request one more render on the next frame to
          // cover cases where textures were ready from cache but not uploaded before the first draw.
          if (disableMapAnimations && disableObjectAnimations) {
            try {
              if (typeof window !== "undefined") {
                window.requestAnimationFrame(() => {
                  const inst = appRef.current;
                  if (inst) {
                    try {
                      inst.render();
                    } catch {
                      /* ignore */
                    }
                  }
                });
              }
            } catch {
              /* ignore */
            }
          }
        }
      });

    return () => {
      cancelled = true;
      disposeChildren();
    };
  }, [
    atlas,
    ready,
    clampWorldToBounds,
    persistViewState,
    restoreViewState,
    applySpriteTransforms,
    refreshOverlayObjects,
    refreshWarpMarkers,
    refreshObjectSprites,
    getCollisionMetadata,
    updateTickerMode,
    maybeRender,
    disableMapAnimations,
    disableObjectAnimations,
    weatherEnabled,
    computeMapWeather,
    timeOfDay,
    clearHighlightTimers,
    closeOverlay,
    mapBordersEnabled,
    drawMapBorders,
  ]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    refreshWarpMarkers();
    refreshObjectSprites();
    refreshOverlayObjects();
    const snapshot = [...animationsRef.current];
    return () => {
      for (const entry of snapshot) {
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
  }, [
    ready,
    refreshOverlayObjects,
    refreshWarpMarkers,
    refreshObjectSprites,
    warpMetadata,
    atlas,
    editing,
  ]);

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
      let cullX = 0,
        cullY = 0,
        cullW = 0,
        cullH = 0;
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
      const rectsIntersect = (
        ax: number,
        ay: number,
        aw: number,
        ah: number,
        bx: number,
        by: number,
        bw: number,
        bh: number,
      ): boolean => ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

      for (const entry of animationsRef.current) {
        // Culling based on sprite position and first frame dimensions
        const texW = entry.resource.textures[0]?.width ?? entry.sprite.width;
        const texH = entry.resource.textures[0]?.height ?? entry.sprite.height;
        const isVisible = rectsIntersect(
          entry.sprite.x,
          entry.sprite.y,
          texW,
          texH,
          cullX,
          cullY,
          cullW,
          cullH,
        );
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

        if (disableMapAnimations) {
          if (entry.sprite.currentFrame !== 0) {
            entry.sprite.gotoAndStop(0);
          }
        } else {
          const nextFrame = frameIndexForTime(
            elapsed,
            entry.resource.frameDurations,
            entry.resource.loopDuration,
          );
          if (entry.sprite.currentFrame !== nextFrame) {
            entry.sprite.gotoAndStop(nextFrame);
          }
        }
        for (const marker of entry.objectMarkers) {
          if (disableObjectAnimations) {
            applySpriteFrame(
              marker,
              marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null,
              0,
            );
            marker.sprite.x =
              entry.placement.x +
              marker.basePosition.x -
              marker.basePosition.x +
              marker.spriteOffset.x;
            marker.sprite.y =
              entry.placement.y +
              marker.basePosition.y -
              marker.basePosition.y +
              marker.spriteOffset.y;
            // Note: basePosition is already absolute within entry sprite; maintain that
            marker.sprite.x = marker.basePosition.x + marker.spriteOffset.x;
            marker.sprite.y = marker.basePosition.y + marker.spriteOffset.y;
            marker.stepCount = null;
            marker.currentStepIndex = null;
            marker.stepProgress = 0;
          } else {
            updateMarkerAnimation(marker, elapsed);
          }
        }
      }
      const overlayState = overlayStateRef.current;
      if (overlayState) {
        if (disableMapAnimations) {
          if (overlayState.sprite.currentFrame !== 0) {
            overlayState.sprite.gotoAndStop(0);
          }
        } else {
          const nextFrame = frameIndexForTime(
            elapsed,
            overlayState.resource.frameDurations,
            overlayState.resource.loopDuration,
          );
          if (overlayState.sprite.currentFrame !== nextFrame) {
            overlayState.sprite.gotoAndStop(nextFrame);
          }
        }
        for (const marker of overlayState.objectMarkers) {
          if (disableObjectAnimations) {
            applySpriteFrame(
              marker,
              marker.lastDirection ?? marker.frameSet?.defaultDirection ?? null,
              0,
            );
            marker.sprite.x = marker.basePosition.x + marker.spriteOffset.x;
            marker.sprite.y = marker.basePosition.y + marker.spriteOffset.y;
            marker.stepCount = null;
            marker.currentStepIndex = null;
            marker.stepProgress = 0;
          } else {
            updateMarkerAnimation(marker, elapsed);
          }
        }
      }
    };
    ticker.add(updateAnimations);
    return () => {
      try {
        ticker.remove(updateAnimations);
      } catch {
        /* ticker may already be torn down if app was destroyed earlier */
      }
    };
  }, [
    ready,
    clampWorldToBounds,
    schedulePersistViewState,
    disableMapAnimations,
    disableObjectAnimations,
  ]);

  useEffect(() => {
    if (!ready) {
      return;
    }
    applySpriteTransforms();
  }, [
    ready,
    applySpriteTransforms,
    baseOffsets,
    offsetOverrides,
    zOverrides,
    editing,
    selectedNeighborhoodId,
  ]);

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
    const blockPixelSize =
      atlas && Number.isFinite(atlas.blockPixelSize) && atlas.blockPixelSize !== 0
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
      const pointerId =
        typeof event.pointerId === "number" ? event.pointerId : (event.data?.pointerId ?? 0);
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
      const pointerId =
        typeof event.pointerId === "number" ? event.pointerId : (event.data?.pointerId ?? 0);
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
      const pointerId =
        typeof event.pointerId === "number" ? event.pointerId : (event.data?.pointerId ?? 0);
      if (pointerId !== state.pointerId) {
        return;
      }
      state.sprite.cursor = "grab";
      editDragStateRef.current = null;
      if (
        canvas &&
        typeof canvas.releasePointerCapture === "function" &&
        canvas.hasPointerCapture(pointerId)
      ) {
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
      if (sprite && typeof (sprite as any).off === "function") {
        try {
          sprite.off("pointerdown", handlePointerDown);
        } catch {
          /* ignore */
        }
      }
      if (!editingEnabled || !entry.neighborhoodId) {
        sprite.eventMode = "static";
        // Default to auto cursor on maps when not actively draggable
        sprite.cursor = "auto";
        continue;
      }
      sprite.eventMode = "static";
      sprite.cursor = "grab";
      sprite.on("pointerdown", handlePointerDown);
      detach.push(() => {
        sprite.off("pointerdown", handlePointerDown);
      });
    }

    const stage = app.stage as any;
    if (stage && typeof stage.off === "function") {
      try {
        stage.off("pointermove", handleStagePointerMove);
      } catch {
        /* ignore */
      }
      try {
        stage.off("pointerup", handleStagePointerUp);
      } catch {
        /* ignore */
      }
      try {
        stage.off("pointerupoutside", handleStagePointerUp);
      } catch {
        /* ignore */
      }
      try {
        stage.off("pointercancel", handleStagePointerUp);
      } catch {
        /* ignore */
      }
    }

    if (editingEnabled) {
      if (stage && typeof stage.on === "function") {
        try {
          stage.on("pointermove", handleStagePointerMove);
        } catch {
          /* ignore */
        }
        try {
          stage.on("pointerup", handleStagePointerUp);
        } catch {
          /* ignore */
        }
        try {
          stage.on("pointerupoutside", handleStagePointerUp);
        } catch {
          /* ignore */
        }
        try {
          stage.on("pointercancel", handleStagePointerUp);
        } catch {
          /* ignore */
        }
      }
      detach.push(() => {
        if (stage && typeof stage.off === "function") {
          try {
            stage.off("pointermove", handleStagePointerMove);
          } catch {
            /* ignore */
          }
          try {
            stage.off("pointerup", handleStagePointerUp);
          } catch {
            /* ignore */
          }
          try {
            stage.off("pointerupoutside", handleStagePointerUp);
          } catch {
            /* ignore */
          }
          try {
            stage.off("pointercancel", handleStagePointerUp);
          } catch {
            /* ignore */
          }
        }
      });
    }

    return () => {
      for (const entry of entries) {
        entry.sprite.cursor = "auto";
      }
      detach.forEach((fn) => fn());
      const state = editDragStateRef.current;
      if (state) {
        state.sprite.cursor = "auto";
        editDragStateRef.current = null;
        if (
          canvas &&
          typeof canvas.releasePointerCapture === "function" &&
          Number.isFinite(state.pointerId) &&
          canvas.hasPointerCapture(state.pointerId)
        ) {
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
      maybeRender();
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
      const minScale = state.minScale ?? Math.max(MIN_SCALE, (state.fitScale || 1) * 0.5);
      const maxScale = state.maxScale ?? MAX_SCALE;
      const clamped = Math.min(maxScale, Math.max(minScale, nextScale));
      const focusLocalX = focus ? focus.x - rect.left : rect.width / 2;
      const focusLocalY = focus ? focus.y - rect.top : rect.height / 2;
      const currentScale = overlaySprite.scale.x || 1;
      const spriteLocalX = (focusLocalX - overlaySprite.x) / currentScale;
      const spriteLocalY = (focusLocalY - overlaySprite.y) / currentScale;
      const baseWidth =
        state.baseWidth ||
        overlaySprite.texture.width ||
        (currentScale ? overlaySprite.width / currentScale : overlaySprite.width) ||
        1;
      const baseHeight =
        state.baseHeight ||
        overlaySprite.texture.height ||
        (currentScale ? overlaySprite.height / currentScale : overlaySprite.height) ||
        1;

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

      state.userPanned = true;
      maybeRender();
    };

    const clampOverlayPosition = (): void => {
      const state = overlayStateRef.current;
      const appInstance = appRef.current;
      if (!state || !appInstance) return;
      const overlaySprite = state.sprite;
      const { width: viewW, height: viewH } = getEffectiveViewSize(appInstance);
      const scale = overlaySprite.scale.x || 1;
      const baseWidth =
        state.baseWidth ||
        overlaySprite.texture.width ||
        (scale ? overlaySprite.width / scale : overlaySprite.width) ||
        1;
      const baseHeight =
        state.baseHeight ||
        overlaySprite.texture.height ||
        (scale ? overlaySprite.height / scale : overlaySprite.height) ||
        1;
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
      pinchStartDistance = Math.hypot(
        second.clientX - first.clientX,
        second.clientY - first.clientY,
      );
      pinchStartScale = scaleRef.current;
    };

    const handlePointerDown = (event: PointerEvent): void => {
      if (editing) return;
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
          overlayState.userPanned = true;
          clampOverlayPosition();
          maybeRender();
          return;
        }
        if (pointers.size >= 2 && pinchStartDistance && pinchStartDistance > 0) {
          const iterator = pointers.values();
          const first = iterator.next().value;
          const second = iterator.next().value;
          if (!first || !second) return;
          const distance = Math.hypot(
            second.clientX - first.clientX,
            second.clientY - first.clientY,
          );
          if (!distance) return;
          const center = {
            x: (first.clientX + second.clientX) / 2,
            y: (first.clientY + second.clientY) / 2,
          };
          // Apply sensitivity multiplier for overlay pinch-to-zoom
          const rawFactor = distance / pinchStartDistance;
          const scaleFactor = 1 + (rawFactor - 1) * 1.8;
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
        maybeRender();
        return;
      }
      if (pointers.size >= 2 && pinchStartDistance && pinchStartDistance > 0) {
        const iterator = pointers.values();
        const first = iterator.next().value;
        const second = iterator.next().value;
        if (!first || !second) return;
        const distance = Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY);
        if (!distance) return;
        const center = {
          x: (first.clientX + second.clientX) / 2,
          y: (first.clientY + second.clientY) / 2,
        };
        // Apply a sensitivity multiplier to make pinch-to-zoom faster
        const rawFactor = distance / pinchStartDistance;
        const scaleFactor = 1 + (rawFactor - 1) * 1.8;
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
      maybeRender();
    };

    const handleWheel = (event: WheelEvent): void => {
      const overlayState = overlayStateRef.current;
      if (overlayState) {
        event.preventDefault();
        const delta = event.deltaY;
        const currentScale =
          Number.isFinite(overlayState.scale) && overlayState.scale > 0
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
        const currentScale =
          Number.isFinite(overlayState.scale) && overlayState.scale > 0
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
      maybeRender();
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
  }, [
    ready,
    editing,
    clampWorldToBounds,
    positionOverlayContents,
    schedulePersistViewState,
    maybeRender,
  ]);

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
      window.removeEventListener("keydown", handleKeyDown, {
        capture: true,
      } as AddEventListenerOptions);
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
  // Keep per-map weather enabled state in sync with perf toggle and UI
  useEffect(() => {
    for (const entry of animationsRef.current) {
      if (entry.weather) {
        entry.weather.setEnabled(weatherEnabled && !disableMapAnimations);
      }
    }
  }, [weatherEnabled, disableMapAnimations]);

  // When enabling weather, attach to any eligible maps that don't have it yet
  useEffect(() => {
    if (!weatherEnabled) return;
    const app = appRef.current;
    if (!app) return;
    for (const entry of animationsRef.current) {
      if (entry.weather) continue;
      const type = computeMapWeather(entry.placement.label);
      if (type !== "none") {
        try {
          const ws = new WeatherSystem(app, entry.sprite);
          ws.setBounds(entry.placement.widthPx, entry.placement.heightPx);
          ws.setTimeOfDay(timeOfDay as any);
          ws.setEnabled(!disableMapAnimations);
          ws.setWeather(type as any);
          entry.weather = ws;
        } catch {
          /* ignore */
        }
      }
    }
  }, [weatherEnabled, computeMapWeather, disableMapAnimations, timeOfDay]);

  // Update weather palettes on time-of-day changes
  useEffect(() => {
    for (const entry of animationsRef.current) {
      if (entry.weather) {
        entry.weather.setTimeOfDay(timeOfDay as any);
      }
    }
  }, [timeOfDay]);

  // Propagate resize to weather system
  useEffect(() => {
    const app = appRef.current;
    if (!app) return;
    const recompute = (): void => {
      const ws = weatherSystemRef.current;
      if (!ws) return;
      const { width: w, height: h } = getEffectiveViewSize(app);
      ws.onResize(w, h);
    };
    const onResize = (): void => recompute();
    recompute();
    rendererOn(app, "resize", onResize);
    return () => {
      rendererOff(app, "resize", onResize);
    };
  }, [ready]);

  return (
    <div className="canvas-stage" ref={containerRef}>
      {loading && <div className="status-banner info">Loading atlas…</div>}
      {!loading && !atlas && <div className="status-banner warning">No map data available.</div>}
      {/* Sprite Limits Analysis Panel - only shown when enabled */}
      {spriteLimitEnabled && (
        <div
          style={{
            position: "absolute",
            right: 12,
            top: 12,
            padding: 8,
            background: "rgba(0,0,0,0.7)",
            color: "#fff",
            borderRadius: 6,
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap",
            maxWidth: "calc(100% - 24px)",
            overflow: "hidden",
            zIndex: 40,
            fontSize: 12,
          }}
        >
          {/* Severity filter */}
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={spriteOnlyErrors}
              onChange={(e: CheckboxChangeEvent) => setSpriteOnlyErrors(e.target.checked)}
            />
            <span>Errors only</span>
          </label>
          {/* Follower toggle */}
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={spriteIncludeFollower}
              onChange={(e: CheckboxChangeEvent) => setSpriteIncludeFollower(e.target.checked)}
            />
            <span>+Follower</span>
          </label>
          {/* Weather toggle (overworld only when applied in analysis) */}
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              type="checkbox"
              checked={spriteIncludeWeather}
              onChange={(e: CheckboxChangeEvent) => setSpriteIncludeWeather(e.target.checked)}
            />
            <span>+Weather</span>
          </label>
          {/* Scope selector */}
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span>Scope</span>
            <select
              value={spriteScope}
              onChange={(e: SelectChangeEvent) =>
                setSpriteScope((e.target.value as MapScope) ?? "all")
              }
              style={{ fontSize: 12, maxWidth: 100 }}
            >
              <option value="all">All</option>
              <option value="overworld">Overworld</option>
              <option value="indoor">Indoor</option>
            </select>
          </label>
          {/* Limits */}
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span>Line</span>
            <input
              type="number"
              value={spriteScanlineLimit}
              onChange={(e: InputNumberChangeEvent) =>
                setSpriteScanlineLimit(
                  Number.isFinite(parseInt(e.target.value)) ? parseInt(e.target.value) : 10,
                )
              }
              min={0}
              step={1}
              style={{ width: 48, fontSize: 12 }}
            />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <span>Total</span>
            <input
              type="number"
              value={spriteTotalLimit}
              onChange={(e: InputNumberChangeEvent) =>
                setSpriteTotalLimit(
                  Number.isFinite(parseInt(e.target.value)) ? parseInt(e.target.value) : 40,
                )
              }
              min={0}
              step={1}
              style={{ width: 48, fontSize: 12 }}
            />
          </label>
          <button
            type="button"
            onClick={() => runSpriteLimitAnalysis()}
            disabled={spriteAnalyzing}
            style={{ fontSize: 12, padding: "2px 8px" }}
          >
            {spriteAnalyzing ? "Analyzing…" : "Analyze"}
          </button>
        </div>
      )}
      {/* When no overlay is open, Analyze scans the entire overworld. */}
      {spriteLimitEnabled &&
        spriteIssues &&
        spriteIssues.length > 0 &&
        (resultsCollapsed ? (
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
              zIndex: 40,
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
              zIndex: 40,
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 8,
              }}
            >
              <strong>
                {spriteIssues.length} issue{spriteIssues.length === 1 ? "" : "s"}
              </strong>
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
                        const cy =
                          entry.sprite.y + issue.viewportPx.y + issue.viewportPx.height / 2;
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
                <span>
                  {spriteIssueIndex + 1}/{spriteIssues.length}
                </span>
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
                        const cy =
                          entry.sprite.y + issue.viewportPx.y + issue.viewportPx.height / 2;
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
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                margin: 0,
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}
            >
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
                          const cx =
                            entry.sprite.x + issue.viewportPx.x + issue.viewportPx.width / 2;
                          const cy =
                            entry.sprite.y + issue.viewportPx.y + issue.viewportPx.height / 2;
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
                      background:
                        idx === spriteIssueIndex
                          ? "rgba(241,196,15,0.3)"
                          : "rgba(255,255,255,0.08)",
                      color: "#fff",
                      border: "1px solid rgba(255,255,255,0.15)",
                      borderRadius: 4,
                      padding: "6px 8px",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      <span>
                        {issue.type === "scanline-limit" ? "Scanline" : "Total"}{" "}
                        {issue.severity === "exceeds" ? ">" : "="}
                        {issue.limit}
                      </span>
                      <span>count: {issue.count}</span>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.85 }}>
                      {issue.mapLabel ? `${issue.mapLabel} • ` : ""}Player @ ({issue.playerCell.x},
                      {issue.playerCell.y})
                      {issue.type === "scanline-limit" && typeof issue.scanlineY === "number"
                        ? ` • y=${issue.scanlineY}`
                        : ""}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {/* Contributors for the selected issue */}
            {spriteIssues[spriteIssueIndex] && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Contributors</div>
                <ul
                  style={{
                    listStyle: "none",
                    padding: 0,
                    margin: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {spriteIssues[spriteIssueIndex].contributors.slice(0, 20).map((ref, i) => (
                    <li
                      key={`${ref.kind}-${ref.index ?? -1}-${ref.cell.x}-${ref.cell.y}-${i}`}
                      style={{ fontSize: 12, opacity: 0.9 }}
                    >
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
        ))}
      {/* Canvas tooltip (React-rendered, styled like shadcn) */}
      {tooltipState.data && (
        <div
          role="tooltip"
          className={cn(
            "fixed z-[9999] pointer-events-none",
            "rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-neutral-50",
            "shadow-md animate-in fade-in-0 zoom-in-95"
          )}
          style={{ left: tooltipState.x, top: tooltipState.y }}
        >
          <span className="font-medium">{tooltipState.data.title}</span>
          {tooltipState.data.subtitle && (
            <div className="mt-1 text-[11px] opacity-70">{tooltipState.data.subtitle}</div>
          )}
        </div>
      )}
    </div>
  );
});

export default MapCanvas;
