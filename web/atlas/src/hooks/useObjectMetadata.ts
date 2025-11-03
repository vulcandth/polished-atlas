import { useCallback, useEffect, useMemo, useState } from "react";
import { joinBasePath, withBasePath, withVersion } from "@/lib/basePath";
import type {
  MapObjectMetadataEntry,
  ObjectEventEntry,
  ObjectFacingEntry,
  ObjectMetadata,
  ObjectMovementDefinition,
  ObjectPaletteEntry,
  ObjectSpriteDefinition,
  PokemonIconMetadata,
  PokemonIconSpeciesDefinition,
  PokemonIconVariantDefinition,
  RgbTuple,
} from "@/types";

type RawRgbTuple = [number, number, number];

type RawPaletteEntry = {
  time_variants?: Record<string, RawRgbTuple[]>;
  overcast?: Record<string, RawRgbTuple[]>;
  darkness?: RawRgbTuple[] | null;
  static?: RawRgbTuple[] | null;
};

type RawSpriteDefinition = {
  id?: number;
  gfx_pointer?: string;
  sprite_type?: string;
  default_palette?: string | null;
  tile_path?: string;
  tile_count?: number;
  tiles_2bpp_base64?: string;
};

type RawMovementDefinition = {
  id?: number;
  function?: string;
  facing?: string;
  action?: string;
  flags1?: number;
  flags2?: number;
  palette_flags?: number;
};

type RawFacingEntry = {
  label?: string;
  entries?: Array<{
    dx?: number;
    dy?: number;
    tile?: number;
    attributes?: number;
  }>;
};

type RawObjectEventEntry = {
  index?: number;
  macro?: string;
  x_tiles?: number;
  y_tiles?: number;
  x_pixels?: number;
  y_pixels?: number;
  sprite?: {
    constant?: string | null;
    id?: number | null;
  };
  movement?: {
    constant?: string | null;
    id?: number | null;
  };
  range?: {
    x?: number | null;
    y?: number | null;
  };
  time_of_day?: {
    mask?: number | null;
    slots?: string[];
  };
  palette_override?: {
    value?: number | null;
    constant?: string | null;
  };
  object_type?: {
    constant?: string | null;
    id?: number | null;
  };
  script?: {
    command?: string | null;
    argument?: string | null;
  };
  event_flag?: string | null;
  event_flag_set?: boolean;
  species?: {
    constant?: string | null;
    id?: number | null;
  };
  extra?: Record<string, unknown>;
};

type RawMapObjectEntry = {
  label?: string;
  map_constant?: string | null;
  map_type?: string | null;
  width_blocks?: number | null;
  height_blocks?: number | null;
  objects?: RawObjectEventEntry[];
};

type RawObjectMetadata = {
  version?: number;
  generated_at?: string;
  block_pixel_size?: number;
  cells_per_block?: number;
  event_cell_pixel_size?: number;
  palette_names?: string[];
  time_of_day_slots?: string[];
  default_facing_for_direction?: Record<string, string>;
  palettes?: Record<string, RawPaletteEntry>;
  sprites?: Record<string, RawSpriteDefinition>;
  movements?: Record<string, RawMovementDefinition>;
  facings?: Record<string, RawFacingEntry>;
  maps?: Record<string, RawMapObjectEntry>;
  pokemon_icons?: RawPokemonIconMetadata;
};

type RawPokemonIconPalette = {
  normal?: string | null;
  shiny?: string | null;
};

type RawPokemonIconVariant = {
  tile_path?: string;
  tile_count?: number;
  tiles_2bpp_base64?: string;
  frame_count?: number;
  frame_tile_stride?: number;
  frame_duration_frames?: number;
  width?: number;
  height?: number;
  palette?: RawPokemonIconPalette;
};

type RawPokemonIconSpeciesEntry = {
  forms?: Record<string, RawPokemonIconVariant>;
};

type RawPokemonIconMetadata = {
  frame_tile_stride?: number;
  frame_pixel_width?: number;
  frame_pixel_height?: number;
  default_frame_duration_frames?: number;
  entries?: Record<string, RawPokemonIconSpeciesEntry>;
};

const DEFAULT_OBJECT_BLOCK_SIZE = 32;
const OBJECT_METADATA_VERSION = 1;
const EVENT_CELLS_PER_BLOCK_DEFAULT = 2;

