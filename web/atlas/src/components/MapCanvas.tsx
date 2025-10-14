import { useEffect, useRef, useState } from "react";
import { Application, Container } from "pixi.js";
import { AnimatedGIF } from "@pixi/gif";
import { Viewport } from "pixi-viewport";
import { AtlasLayout, MapPlacement } from "@/types";
import { registerPixiExtensions } from "@/pixi/registerExtensions";

interface MapCanvasProps {
  atlas: AtlasLayout | null;
  loading: boolean;
}

registerPixiExtensions();

export default function MapCanvas({ atlas, loading }: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const appRef = useRef<Application | null>(null);
  const viewportRef = useRef<Viewport | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    let destroyed = false;

    const boot = async (): Promise<void> => {
      const app = await Application.init({
        backgroundAlpha: 0,
        resizeTo: container,
        antialias: true,
        hello: false,
      });
      if (destroyed) {
        app.destroy(true, { children: true });
        return;
      }
      container.appendChild(app.canvas);
      appRef.current = app;
      const viewport = new Viewport({
        events: app.renderer.events,
        ticker: app.ticker,
        screenWidth: container.clientWidth,
        screenHeight: container.clientHeight,
        worldWidth: container.clientWidth,
        worldHeight: container.clientHeight,
      });
      viewport.drag().pinch().wheel().decelerate();
      app.stage.addChild(viewport);
      viewportRef.current = viewport;
      setReady(true);
    };

    boot().catch((err) => {
      console.error("Failed to initialise Pixi application", err);
    });

    return () => {
      destroyed = true;
      setReady(false);
      const viewport = viewportRef.current;
      if (viewport) {
        viewport.destroy();
        viewportRef.current = null;
      }
      const app = appRef.current;
      if (app) {
        app.destroy(true, { children: true });
        appRef.current = null;
      }
      if (container.firstChild instanceof HTMLCanvasElement) {
        container.removeChild(container.firstChild);
      }
    };
  }, []);

  useEffect(() => {
    if (!ready) {
      return;
    }
    const viewport = viewportRef.current;
    const app = appRef.current;
    if (!viewport || !app) {
      return;
    }

    const disposeChildren = (): void => {
      const removed = viewport.removeChildren();
      for (const child of removed) {
        if (typeof (child as { destroy?: () => void }).destroy === "function") {
          child.destroy();
        }
      }
    };

    let cancelled = false;
    disposeChildren();

    if (!atlas) {
      return;
    }

    viewport.resize(
      viewport.screenWidth,
      viewport.screenHeight,
      Math.max(atlas.bounds.width, viewport.screenWidth),
      Math.max(atlas.bounds.height, viewport.screenHeight)
    );

    const tasks = atlas.placements.map(async (placement: MapPlacement): Promise<AnimatedGIF | null> => {
      try {
        const sprite = await AnimatedGIF.from(placement.asset);
        if (cancelled) {
          sprite.destroy();
          return null;
        }
        sprite.x = placement.x;
        sprite.y = placement.y;
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        sprite.play();
        viewport.addChild(sprite);
        return sprite;
      } catch (err) {
        console.error(`Failed to load GIF for ${placement.label}`, err);
        return null;
      }
    });

    Promise.all(tasks)
      .then((sprites: Array<AnimatedGIF | null>) => {
        if (cancelled) {
          sprites.forEach((sprite: AnimatedGIF | null) => sprite?.destroy());
          return;
        }
        viewport.fit();
        viewport.moveCenter(atlas.bounds.width / 2, atlas.bounds.height / 2);
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

  return (
    <div className="canvas-stage" ref={containerRef}>
      {loading && <div className="status-banner info">Loading atlas…</div>}
      {!loading && !atlas && <div className="status-banner warning">No map data available.</div>}
    </div>
  );
}
