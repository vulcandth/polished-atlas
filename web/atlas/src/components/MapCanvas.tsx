import { useEffect, useRef, useState } from "react";
import { Application, Container, type AnimatedSprite } from "pixi.js";
import { AnimatedGIF } from "@pixi/gif";
import { AtlasLayout, MapPlacement } from "@/types";
import { registerPixiExtensions } from "@/pixi/registerExtensions";

interface MapCanvasProps {
  atlas: AtlasLayout | null;
  loading: boolean;
}

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;

function clampScale(value: number): number {
  if (!Number.isFinite(value)) {
    return 1;
  }
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
}

registerPixiExtensions();

export default function MapCanvas({ atlas, loading }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const worldRef = useRef<Container | null>(null);
  const scaleRef = useRef(1);
  const boundsRef = useRef<{ width: number; height: number } | null>(null);
  const resetViewRef = useRef<() => void>(() => undefined);
  const [ready, setReady] = useState(false);

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

    const disposeChildren = (): void => {
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
    };

    resetViewRef.current = resetView;

    const tasks = atlas.placements.map(async (placement: MapPlacement): Promise<AnimatedSprite | null> => {
      try {
        if (!placement.asset) {
          return null;
        }
        const sprite = (await AnimatedGIF.from(placement.asset)) as AnimatedSprite;
        if (cancelled) {
          sprite.destroy();
          return null;
        }
        sprite.x = placement.x;
        sprite.y = placement.y;
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        if (typeof sprite.play === "function") {
          sprite.play();
        }
        world.addChild(sprite);
        return sprite;
      } catch (err) {
        console.error(`Failed to load GIF for ${placement.label}`, err);
        return null;
      }
    });

    Promise.all(tasks)
      .then((sprites: Array<AnimatedSprite | null>) => {
        if (cancelled) {
          sprites.forEach((sprite: AnimatedSprite | null) => sprite?.destroy());
          return;
        }
        resetView();
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
  }, [atlas, ready]);

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

    const clampPan = (): void => {
      const bounds = boundsRef.current;
      if (!bounds) {
        world.position.set(0, 0);
        return;
      }
      const viewWidth = app.renderer.width;
      const viewHeight = app.renderer.height;
      const scaledWidth = bounds.width * scaleRef.current;
      const scaledHeight = bounds.height * scaleRef.current;

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
    };

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

      clampPan();
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
        clampPan();
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
    };

    const handleWheel = (event: WheelEvent): void => {
      if (!boundsRef.current) {
        return;
      }
      event.preventDefault();
      const delta = event.deltaY;
      const factor = Math.exp(-delta / 500);
      applyScale(scaleRef.current * factor, { x: event.clientX, y: event.clientY });
    };

    const handleDoubleClick = (): void => {
      resetViewRef.current?.();
    };

    const handleRendererResize = (): void => {
      clampPan();
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
  }, [ready]);

  return (
    <div className="canvas-stage" ref={containerRef}>
      {loading && <div className="status-banner info">Loading atlas…</div>}
      {!loading && !atlas && <div className="status-banner warning">No map data available.</div>}
    </div>
  );
}
