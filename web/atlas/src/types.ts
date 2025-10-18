export type ConnectionDirection = "north" | "south" | "west" | "east";

export interface ConnectionDTO {
  direction: ConnectionDirection | string;
  label: string;
  map_constant: string;
  offset: number;
  target_present: boolean;
}

export interface MapDTO {
  label: string;
  map_constant: string;
  border_block: string;
  connection_flags: string[];
  width?: number | null;
  height?: number | null;
  width_px?: number | null;
  height_px?: number | null;
  map_type?: string | null;
  group?: number | null;
  tileset?: string | null;
  roof_constant?: string | null;
  asset: string;
  connections: ConnectionDTO[];
}

export interface ConnectionGraphDTO {
  root: string;
  map_count: number;
  block_pixel_size?: number | null;
  maps: Record<string, MapDTO>;
}

export interface MapPlacement {
  label: string;
  xBlocks: number;
  yBlocks: number;
  widthBlocks: number;
  heightBlocks: number;
  x: number;
  y: number;
  widthPx: number;
  heightPx: number;
  asset: string;
  connections: ConnectionDTO[];
  metadata: {
    mapType: string | null;
    tileset: string | null;
    neighborhoodId?: string | null;
    neighborhoodRoot?: string | null;
    neighborhoodZ?: number | null;
  };
}

export interface AtlasLayout {
  root: string;
  blockPixelSize: number;
  placements: MapPlacement[];
  bounds: {
    width: number;
    height: number;
  };
  metadata?: {
    neighborhoods?: NeighborhoodSummary[];
    source?: "manifest" | "graph";
    manifestVersion?: number;
  };
}

export interface NeighborhoodSummary {
  id: string;
  root: string;
  graph: string;
  mapCount: number;
  primaryType: string | null;
  boundsBlocks: {
    width: number;
    height: number;
  };
  offsetBlocks: [number, number];
  zOffset: number;
}

export interface NeighborhoodManifestEntry {
  id: string;
  root: string;
  graph: string;
  map_count: number;
  primary_type: string | null;
  types_present: string[];
  map_labels: string[];
  fingerprint: string;
  bounds_blocks: {
    width: number;
    height: number;
  };
  offset_blocks: [number, number] | null;
  z_offset?: number | null;
}

export interface NeighborhoodManifest {
  version: number;
  generated_at: string;
  neighborhoods: NeighborhoodManifestEntry[];
}

export interface MapAnimationMetadata {
  version: number;
  image: string;
  frameWidth: number;
  frameHeight: number;
  frameCount: number;
  frameDurationsMs: number[];
  loopDurationMs: number;
  sheetColumns?: number;
}

export interface WarpEndpointDTO {
  map_constant?: string | null;
  map_label?: string | null;
  warp_index?: number | null;
  map_type?: string | null;
  is_overworld?: boolean | null;
  x_cells?: number | null;
  y_cells?: number | null;
}

export interface WarpEntryDTO {
  index: number;
  x_cells?: number | null;
  y_cells?: number | null;
  target: WarpEndpointDTO;
}

export interface MapCollisionDTO {
  encoding?: string | null;
  width_cells?: number | null;
  height_cells?: number | null;
  tileset_constant?: string | null;
  tileset_label?: string | null;
  tileset_index?: number | null;
  cells?: string | null;
}

export interface MapMetadataDTO {
  label: string;
  map_constant?: string | null;
  map_type?: string | null;
  width_blocks?: number | null;
  height_blocks?: number | null;
  is_overworld?: boolean | null;
  warps?: WarpEntryDTO[];
  collision?: MapCollisionDTO | null;
}

export interface WarpMetadataPayload {
  version: number;
  generated_at: string;
  cells_per_block?: number | null;
  cell_pixel_size?: number | null;
  collision_permissions?: Array<number | null | undefined>;
  collision_constants?: Record<string, number>;
  maps: Record<string, MapMetadataDTO>;
  constant_lookup: Record<string, string>;
}

export interface WarpEndpoint {
  mapConstant: string | null;
  mapLabel: string | null;
  warpIndex: number | null;
  mapType: string | null;
  isOverworld: boolean;
  xCells: number | null;
  yCells: number | null;
}

export interface MapWarp {
  index: number;
  xCells: number | null;
  yCells: number | null;
  target: WarpEndpoint;
}

export interface MapCollisionMetadata {
  encoding: string;
  widthCells: number;
  heightCells: number;
  tilesetConstant: string | null;
  tilesetLabel: string | null;
  tilesetIndex: number | null;
  cells: string;
  cellBytes: Uint8Array<ArrayBufferLike>;
}

export interface MapMetadataEntry {
  label: string;
  mapConstant: string | null;
  mapType: string | null;
  widthBlocks: number | null;
  heightBlocks: number | null;
  isOverworld: boolean;
  warps: MapWarp[];
  collision: MapCollisionMetadata | null;
}

