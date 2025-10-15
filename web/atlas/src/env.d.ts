/// <reference types="vite/client" />

declare interface ImportMetaEnv {
  readonly VITE_CONNECTION_GRAPH_URL?: string;
  readonly VITE_ROOT_MAP?: string;
}

declare interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __REPO_ROOT__: string;