function sanitizeRgb(tuple: RawRgbTuple | null | undefined): RgbTuple {
  const r = Number.isFinite(tuple?.[0])
    ? Math.max(0, Math.min(255, Math.trunc(tuple?.[0] as number)))
    : 0;
  const g = Number.isFinite(tuple?.[1])
    ? Math.max(0, Math.min(255, Math.trunc(tuple?.[1] as number)))
    : 0;
  const b = Number.isFinite(tuple?.[2])
    ? Math.max(0, Math.min(255, Math.trunc(tuple?.[2] as number)))
    : 0;
  return [r, g, b];
}

function sanitizePaletteEntry(raw: RawPaletteEntry | undefined): ObjectPaletteEntry {
  const entry: ObjectPaletteEntry = {};
  if (raw?.time_variants) {
    const variants: Record<string, RgbTuple[]> = {};
    for (const [key, value] of Object.entries(raw.time_variants)) {
      if (!Array.isArray(value)) {
        continue;
      }
      variants[key] = value.map((item) => sanitizeRgb(item));
    }
    if (Object.keys(variants).length > 0) {
      entry.timeVariants = variants;
    }
  }
  if (raw?.overcast) {
    const variants: Record<string, RgbTuple[]> = {};
    for (const [key, value] of Object.entries(raw.overcast)) {
      if (!Array.isArray(value)) {
        continue;
      }
      variants[key] = value.map((item) => sanitizeRgb(item));
    }
    if (Object.keys(variants).length > 0) {
      entry.overcast = variants;
    }
  }
  if (Array.isArray(raw?.darkness)) {
    entry.darkness = raw?.darkness.map((item) => sanitizeRgb(item));
  } else if (raw?.darkness != null) {
    entry.darkness = [];
  }
  if (Array.isArray(raw?.static)) {
    entry.static = raw?.static.map((item) => sanitizeRgb(item));
  } else if (raw?.static != null) {
    entry.static = [];
  }
  return entry;
}

function sanitizeSpriteDefinition(raw: RawSpriteDefinition | undefined): ObjectSpriteDefinition {
  return {
    id: Number.isFinite(raw?.id) ? Math.trunc(raw?.id as number) : 0,
    gfxPointer: typeof raw?.gfx_pointer === "string" ? raw!.gfx_pointer : "",
    spriteType: typeof raw?.sprite_type === "string" ? raw!.sprite_type : "UNKNOWN",
    defaultPalette: typeof raw?.default_palette === "string" ? raw!.default_palette : null,
    tilePath: typeof raw?.tile_path === "string" ? raw!.tile_path : "",
    tileCount: Number.isFinite(raw?.tile_count) ? Math.trunc(raw?.tile_count as number) : 0,
    tiles2bppBase64: typeof raw?.tiles_2bpp_base64 === "string" ? raw!.tiles_2bpp_base64 : "",
  };
}

function sanitizePokemonIconVariant(
  raw: RawPokemonIconVariant | undefined,
  defaults: { frameTileStride: number; frameDurationFrames: number; width: number; height: number },
): PokemonIconVariantDefinition | null {
  const tiles2bppBase64 = typeof raw?.tiles_2bpp_base64 === "string" ? raw.tiles_2bpp_base64 : "";
  if (!tiles2bppBase64) {
    return null;
  }
  const tileCount = Number.isFinite(raw?.tile_count)
    ? Math.max(0, Math.trunc(raw!.tile_count as number))
    : 0;
  const frameTileStride = Number.isFinite(raw?.frame_tile_stride)
    ? Math.max(1, Math.trunc(raw!.frame_tile_stride as number))
    : defaults.frameTileStride;
  const inferredFrameCount =
    frameTileStride > 0 ? Math.max(1, Math.trunc(tileCount / frameTileStride)) : 1;
  const frameCount = Number.isFinite(raw?.frame_count)
    ? Math.max(1, Math.trunc(raw!.frame_count as number))
    : inferredFrameCount;
  const frameDurationFrames = Number.isFinite(raw?.frame_duration_frames)
    ? Math.max(1, Math.trunc(raw!.frame_duration_frames as number))
    : defaults.frameDurationFrames;
  const width = Number.isFinite(raw?.width)
    ? Math.max(1, Math.trunc(raw!.width as number))
    : defaults.width;
  const height = Number.isFinite(raw?.height)
    ? Math.max(1, Math.trunc(raw!.height as number))
    : defaults.height;
  const tilePath = typeof raw?.tile_path === "string" ? raw.tile_path : "";
  const paletteNormal =
    typeof raw?.palette?.normal === "string"
      ? raw.palette!.normal
      : raw?.palette?.normal === null
        ? null
        : null;
  const paletteShiny =
    typeof raw?.palette?.shiny === "string"
      ? raw.palette!.shiny
      : raw?.palette?.shiny === null
        ? null
        : null;

  return {
    tilePath,
    tileCount,
    tiles2bppBase64,
    frameCount,
    frameTileStride,
    frameDurationFrames,
    width,
    height,
    palette: {
      normal: paletteNormal,
      shiny: paletteShiny,
    },
  };
}

