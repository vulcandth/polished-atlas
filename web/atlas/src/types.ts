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
}
