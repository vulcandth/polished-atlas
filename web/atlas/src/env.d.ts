/// <reference types="vite/client" />

declare interface ImportMetaEnv {
  readonly VITE_CONNECTION_GRAPH_URL?: string;
  readonly VITE_ROOT_MAP?: string;
  readonly VITE_NEIGHBORHOOD_MANIFEST_URL?: string;
  readonly VITE_ATLAS_TIME?: string;
  readonly VITE_WARP_METADATA_URL?: string;
}

declare interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __REPO_ROOT__: string;