function sanitizePokemonIconMetadata(
  raw: RawPokemonIconMetadata | undefined,
): PokemonIconMetadata | null {
  if (!raw) {
    return null;
  }
  const frameTileStride = Number.isFinite(raw.frame_tile_stride)
    ? Math.max(1, Math.trunc(raw.frame_tile_stride as number))
    : 4;
  const width = Number.isFinite(raw.frame_pixel_width)
    ? Math.max(1, Math.trunc(raw.frame_pixel_width as number))
    : 16;
  const height = Number.isFinite(raw.frame_pixel_height)
    ? Math.max(1, Math.trunc(raw.frame_pixel_height as number))
    : width;
  const defaultFrameDurationFrames = Number.isFinite(raw.default_frame_duration_frames)
    ? Math.max(1, Math.trunc(raw.default_frame_duration_frames as number))
    : 8;
  const entries: Record<string, PokemonIconSpeciesDefinition> = {};
  for (const [species, speciesRaw] of Object.entries(raw.entries ?? {})) {
    const formEntries = speciesRaw?.forms ?? {};
    const forms: Record<string, PokemonIconVariantDefinition> = {};
    for (const [formKey, variantRaw] of Object.entries(formEntries)) {
      const variant = sanitizePokemonIconVariant(variantRaw, {
        frameTileStride,
        frameDurationFrames: defaultFrameDurationFrames,
        width,
        height,
      });
      if (variant) {
        forms[formKey] = variant;
      }
    }
    if (Object.keys(forms).length > 0) {
      entries[species] = { forms };
    }
  }
  if (Object.keys(entries).length === 0) {
    return null;
  }
  return {
    frameTileStride,
    framePixelWidth: width,
    framePixelHeight: height,
    defaultFrameDurationFrames,
    entries,
  };
}

function sanitizeMovementDefinition(
  raw: RawMovementDefinition | undefined,
  fallbackId: number,
): ObjectMovementDefinition {
  return {
    id: Number.isFinite(raw?.id) ? Math.trunc(raw?.id as number) : fallbackId,
    function: typeof raw?.function === "string" ? raw!.function : "",
    facing: typeof raw?.facing === "string" ? raw!.facing : "DOWN",
    action: typeof raw?.action === "string" ? raw!.action : "",
    flags1: Number.isFinite(raw?.flags1) ? Math.trunc(raw?.flags1 as number) : 0,
    flags2: Number.isFinite(raw?.flags2) ? Math.trunc(raw?.flags2 as number) : 0,
    paletteFlags: Number.isFinite(raw?.palette_flags)
      ? Math.trunc(raw?.palette_flags as number)
      : 0,
  };
}

function sanitizeFacingEntry(raw: RawFacingEntry | undefined, key: string): ObjectFacingEntry {
  const tiles: ObjectFacingEntry["tiles"] = [];
  if (Array.isArray(raw?.entries)) {
    for (const entry of raw!.entries!) {
      tiles.push({
        dx: Number.isFinite(entry?.dx) ? Math.trunc(entry?.dx ?? 0) : 0,
        dy: Number.isFinite(entry?.dy) ? Math.trunc(entry?.dy ?? 0) : 0,
        tile: Number.isFinite(entry?.tile) ? Math.trunc(entry?.tile ?? 0) : 0,
        attributes: Number.isFinite(entry?.attributes) ? Math.trunc(entry?.attributes ?? 0) : 0,
      });
    }
  }
  return {
    label: typeof raw?.label === "string" && raw!.label.trim().length > 0 ? raw!.label : key,
    tiles,
  };
}

