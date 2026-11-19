import {
  Container,
  Graphics,
  Sprite,
  Texture,
  Filter,
  BaseTexture,
  SCALE_MODES,
} from "pixi.js";
import { decodeBase64 } from "@/lib/base64";
import { joinBasePath, withBasePath, withVersion } from "@/lib/basePath";
import { cherrySpawnPoint, type WeatherPoint, type WeatherType } from "@/lib/weatherState";
import { fadeColorStep, GAME_FRAME_MS } from "@/lib/objectGlow";
import { weatherOamClips, type OamPoint } from "@/lib/weatherOam";

export type WeatherActor = { sprite: Sprite; tiles: OamPoint[] };

export type { WeatherType } from "@/lib/weatherState";

// Game Boy constants adapted to screen-space
const TILE_WIDTH = 8; // px
const OAM_COUNT = 40; // total sprite budget

// Particle kinds (match tile idea)
const RAINDROP = 1;
const RAINSPLASH = 2;
const SNOWFLAKE = 3;
const SAND = 4;
const CHERRY = 5;

const LIGHTNING_STEPS = 15;
const LIGHTNING_STEP_MS = 2 * GAME_FRAME_MS;

// During lightning the ROM fades all BG and object palettes back from white.
// Look up each 5-bit channel after the current step, including on animated tiles.
const lightningFragment = `
  varying vec2 vTextureCoord;
  uniform sampler2D uSampler;
  uniform sampler2D uFadeTable;
  uniform float uRow;
  void main() {
    vec4 color = texture2D(uSampler, vTextureCoord);
    vec3 target = floor(clamp(color.rgb / max(color.a, 0.0001), 0.0, 1.0) * 31.875);
    vec3 x = (target + 0.5) / 32.0;
    vec3 faded = vec3(texture2D(uFadeTable, vec2(x.r, uRow)).r,
                      texture2D(uFadeTable, vec2(x.g, uRow)).r,
                      texture2D(uFadeTable, vec2(x.b, uRow)).r);
    gl_FragColor = vec4(faded * color.a, color.a);
  }
`;

let lightningTable: Texture | undefined;
function whiteFadeTable(): Texture {
  if (lightningTable) return lightningTable;
  const height = LIGHTNING_STEPS + 1;
  const pixels = new Uint8Array(32 * height * 4);
  for (let target = 0; target < 32; target++) {
    let channel = 31;
    for (let step = 0; step < height; step++) {
      const index = 4 * (step * 32 + target);
      pixels.fill(Math.round(255 * channel / 31), index, index + 3);
      pixels[index + 3] = 255;
      channel = fadeColorStep(channel, target, LIGHTNING_STEPS - step);
    }
  }
  lightningTable = Texture.fromBuffer(pixels, 32, height, { scaleMode: SCALE_MODES.NEAREST });
  return lightningTable;
}

type Particle = {
  slot: number;
  kind: typeof RAINDROP | typeof RAINSPLASH | typeof SNOWFLAKE | typeof SAND | typeof CHERRY;
  sprite: Sprite;
  alive: boolean;
  // Screen-space integer positions
  x: number;
  y: number;
  // For splash lifetime control
  ttlFrames: number;
};

// removed unused helpers makeRectTextureWithRenderer and clamp

export class WeatherSystem {
  private oamMasks = new Map<Sprite, Graphics>();
  private lightningFilter: Filter | null = null;
  private lightningStart = 0;
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
  private cherryTex: Texture | null = null;
  private cherryLeaves: WeatherPoint[] = [];
  private destroyed = false;
  private textureTime: string | null = null;
  private ready = false;

  // --- Static asset cache ---
  private static _assetLoad?: Promise<void>;
  private static _weatherMeta: any = null;