export interface WarpMetadata {
  version: number;
  generatedAt: string;
  cellsPerBlock: number;
  cellPixelSize: number;
  maps: Record<string, MapMetadataEntry>;
  constantLookup: Record<string, string>;
  collisionPermissions: number[];
  collisionConstants: Record<string, number>;
}

export type RgbTuple = [number, number, number];

export interface ObjectPaletteEntry {
  timeVariants?: Record<string, RgbTuple[]>;
  overcast?: Record<string, RgbTuple[]>;
  darkness?: RgbTuple[] | null;
  static?: RgbTuple[] | null;
}

export interface ObjectSpriteDefinition {
  id: number;
  gfxPointer: string;
  spriteType: string;
  defaultPalette: string | null;
  tilePath: string;
  tileCount: number;
  tiles2bppBase64: string;
}

export interface PokemonIconVariantDefinition {
  tilePath: string;
  tileCount: number;
  tiles2bppBase64: string;
  frameCount: number;
  frameTileStride: number;
  frameDurationFrames: number;
  width: number;
  height: number;
  palette: {
    normal: string | null;
    shiny: string | null;
  };
}

export interface PokemonIconSpeciesDefinition {
  forms: Record<string, PokemonIconVariantDefinition>;
}

export interface PokemonIconMetadata {
  frameTileStride: number;
  framePixelWidth: number;
  framePixelHeight: number;
  defaultFrameDurationFrames: number;
  entries: Record<string, PokemonIconSpeciesDefinition>;
}

export interface ObjectMovementDefinition {
  id: number;
  function: string;
  facing: string;
  action: string;
  flags1: number;
  flags2: number;
  paletteFlags: number;
}

export type MovementCategory =
  | "static"
  | "axis-walk"
  | "random-walk"
  | "spin"
  | "scripted"
  | "follow"
  | "player"
  | "object"
  | "effect"
  | "special";

export type MovementAxes = "x" | "y" | "xy";

export type MovementMedium = "land" | "water";

export type MovementSpinDirection = "clockwise" | "counterclockwise" | "random";

export interface MovementModel {
  category: MovementCategory;
  axes?: MovementAxes;
  medium?: MovementMedium;
  spinDirection?: MovementSpinDirection;
  speed?: "slow" | "normal" | "fast";
  followExact?: boolean;
  facing?: "down" | "up" | "left" | "right";
  note?: string;
}

export interface MapCellCoordinate {
  x: number;
  y: number;
}

export interface MovementBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface MovementStep {
  index: number;
  from: MapCellCoordinate;
  to: MapCellCoordinate;
  direction: "down" | "up" | "left" | "right";
}

export interface MovementSummary {
  model: MovementModel;
  startCell: MapCellCoordinate;
  medium: MovementMedium;
  description: string;
  axis?: MovementAxes;
  path?: MapCellCoordinate[];
  bounds?: MovementBounds;
  reachable?: MapCellCoordinate[];
  blockedNotes?: string[];
  notes?: string[];
  steps?: MovementStep[];
}

export interface ObjectFacingEntry {
  label: string;
  tiles: Array<{
    dx: number;
    dy: number;
    tile: number;
    attributes: number;
  }>;
}

export interface ObjectEventEntry {
  index: number;
  macro: string;
  xTiles: number;
  yTiles: number;
  xPixels: number;
  yPixels: number;
  sprite: {
    constant: string | null;
    id: number | null;
  };
  movement: {
    constant: string | null;
    id: number | null;
  };
  range: {
    x: number | null;
    y: number | null;
  };
  timeOfDay: {
    mask: number | null;
    slots: string[];
  };
  paletteOverride: {
    value: number | null;
    constant: string | null;
  };
  objectType: {
    constant: string | null;
    id: number | null;
  };
  script: {
    command: string | null;
    argument: string | null;
  };
  eventFlag: string | null;
  eventFlagSet: boolean;
  species?: {
    constant: string | null;
    id: number | null;
  };
  extra?: Record<string, unknown>;
}

export interface MapObjectMetadataEntry {
  label: string;
  mapConstant: string | null;
  mapType: string | null;
  widthBlocks: number | null;
  heightBlocks: number | null;
  objects: ObjectEventEntry[];
}

export interface ObjectMetadata {
  version: number;
  generatedAt: string;
  blockPixelSize: number;
  cellsPerBlock: number;
  eventCellPixelSize: number;
  paletteNames: string[];
  timeOfDaySlots: string[];
  defaultFacingForDirection: Record<string, string>;
  palettes: Record<string, ObjectPaletteEntry>;
  sprites: Record<string, ObjectSpriteDefinition>;
  movements: Record<string, ObjectMovementDefinition>;
  facings: Record<string, ObjectFacingEntry>;
  maps: Record<string, MapObjectMetadataEntry>;
  pokemonIcons: PokemonIconMetadata | null;
}