function sanitizeObjectEvent(raw: RawObjectEventEntry | undefined): ObjectEventEntry {
  const timeSlots = Array.isArray(raw?.time_of_day?.slots)
    ? raw!.time_of_day!.slots.filter((slot) => typeof slot === "string")
    : [];
  return {
    index: Number.isFinite(raw?.index) ? Math.trunc(raw?.index ?? 0) : 0,
    macro: typeof raw?.macro === "string" ? raw!.macro : "object_event",
    xTiles: Number.isFinite(raw?.x_tiles) ? Math.trunc(raw?.x_tiles ?? 0) : 0,
    yTiles: Number.isFinite(raw?.y_tiles) ? Math.trunc(raw?.y_tiles ?? 0) : 0,
    xPixels: Number.isFinite(raw?.x_pixels) ? Math.trunc(raw?.x_pixels ?? 0) : 0,
    yPixels: Number.isFinite(raw?.y_pixels) ? Math.trunc(raw?.y_pixels ?? 0) : 0,
    sprite: {
      constant: typeof raw?.sprite?.constant === "string" ? raw!.sprite!.constant : null,
      id: Number.isFinite(raw?.sprite?.id) ? Math.trunc(raw!.sprite!.id as number) : null,
    },
    movement: {
      constant: typeof raw?.movement?.constant === "string" ? raw!.movement!.constant : null,
      id: Number.isFinite(raw?.movement?.id) ? Math.trunc(raw!.movement!.id as number) : null,
    },
    range: {
      x: Number.isFinite(raw?.range?.x) ? Math.trunc(raw!.range!.x as number) : null,
      y: Number.isFinite(raw?.range?.y) ? Math.trunc(raw!.range!.y as number) : null,
    },
    timeOfDay: {
      mask: Number.isFinite(raw?.time_of_day?.mask)
        ? Math.trunc(raw!.time_of_day!.mask as number)
        : null,
      slots: timeSlots,
    },
    paletteOverride: {
      value: Number.isFinite(raw?.palette_override?.value)
        ? Math.trunc(raw!.palette_override!.value as number)
        : raw?.palette_override?.value === 0
          ? 0
          : null,
      constant:
        typeof raw?.palette_override?.constant === "string"
          ? raw!.palette_override!.constant
          : null,
    },
    objectType: {
      constant: typeof raw?.object_type?.constant === "string" ? raw!.object_type!.constant : null,
      id: Number.isFinite(raw?.object_type?.id) ? Math.trunc(raw!.object_type!.id as number) : null,
    },
    script: {
      command: typeof raw?.script?.command === "string" ? raw!.script!.command : null,
      argument: typeof raw?.script?.argument === "string" ? raw!.script!.argument : null,
    },
    eventFlag: typeof raw?.event_flag === "string" ? raw!.event_flag : null,
    eventFlagSet: raw?.event_flag_set === true,
    species:
      raw?.species && (typeof raw.species.constant === "string" || Number.isFinite(raw.species.id))
        ? {
            constant: typeof raw.species.constant === "string" ? raw.species.constant : null,
            id: Number.isFinite(raw.species.id) ? Math.trunc(raw.species.id as number) : null,
          }
        : undefined,
    extra: raw?.extra ?? undefined,
  };
}

function sanitizeMapEntry(
  raw: RawMapObjectEntry | undefined,
  label: string,
): MapObjectMetadataEntry {
  const objects: ObjectEventEntry[] = Array.isArray(raw?.objects)
    ? raw!.objects!.map((entry) => sanitizeObjectEvent(entry))
    : [];
  return {
    label: typeof raw?.label === "string" && raw!.label.trim().length > 0 ? raw!.label : label,
    mapConstant: typeof raw?.map_constant === "string" ? raw!.map_constant : null,
    mapType: typeof raw?.map_type === "string" ? raw!.map_type : null,
    widthBlocks: Number.isFinite(raw?.width_blocks)
      ? Math.trunc(raw!.width_blocks as number)
      : null,
    heightBlocks: Number.isFinite(raw?.height_blocks)
      ? Math.trunc(raw!.height_blocks as number)
      : null,
    objects,
  };
}