  private static resolveWeatherMetadataUrl(): string {
    const override =
      typeof (import.meta as any).env?.VITE_WEATHER_METADATA_URL === "string"
        ? ((import.meta as any).env.VITE_WEATHER_METADATA_URL as string).trim()
        : "";
    if (override) {
      return withVersion(withBasePath(override));
    }
    if (import.meta && (import.meta as any).env?.DEV) {
      const repoRoot =
        typeof (globalThis as any).__REPO_ROOT__ === "string"
          ? (globalThis as any).__REPO_ROOT__
          : typeof __REPO_ROOT__ === "string"
            ? __REPO_ROOT__
            : "";
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
  private static SNOW_WHITE: [number, number, number][] = [
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
    [255, 255, 255],
  ];

  // Palettize a frame of a source texture using a 4-color palette (light->dark)
  // Decode 2bpp tiles from base64, build a Pixi Texture with palette mapping.
  private static buildTextureFrom2bpp(
    base64: string,
    width = 8,
    height = 8,
    palette: [number, number, number][],
  ): Texture | null {
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
    const colors = palette.slice(0, 4) as [number, number, number][];
    for (let idx = 0; idx < used; idx++) {
      const tile = tiles[idx];
      const tileRow = Math.floor(idx / tilesPerRow);
      const tileCol = idx % tilesPerRow;
      for (let r = 0; r < 8; r++) {
        const destY = tileRow * 8 + r;
        if (destY >= height) continue;
        for (let c = 0; c < 8; c++) {
          const destX = tileCol * 8 + c;
          if (destX >= width) continue;
          const v = tile[r * 8 + c];
          if (v === 0) continue; // transparent
          const color = colors[v] ?? colors[Math.min(v, colors.length - 1)] ?? [0, 0, 0];
          const off = (destY * width + destX) * 4;
          buffer[off] = color[0];
          buffer[off + 1] = color[1];
          buffer[off + 2] = color[2];
          buffer[off + 3] = 255;
        }
      }
    }
    const bt = BaseTexture.fromBuffer(buffer, width, height);
    bt.scaleMode = SCALE_MODES.NEAREST;
    return new Texture(bt);
  }

  constructor(private readonly parent: Container) {
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

  public get container(): Container {
    return this.layer;
  }

  public setEnabled(next: boolean): void {
    this.enabled = !!next;
    if (!this.enabled) {
      this.endLightning();
      this.clearOamMasks();
    }
    this.layer.visible = this.enabled && this.weather !== "none";
  }

  public setWeather(next: WeatherType): void {
    if (this.weather === next) return;
    this.endLightning();
    // Map snapshots have no gameplay transition state. Clear previous particles
    // immediately so a disabled/replaced layer cannot leave stale effects.
    this.clear();
    this.weather = next;
    this.layer.visible = this.enabled && this.weather !== "none";
    // Rebuild textures if assets are ready
    void this.prepareTextures();
  }

  public setTimeOfDay(tod: "day" | "morn" | "eve" | "nite"): void {
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

  public setCherryLeaves(points: WeatherPoint[]): void {
    this.cherryLeaves = points;
  }

  public clear(): void {
    this.clearOamMasks();
    for (const p of this.particles) {
      try {
        p.sprite.destroy();
      } catch {
        /* noop */
      }
    }
    this.particles = [];
    for (const p of this.pool) {
      try {
        p.sprite.destroy();
      } catch {
        /* noop */
      }
    }
    this.pool = [];
  }

  public destroy(): void {
    this.destroyed = true;
    this.endLightning();
    this.clear();
    this.disposeTextures();
    try {
      if (this.layer.mask === this.clip) {
        this.layer.mask = null as any;
      }
    } catch {
      /* ignore */
    }
    try {
      this.clip.destroy(true);
    } catch {
      /* ignore */
    }
    try {
      this.layer.destroy({ children: true });
    } catch {
      /* ignore */
    }
  }

  // Optional resize hook for host; current implementation doesn't need viewport size,
  // but keep the method so callers can safely notify.
  public onResize(_width: number, _height: number): void {
    // no-op; bounds are per-map and set via setBounds
  }

  private async prepareTextures(): Promise<void> {
    // Ensure sources are available
    try {
      await WeatherSystem.ensureAssets();
    } catch (error) {
      if (!this.destroyed) console.error("Weather assets could not be loaded", error);
      return;
    }
    if (this.destroyed || this.textureTime === this.timeOfDay) return;
    this.clear();
    this.disposeTextures();
    const meta = WeatherSystem._weatherMeta || {};
    const gfx = meta.graphics || {};
    const pals = meta.palettes || {};
    const tod = this.timeOfDay;
    const rainOvercast = pals["PAL_OW_RAIN"]?.overcast?.[tod] || WeatherSystem.SNOW_WHITE;
    const sandTod = pals["PAL_OW_SAND"]?.time_variants?.[tod] || WeatherSystem.SNOW_WHITE;
    const snowPal = pals["PAL_OW_SNOW"]?.static || WeatherSystem.SNOW_WHITE;
    const cherryPal = pals["PAL_OW_PINK"]?.time_variants?.[tod] || pals["PAL_OW_PINK"]?.static;

    this.rainTex = WeatherSystem.buildTextureFrom2bpp(
      gfx.rain?.tiles_2bpp_base64 || "",
      gfx.rain?.width || 8,
      gfx.rain?.height || 8,
      rainOvercast,
    ) as Texture;
    this.splashTex = WeatherSystem.buildTextureFrom2bpp(
      gfx.splash?.tiles_2bpp_base64 || "",
      gfx.splash?.width || 8,
      gfx.splash?.height || 8,
      rainOvercast,
    ) as Texture;
    this.snowTex = WeatherSystem.buildTextureFrom2bpp(
      gfx.snow?.tiles_2bpp_base64 || "",
      gfx.snow?.width || 8,
      gfx.snow?.height || 8,
      snowPal,
    ) as Texture;
    this.sandTex = WeatherSystem.buildTextureFrom2bpp(
      gfx.sand?.tiles_2bpp_base64 || "",
      gfx.sand?.width || 8,
      gfx.sand?.height || 8,
      sandTod,
    ) as Texture;
    this.cherryTex = cherryPal ? WeatherSystem.buildTextureFrom2bpp(
      gfx.cherry?.tiles_2bpp_base64 || "", 8, 8, cherryPal,
    ) : null;
    this.textureTime = tod;
    this.ready = true;
  }

  private disposeTextures(): void {
    for (const texture of [this.rainTex, this.splashTex, this.snowTex, this.sandTex, this.cherryTex]) {
      texture?.destroy(true);
    }
    this.rainTex = this.splashTex = this.snowTex = this.sandTex = this.cherryTex = null;
    this.ready = false;
  }

  private textureFor(kind: Particle["kind"]): Texture | null {
    return kind === RAINDROP ? this.rainTex : kind === RAINSPLASH ? this.splashTex :
      kind === SNOWFLAKE ? this.snowTex : kind === CHERRY ? this.cherryTex : this.sandTex;
  }

  private alloc(kind: Particle["kind"]): Particle {
    const tex = this.textureFor(kind) as Texture;
    const sprite = new Sprite(tex);
    sprite.anchor.set(0.5, 0.5);
    sprite.alpha = 1;
    const p: Particle = {
      slot: 0,
      kind,
      sprite,
      alive: true,
      x: 0,
      y: 0,
      ttlFrames: 0,
    };
    this.layer.addChild(sprite);
    return p;
  }

  private spawn(kind: Particle["kind"], x: number, y: number): void {
    if (this.particles.length >= OAM_COUNT) return;
    const texture = this.textureFor(kind);
    if (!texture) return;
    const p = this.pool.pop() ?? this.alloc(kind);
    const used = new Set(this.particles.map(particle => particle.slot));
    p.slot = 0;
    while (used.has(p.slot)) p.slot++;
    p.kind = kind;
    p.alive = true;
    p.ttlFrames = kind === RAINSPLASH ? 4 : 0; // ~3.75 frames in GB; 4 is fine
    p.x = x;
    p.y = y;
    p.sprite.texture = texture;
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
  public update(cameraStepX: number, cameraStepY: number, actors: WeatherActor[] = []): void {
    if (!this.ready) return;
    if (this.lightningFilter) {
      const step = Math.floor((performance.now() - this.lightningStart) / LIGHTNING_STEP_MS);
      if (step >= LIGHTNING_STEPS) this.endLightning();
      else this.lightningFilter.uniforms.uRow = (step + 0.5) / (LIGHTNING_STEPS + 1);
    }
    // Only update on odd frames to emulate GB 30fps weather cadence
    this.frameCounter = (this.frameCounter + 1) & 0xff;
    const runThisFrame = (this.frameCounter & 1) === 1;
    if (!this.enabled || this.weather === "none") return;
    if (!runThisFrame) {
      this.limitSprites(actors);
      return;
    }

    // Spawning based on weather kind
    if (this.weather === "rain" || this.weather === "thunderstorm") {
      // 3 spawn attempts per weather frame
      for (let i = 0; i < 3; i++) this.trySpawnRain();
      // Occasional lightning flash for thunderstorms
      if (this.weather === "thunderstorm") {
        if (Math.random() < 2 / 256 && Math.random() < 127 / 256) {
          this.flash();
        }
      }
    } else if (this.weather === "snow") {
      // 2 attempts at 40% each
      for (let i = 0; i < 2; i++) if (Math.random() < 0.4) this.trySpawnSnow();
    } else if (this.weather === "sandstorm") {
      for (let i = 0; i < 3; i++) this.trySpawnSand();
    } else if (this.weather === "cherry_blossoms") {
      const point = cherrySpawnPoint(this.width, this.height, this.cherryLeaves);
      if (point) this.spawn(CHERRY, point.x, point.y);
    }

    // Update particles
    const stepX4 = cameraStepX * 4;
    const stepY4 = cameraStepY * 4;
    const stepX2 = cameraStepX * 2;
    const stepY2 = cameraStepY * 2;

    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      if (!p || !p.alive) continue;
      const slotParity = p.slot & 1; // IsEvenSpriteIndex returns bit 0 of the OAM slot.

      if (p.kind === RAINDROP) {
        // 5% chance of splashing
        if (Math.random() < 0.05) {
          // convert to splash in-place
          p.kind = RAINSPLASH;
          p.ttlFrames = 4;
          p.sprite.texture = this.splashTex as Texture;
          p.sprite.rotation = 0;
        } else {
          // y: min 8 + (even?2:0) - 4*stepY
          const y = p.y - stepY4 + 2 * slotParity + 8;
          // x: base -4 - 4*stepX - (even?2:0)
          const x = p.x - stepX4 - 4 - 2 * slotParity;
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
        if (
          p.ttlFrames <= 0 ||
          y >= this.height + TILE_WIDTH ||
          y < -TILE_WIDTH ||
          x < -TILE_WIDTH ||
          x > this.width + TILE_WIDTH
        ) {
          this.despawn(i--);
        }
        continue;
      }

      if (p.kind === SNOWFLAKE || p.kind === CHERRY) {
        if (p.kind === CHERRY && Math.random() < 2 / 256) {
          this.despawn(i--);
          continue;
        }
        // y: min 2 + (even?1:0) - 2*stepY
        const y = p.y - stepY2 + slotParity + 2;
        // x wiggle: 50% chance to add 1 to the step; x -= (2*stepX + wiggle)
        const wiggle = Math.random() < 0.5 ? 1 : 0;
        const x = p.x - (stepX2 + wiggle);
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
        const y = p.y - stepY4 - 4 + 2 * slotParity;
        // x drifts left strongly: -12 - 4*stepX - (even?2:0)
        const x = p.x - stepX4 - 12 - 2 * slotParity;
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
    this.limitSprites(actors);
  }

  private clearOamMasks(): void {
    for (const [sprite, mask] of this.oamMasks) {
      if (!sprite.destroyed) sprite.mask = null;
      if (!mask.destroyed) mask.destroy();
    }
    this.oamMasks.clear();
  }

  private limitSprites(actors: WeatherActor[]): void {
    const particles = [...this.particles].sort((a, b) => b.slot - a.slot);
    const groups = [...actors, ...particles.map(p => ({
      sprite: p.sprite, weatherSlot: p.slot, tiles: [{ x: Math.round(p.x - 4), y: Math.round(p.y - 4) }],
    }))];
    const clips = weatherOamClips(groups, this.width, this.height);
    const active = new Set<Sprite>();
    for (const [index, rectangles] of clips) {
      const sprite = groups[index].sprite;
      if (index >= actors.length && !rectangles.length) {
        // Hidden weather OAM slots are immediately available for another spawn.
        this.despawn(this.particles.indexOf(particles[index - actors.length]));
        continue;
      }
      active.add(sprite);
      let mask = this.oamMasks.get(sprite);
      if (!mask) {
        mask = new Graphics();
        mask.eventMode = "none";
        sprite.addChild(mask);
        sprite.mask = mask;
        this.oamMasks.set(sprite, mask);
      }
      mask.clear().beginFill(0xffffff);
      for (const rect of rectangles) {
        mask.drawRect((rect.x - sprite.x) / sprite.scale.x, (rect.y - sprite.y) / sprite.scale.y,
          rect.width / sprite.scale.x, rect.height / sprite.scale.y);
      }
      mask.endFill();
    }
    for (const [sprite, mask] of this.oamMasks) {
      if (active.has(sprite)) continue;
      if (!sprite.destroyed) sprite.mask = null;
      if (!mask.destroyed) mask.destroy();
      this.oamMasks.delete(sprite);
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
    if (Math.random() * 4 < 1) {
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
    this.lightningStart = performance.now();
    if (!this.lightningFilter) {
      this.lightningFilter = new Filter(undefined, lightningFragment, { uFadeTable: whiteFadeTable(), uRow: 0 });
      this.parent.filters = [...(this.parent.filters ?? []), this.lightningFilter];
    }
    this.lightningFilter.uniforms.uRow = 0.5 / (LIGHTNING_STEPS + 1);
  }

  private endLightning(): void {
    if (!this.lightningFilter) return;
    this.parent.filters = (this.parent.filters ?? []).filter(filter => filter !== this.lightningFilter);
    this.lightningFilter.destroy();
    this.lightningFilter = null;
  }
}
