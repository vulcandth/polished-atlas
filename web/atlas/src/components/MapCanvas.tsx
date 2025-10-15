import { useCallback, useEffect, useRef, useState } from "react";
import { Application, Container, AnimatedSprite, FederatedPointerEvent, Assets } from "pixi.js";
import { AtlasLayout, MapPlacement } from "@/types";
import { registerPixiExtensions } from "@/pixi/registerExtensions";
import { loadMapAnimation, type MapAnimationResource } from "@/lib/loadMapAnimation";

type OffsetTuple = [number, number];

interface MapCanvasProps {
  atlas: AtlasLayout | null;
  loading: boolean;
  editing?: boolean;
  baseOffsets?: Record<string, OffsetTuple> | null;
  offsetOverrides?: Record<string, OffsetTuple> | null;
  zOverrides?: Record<string, number> | null;
  selectedNeighborhoodId?: string | null;
  onSelectNeighborhood?: (id: string) => void;
  onOffsetChange?: (id: string, next: OffsetTuple) => void;
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

type SyncedAnimation = {
  sprite: AnimatedSprite;
  resource: MapAnimationResource;
  placement: MapPlacement;
  order: number;
  neighborhoodId: string | null;
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
  baseOffsets = null,
  offsetOverrides = null,
  zOverrides = null,
  selectedNeighborhoodId = null,
  onSelectNeighborhood,
  onOffsetChange,
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

  useEffect(() => {
    return () => {
      if (typeof window !== "undefined" && persistTimerRef.current !== null) {
        window.clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, []);

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
      setReady(true);
    };

    boot().catch((err) => {
      console.error("Failed to initialise Pixi application", err);
    });

    return () => {
      destroyed = true;
      setReady(false);
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

    const disposeResource = (resource: MapAnimationResource): void => {
      for (const texture of resource.textures) {
        if (texture && !texture.destroyed) {
          texture.destroy();
        }
      }
      void Assets.unload(resource.imageUrl);
    };

    const disposeAnimations = (): void => {
      const entries = animationsRef.current.splice(0, animationsRef.current.length);
      for (const entry of entries) {
        spriteEntryMapRef.current.delete(entry.sprite);
        entry.sprite.destroy();
        disposeResource(entry.resource);
      }
    };

    const disposeChildren = (): void => {
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
          disposeResource(resource);
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
  }, [atlas, ready, clampWorldToBounds, persistViewState, restoreViewState, applySpriteTransforms]);

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
      event.preventDefault();
      const delta = event.deltaY;
      const factor = Math.exp(-delta / 500);
      applyScale(scaleRef.current * factor, { x: event.clientX, y: event.clientY });
    };

    const handleDoubleClick = (): void => {
      resetViewRef.current?.();
    };

    const handleRendererResize = (): void => {
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
  }, [ready, editing]);

  return (
    <div className="canvas-stage" ref={containerRef}>
      {loading && <div className="status-banner info">Loading atlas…</div>}
      {!loading && !atlas && <div className="status-banner warning">No map data available.</div>}
    </div>
  );
}
