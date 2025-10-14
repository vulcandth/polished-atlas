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
}
