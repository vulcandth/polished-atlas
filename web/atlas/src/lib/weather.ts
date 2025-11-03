import { Container, Graphics, Sprite, Texture, Application, BaseTexture, SCALE_MODES } from "pixi.js";
import { decodeBase64 } from "@/lib/base64";
import { joinBasePath, withBasePath, withVersion } from "@/lib/basePath";

export type WeatherType = "none" | "rain" | "thunderstorm" | "snow" | "sandstorm";

// Game Boy constants adapted to screen-space
const TILE_WIDTH = 8; // px
const OAM_COUNT = 40; // total sprite budget

// Particle kinds (match tile idea)
const RAINDROP = 1;
const RAINSPLASH = 2;
const SNOWFLAKE = 3;
const SAND = 4;

type Particle = {
  kind: typeof RAINDROP | typeof RAINSPLASH | typeof SNOWFLAKE | typeof SAND;
  sprite: Sprite;
  alive: boolean;
  // Screen-space integer positions
  x: number;
  y: number;
  // Used to emulate IsEvenSpriteIndex on GB (index / 4 parity); we approximate randomly
  evenBias: boolean;
  // For splash lifetime control
  ttlFrames: number;
};

// Utility to create small shared textures cheaply using the renderer
function makeRectTextureWithRenderer(app: Application, width: number, height: number, color = 0xffffff, alpha = 1): Texture {
  const g = new Graphics();
  g.beginFill(color, alpha);
  g.drawRect(0, 0, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  g.endFill();
  const tex = app.renderer.generateTexture(g);
  try { g.destroy(true); } catch { /* ignore */ }
  return tex;
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export class WeatherSystem {
  private app: Application;
  private layer: Container;
  private clip: Graphics;
  private enabled = true;
  private weather: WeatherType = "none";
  private timeOfDay: "day" | "morn" | "eve" | "nite" = "day";
  private width = 0;
  private height = 0;
  private frameCounter = 0; // Used to emulate 30 fps updates (odd frames)
  private particles: Particle[] = [];
  private pool: Particle[] = [];
  private rainTex: Texture | null = null;
  private splashTex: Texture | null = null;
  private snowTex: Texture | null = null;
  private sandTex: Texture | null = null;
  private ready = false;

  // --- Static asset cache ---
  private static _assetLoad?: Promise<void>;
  private static _weatherMeta: any = null;

  private static resolveWeatherMetadataUrl(): string {
    const override = typeof (import.meta as any).env?.VITE_WEATHER_METADATA_URL === "string"
      ? ((import.meta as any).env.VITE_WEATHER_METADATA_URL as string).trim()
      : "";
    if (override) {
      return withVersion(withBasePath(override));
    }
    if (import.meta && (import.meta as any).env?.DEV) {
      const repoRoot = typeof (globalThis as any).__REPO_ROOT__ === "string" ? (globalThis as any).__REPO_ROOT__ : (typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "");
      if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
        const raw = `${repoRoot}/maps/weather_metadata.json`.replace(/\\/g, "/");
        const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
        return withVersion(`${window.location.origin}/@fs${encodeURI(withSlash)}`);
      }
    }
    return withVersion(joinBasePath("maps", "weather_metadata.json"));
  }

  private static async ensureAssets(): Promise<void> {
    if (this._assetLoad) return this._assetLoad;
    this._assetLoad = (async () => {
      // Load generated weather metadata (tiles + palettes)
  const url = this.resolveWeatherMetadataUrl();
      const res = await fetch(url, { cache: "no-cache" });
      if (!res.ok) throw new Error(`Failed to load weather_metadata.json: ${res.status}`);
      const json = await res.json();
      this._weatherMeta = json || {};
    })();
    return this._assetLoad;
  }

  // --- Palettes ---
  // Four colors, ordered light -> dark. Values from maps/object_metadata.json.
  // Palettes now come from generated metadata; keep local fallback just in case (not expected to use)
  private static SNOW_WHITE: [number, number, number][]= [ [255,255,255], [255,255,255], [255,255,255], [0,0,0] ];

  // Palettize a frame of a source texture using a 4-color palette (light->dark)
  // Decode 2bpp tiles from base64, build a Pixi Texture with palette mapping.
  private static buildTextureFrom2bpp(base64: string, width = 8, height = 8, palette: [number,number,number][]): Texture | null {
    if (!base64) return null;
    const bytes = decodeBase64(base64);
    if (!bytes || bytes.length % 16 !== 0) return null;
    const tileCount = bytes.length / 16;
    const tiles: Uint8Array[] = [];
    for (let t = 0; t < tileCount; t++) {
      const pixels = new Uint8Array(64);
      const base = t * 16;
      for (let row = 0; row < 8; row++) {
        const low = bytes[base + row * 2];
        const high = bytes[base + row * 2 + 1];
        for (let col = 0; col < 8; col++) {
          const shift = 7 - col;
          const lo = (low >> shift) & 1;
          const hi = (high >> shift) & 1;
          pixels[row * 8 + col] = lo | (hi << 1);
        }
      }
      tiles.push(pixels);
    }
    // Compose tiles in a simple grid: width x height determine output; if multiple tiles, lay left-to-right, top-to-bottom.
    const tilesPerRow = Math.max(1, Math.ceil(width / 8));
    const tilesPerCol = Math.max(1, Math.ceil(height / 8));
    const stride = tilesPerRow * tilesPerCol;
    const used = Math.min(tileCount, stride);
    const buffer = new Uint8Array(width * height * 4);
    const colors = palette.slice(0, 4) as [number,number,number][];
    for (let idx = 0; idx < used; idx++) {
      const tile = tiles[idx];
      const tileRow = Math.floor(idx / tilesPerRow);
      const tileCol = idx % tilesPerRow;
      for (let r = 0; r < 8; r++) {
        const destY = tileRow * 8 + r; if (destY >= height) continue;
        for (let c = 0; c < 8; c++) {
          const destX = tileCol * 8 + c; if (destX >= width) continue;
          const v = tile[r * 8 + c];
          if (v === 0) continue; // transparent
          const color = colors[v] ?? colors[Math.min(v, colors.length - 1)] ?? [0,0,0];
          const off = (destY * width + destX) * 4;
          buffer[off] = color[0];
          buffer[off+1] = color[1];
          buffer[off+2] = color[2];
          buffer[off+3] = 255;
        }
      }
    }
    const bt = BaseTexture.fromBuffer(buffer, width, height);
    bt.scaleMode = SCALE_MODES.NEAREST;
    return new Texture(bt);
  }

  constructor(app: Application, parent: Container) {
    this.app = app;
    this.layer = new Container();
    this.layer.sortableChildren = false;
    // Local coordinate system: attach as child of parent (e.g., map sprite)
    // so scaling/zoom applies automatically.
    parent.addChild(this.layer);
    // Clip to the map rectangle so particles don't spill into the void
    this.clip = new Graphics();
    this.clip.eventMode = "none";
    this.clip.alpha = 0; // invisible mask
    this.layer.addChild(this.clip);
    this.layer.mask = this.clip;
    // Begin async asset prepare (lazy); update() will no-op until ready
    void this.prepareTextures();
  }

  public get container(): Container { return this.layer; }

  public setEnabled(next: boolean): void {
    this.enabled = !!next;
    this.layer.visible = this.enabled && this.weather !== "none";
  }

  public setWeather(next: WeatherType): void {
    if (this.weather === next) return;
    // Keep old particles; they'll exit screen naturally to approximate cooldown behavior
    this.weather = next;
    this.layer.visible = this.enabled && this.weather !== "none";
    // Rebuild textures if assets are ready
    void this.prepareTextures();
  }

  public setTimeOfDay(tod: "day"|"morn"|"eve"|"nite"): void {
    if (this.timeOfDay === tod) return;
    this.timeOfDay = tod;
    void this.prepareTextures();
  }

  public setBounds(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    // Update clipping mask
    this.clip.clear();
    this.clip.beginFill(0x000000, 1);
    this.clip.drawRect(0, 0, this.width, this.height);
    this.clip.endFill();
  }

  public clear(): void {
    for (const p of this.particles) {
      try { p.sprite.destroy(); } catch { /* noop */ }
    }
    this.particles = [];
    for (const p of this.pool) {
      try { p.sprite.destroy(); } catch { /* noop */ }
    }
    this.pool = [];
  }

  public destroy(): void {
    this.clear();
    try {
      if (this.layer.mask === this.clip) {
        this.layer.mask = null as any;
      }
    } catch { /* ignore */ }
    try { this.clip.destroy(true); } catch { /* ignore */ }
    try { this.layer.destroy({ children: true }); } catch { /* ignore */ }
  }

  // Optional resize hook for host; current implementation doesn't need viewport size,
  // but keep the method so callers can safely notify.
  public onResize(_width: number, _height: number): void {
    // no-op; bounds are per-map and set via setBounds
  }

  private async prepareTextures(): Promise<void> {
    // Ensure sources are available
    await WeatherSystem.ensureAssets();
    const meta = WeatherSystem._weatherMeta || {};
    const gfx = meta.graphics || {};
    const pals = meta.palettes || {};
    const tod = this.timeOfDay;
    const rainOvercast = (pals["PAL_OW_RAIN"]?.overcast?.[tod]) || WeatherSystem.SNOW_WHITE;
    const sandTod = (pals["PAL_OW_SAND"]?.time_variants?.[tod]) || WeatherSystem.SNOW_WHITE;
    const snowPal = (pals["PAL_OW_SNOW"]?.static) || WeatherSystem.SNOW_WHITE;

    this.rainTex = WeatherSystem.buildTextureFrom2bpp(gfx.rain?.tiles_2bpp_base64 || "", gfx.rain?.width || 8, gfx.rain?.height || 8, rainOvercast) as Texture;
    this.splashTex = WeatherSystem.buildTextureFrom2bpp(gfx.splash?.tiles_2bpp_base64 || "", gfx.splash?.width || 8, gfx.splash?.height || 8, rainOvercast) as Texture;
    this.snowTex = WeatherSystem.buildTextureFrom2bpp(gfx.snow?.tiles_2bpp_base64 || "", gfx.snow?.width || 8, gfx.snow?.height || 8, snowPal) as Texture;
    this.sandTex = WeatherSystem.buildTextureFrom2bpp(gfx.sand?.tiles_2bpp_base64 || "", gfx.sand?.width || 8, gfx.sand?.height || 8, sandTod) as Texture;
    this.ready = true;
  }

  private alloc(kind: Particle["kind"]): Particle {
  const tex = (kind === RAINDROP ? this.rainTex : kind === RAINSPLASH ? this.splashTex : kind === SNOWFLAKE ? this.snowTex : this.sandTex) as Texture;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    sprite.alpha = 1;
    const p: Particle = { kind, sprite, alive: true, x: 0, y: 0, evenBias: Math.random() < 0.5, ttlFrames: 0 };
    this.layer.addChild(sprite);
    return p;
  }

  private spawn(kind: Particle["kind"], x: number, y: number): void {
    if (this.particles.length >= OAM_COUNT) return;
    const p = this.pool.pop() ?? this.alloc(kind);
    p.kind = kind;
    p.alive = true;
    p.evenBias = Math.random() < 0.5;
    p.ttlFrames = kind === RAINSPLASH ? 4 : 0; // ~3.75 frames in GB; 4 is fine
    p.x = x;
    p.y = y;
  p.sprite.texture = (kind === RAINDROP ? this.rainTex : kind === RAINSPLASH ? this.splashTex : kind === SNOWFLAKE ? this.snowTex : this.sandTex) as Texture;
    p.sprite.visible = true;
    p.sprite.x = x;
    p.sprite.y = y;
    // Slight rotation for raindrops to hint diagonal motion
    // No artificial rotation; match game behavior
    p.sprite.rotation = 0;
    this.particles.push(p);
  }

  private despawn(index: number): void {
    const p = this.particles[index];
    if (!p) return;
    p.alive = false;
    p.sprite.visible = false;
    p.sprite.x = -9999;
    p.sprite.y = -9999;
    this.pool.push(p);
    const last = this.particles.pop();
    if (index < this.particles.length && last && last !== p) {
      this.particles[index] = last;
    }
  }

  // cameraStep is the delta (in px) of the world relative to screen this tick
  public update(cameraStepX: number, cameraStepY: number): void {
    if (!this.ready) return;
    // Only update on odd frames to emulate GB 30fps weather cadence
    this.frameCounter = (this.frameCounter + 1) & 0xff;
    const runThisFrame = (this.frameCounter & 1) === 1;
    if (!runThisFrame) return;
    if (!this.enabled || this.weather === "none") return;

    // Spawning based on weather kind
  if (this.weather === "rain" || this.weather === "thunderstorm") {
      // 3 spawn attempts per weather frame
      for (let i = 0; i < 3; i++) this.trySpawnRain();
      // Occasional lightning flash for thunderstorms
      if (this.weather === "thunderstorm") {
        if (Math.random() < 0.005 && Math.random() < 0.5) {
          this.flash();
        }
      }
    } else if (this.weather === "snow") {
      // 2 attempts at 40% each
      for (let i = 0; i < 2; i++) if (Math.random() < 0.4) this.trySpawnSnow();
    } else if (this.weather === "sandstorm") {
      for (let i = 0; i < 3; i++) this.trySpawnSand();
    }

    // Update particles
  const stepX4 = cameraStepX * 4;
  const stepY4 = cameraStepY * 4;
  const stepX2 = cameraStepX * 2;
  const stepY2 = cameraStepY * 2;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p || !p.alive) continue;

      if (p.kind === RAINDROP) {
        // 5% chance of splashing
        if (Math.random() < 0.05) {
          // convert to splash in-place
          p.kind = RAINSPLASH;
          p.ttlFrames = 4;
          p.sprite.texture = (this.splashTex as Texture);
          p.sprite.rotation = 0;
        } else {
          // y: min 8 + (even?2:0) - 4*stepY
          let y = p.y - stepY4 + (p.evenBias ? 2 : 0) + 8;
          // x: base -4 - 4*stepX - (even?2:0)
          let x = p.x - stepX4 - 4 - (p.evenBias ? 2 : 0);
          p.x = x;
          p.y = y;
          p.sprite.x = x;
          p.sprite.y = y;
          if (y >= this.height + TILE_WIDTH || x < -TILE_WIDTH) {
            this.despawn(i--);
          }
          continue;
        }
      }

      if (p.kind === RAINSPLASH) {
        // Splash follows doubled camera step and decays quickly
        p.ttlFrames -= 1;
        const y = p.y - stepY2;
        const x = p.x - stepX2;
        p.x = x;
        p.y = y;
        p.sprite.x = x;
        p.sprite.y = y;
        if (p.ttlFrames <= 0 || y >= this.height + TILE_WIDTH || y < -TILE_WIDTH || x < -TILE_WIDTH || x > this.width + TILE_WIDTH) {
          this.despawn(i--);
        }
        continue;
      }

      if (p.kind === SNOWFLAKE) {
        // y: min 2 + (even?1:0) - 2*stepY
        let y = p.y - stepY2 + (p.evenBias ? 1 : 0) + 2;
        // x wiggle: 50% chance to add 1 to the step; x -= (2*stepX + wiggle)
        const wiggle = Math.random() < 0.5 ? 1 : 0;
        let x = p.x - (stepX2 + wiggle);
        p.x = x;
        p.y = y;
        p.sprite.x = x;
        p.sprite.y = y;
        if (y >= this.height + TILE_WIDTH || x < -TILE_WIDTH || x > this.width + TILE_WIDTH) {
          this.despawn(i--);
        }
        continue;
      }

      if (p.kind === SAND) {
        // y rises: -4 + (even?2:0) - 4*stepY
        let y = p.y - stepY4 - 4 + (p.evenBias ? 2 : 0);
        // x drifts left strongly: -12 - 4*stepX - (even?2:0)
        let x = p.x - stepX4 - 12 - (p.evenBias ? 2 : 0);
        p.x = x;
        p.y = y;
        p.sprite.x = x;
        p.sprite.y = y;
        if (y < -TILE_WIDTH || x < -TILE_WIDTH) {
          this.despawn(i--);
        }
        continue;
      }
    }
  }

  private trySpawnRain(): void {
    // 50%: spawn on right edge; else top
    if (Math.random() < 0.5) {
      const y = Math.floor(Math.random() * (this.height + TILE_WIDTH));
      const x = this.width + TILE_WIDTH;
      this.spawn(RAINDROP, x, y);
    } else {
      const y = 0;
      const x = Math.floor(Math.random() * (this.width + 7)) + TILE_WIDTH;
      this.spawn(RAINDROP, x, y);
    }
  }

  private trySpawnSnow(): void {
    // 25% chance to spawn on right; else top
    if ((Math.random() * 4) < 1) {
      const y = Math.floor(Math.random() * (this.height + TILE_WIDTH));
      const x = this.width + TILE_WIDTH;
      this.spawn(SNOWFLAKE, x, y);
    } else {
      const y = 0;
      const x = Math.floor(Math.random() * (this.width + 7)) + TILE_WIDTH;
      this.spawn(SNOWFLAKE, x, y);
    }
  }

  private trySpawnSand(): void {
    // 50% right; else bottom
    if (Math.random() < 0.5) {
      const y = Math.floor(Math.random() * (this.height + TILE_WIDTH));
      const x = this.width + TILE_WIDTH;
      this.spawn(SAND, x, y);
    } else {
      const y = this.height + TILE_WIDTH;
      const x = Math.floor(Math.random() * (this.width + 7)) + TILE_WIDTH;
      this.spawn(SAND, x, y);
    }
  }

  private flash(): void {
    // Simple white flash overlay that decays quickly
    const g = new Graphics();
    g.beginFill(0xffffff, 0.85);
  g.drawRect(0, 0, this.width, this.height);
    g.endFill();
    g.zIndex = 100000;
    this.layer.addChild(g);
    let ttl = 2; // a couple of weather frames
    const tick = (): void => {
      ttl -= 1;
      g.alpha *= 0.25;
      if (ttl <= 0) {
        try { g.destroy(true); } catch { /* noop */ }
      } else {
        // schedule next after a short delay (next RAF)
        if (typeof window !== "undefined") {
          window.requestAnimationFrame(() => tick());
        }
      }
    };
    if (typeof window !== "undefined") {
      window.requestAnimationFrame(() => tick());
    }
  }
}
