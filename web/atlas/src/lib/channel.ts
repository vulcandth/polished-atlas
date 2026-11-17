import { PUBLIC_BASE_PATH } from "./basePath";

export const ATLAS_CHANNEL = import.meta.env.VITE_ATLAS_CHANNEL === "dev" ? "dev" : "stable";

export function channelStorageKey(key: string): string {
  return ATLAS_CHANNEL === "dev" ? `dev:${key}` : key;
}

export function otherChannelHref(base = PUBLIC_BASE_PATH, channel = ATLAS_CHANNEL): string {
  return channel === "dev" ? base.replace(/dev\/$/, "") : `${base}dev/`;
}

export const UPSTREAM_COMMIT_URL = `${import.meta.env.VITE_POLISHED_CRYSTAL_REPOSITORY ?? "https://github.com/Rangi42/polishedcrystal"}/commit/${import.meta.env.VITE_POLISHED_CRYSTAL_COMMIT ?? "e410d7405e7d5d016b16a0a59bfb6da0b2a9eabf"}`;