function convertObjectMetadata(payload: RawObjectMetadata): ObjectMetadata {
  const blockPixelSize = Number.isFinite(payload.block_pixel_size)
    ? Math.max(1, Math.trunc(payload.block_pixel_size as number))
    : DEFAULT_OBJECT_BLOCK_SIZE;
  const cellsPerBlock = Number.isFinite(payload.cells_per_block)
    ? Math.max(1, Math.trunc(payload.cells_per_block as number))
    : EVENT_CELLS_PER_BLOCK_DEFAULT;
  const baseCellPixelSize = Number.isFinite(payload.event_cell_pixel_size)
    ? Math.max(1, Math.trunc(payload.event_cell_pixel_size as number))
    : Math.max(1, Math.trunc(blockPixelSize / cellsPerBlock));
  const paletteNames = Array.isArray(payload.palette_names)
    ? payload.palette_names.filter(Boolean)
    : [];
  const timeOfDaySlots = Array.isArray(payload.time_of_day_slots)
    ? payload.time_of_day_slots.filter((slot) => typeof slot === "string")
    : [];
  const defaultFacing = payload.default_facing_for_direction
    ? { ...payload.default_facing_for_direction }
    : {};

  const palettes: Record<string, ObjectPaletteEntry> = {};
  for (const [name, rawEntry] of Object.entries(payload.palettes ?? {})) {
    palettes[name] = sanitizePaletteEntry(rawEntry);
  }
  const sprites: Record<string, ObjectSpriteDefinition> = {};
  for (const [name, rawEntry] of Object.entries(payload.sprites ?? {})) {
    sprites[name] = sanitizeSpriteDefinition(rawEntry);
  }
  const pokemonIcons = sanitizePokemonIconMetadata(payload.pokemon_icons);
  const movements: Record<string, ObjectMovementDefinition> = {};
  let fallbackId = 0;
  for (const [name, rawEntry] of Object.entries(payload.movements ?? {})) {
    movements[name] = sanitizeMovementDefinition(rawEntry, fallbackId);
    fallbackId += 1;
  }
  const facings: Record<string, ObjectFacingEntry> = {};
  for (const [name, rawEntry] of Object.entries(payload.facings ?? {})) {
    facings[name] = sanitizeFacingEntry(rawEntry, name);
  }
  const maps: Record<string, MapObjectMetadataEntry> = {};
  for (const [label, rawEntry] of Object.entries(payload.maps ?? {})) {
    maps[label] = sanitizeMapEntry(rawEntry, label);
  }

  return {
    version: Number.isFinite(payload.version)
      ? Math.trunc(payload.version as number)
      : OBJECT_METADATA_VERSION,
    generatedAt:
      typeof payload.generated_at === "string" ? payload.generated_at : new Date().toISOString(),
    blockPixelSize,
    cellsPerBlock,
    eventCellPixelSize: baseCellPixelSize,
    paletteNames,
    timeOfDaySlots,
    defaultFacingForDirection: defaultFacing,
    palettes,
    sprites,
    movements,
    facings,
    maps,
    pokemonIcons,
  };
}

function resolveObjectMetadataUrl(): string {
  const override =
    typeof import.meta.env.VITE_OBJECT_METADATA_URL === "string"
      ? import.meta.env.VITE_OBJECT_METADATA_URL.trim()
      : "";
  if (override) {
    return withVersion(withBasePath(override));
  }
  if (import.meta.env.DEV) {
    const repoRoot = typeof __REPO_ROOT__ === "string" ? __REPO_ROOT__ : "";
    if (repoRoot && typeof window !== "undefined" && window.location?.origin) {
      const raw = `${repoRoot}/maps/object_metadata.json`.replace(/\\/g, "/");
      const withSlash = raw.startsWith("/") ? raw : `/${raw}`;
      return withVersion(`${window.location.origin}/@fs${encodeURI(withSlash)}`);
    }
  }
  return withVersion(joinBasePath("maps", "object_metadata.json"));
}

interface UseObjectMetadataResult {
  metadata: ObjectMetadata | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useObjectMetadata(url?: string): UseObjectMetadataResult {
  const [metadata, setMetadata] = useState<ObjectMetadata | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const resolvedUrl = useMemo(() => {
    const provided = typeof url === "string" && url.trim().length > 0 ? url.trim() : null;
    if (provided) {
      return withVersion(withBasePath(provided));
    }
    return resolveObjectMetadataUrl();
  }, [url]);

  useEffect(() => {
    const controller = new AbortController();
    const run = async (): Promise<void> => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(resolvedUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch object metadata (${response.status}).`);
        }
        const payload = (await response.json()) as RawObjectMetadata;
        setMetadata(convertObjectMetadata(payload));
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        console.error("Failed to load object metadata", err);
        const message = err instanceof Error ? err.message : "Unknown error";
        setError(message);
        setMetadata(null);
      } finally {
        setLoading(false);
      }
    };

    run().catch((err) => {
      console.error(err);
    });

    return () => {
      controller.abort();
    };
  }, [resolvedUrl, nonce]);

  const reload = useCallback(() => {
    setNonce((value) => value + 1);
  }, []);

  return useMemo(() => ({ metadata, loading, error, reload }), [metadata, loading, error, reload]);
}
