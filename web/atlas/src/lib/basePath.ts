const ABSOLUTE_URL_PATTERN = /^(?:[a-z]+:)?\/\//i;

function normaliseBase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "/";
  }
  let result = trimmed;
  if (!result.startsWith("/")) {
    result = `/${result}`;
  }
  if (!result.endsWith("/")) {
    result = `${result}/`;
  }
  return result;
}

const RAW_BASE = typeof __PUBLIC_BASE__ === "string" ? __PUBLIC_BASE__ : "/";
export const PUBLIC_BASE_PATH = normaliseBase(RAW_BASE);

type PathInput = string | null | undefined;

function sanitiseRelativePath(path: PathInput): string {
  if (typeof path !== "string") {
    return "";
  }
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (ABSOLUTE_URL_PATTERN.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    const withoutLeading = trimmed.slice(1);
    return withoutLeading.length > 0 ? withoutLeading : "";
  }
  return trimmed;
}

export function isAbsoluteUrl(value: string | null | undefined): boolean {
  if (typeof value !== "string") {
    return false;
  }
  return ABSOLUTE_URL_PATTERN.test(value);
}

export function withBasePath(path: PathInput): string {
  if (path == null) {
    return PUBLIC_BASE_PATH;
  }
  if (typeof path !== "string") {
    return PUBLIC_BASE_PATH;
  }
  const trimmed = path.trim();
  if (trimmed.length === 0) {
    return PUBLIC_BASE_PATH;
  }
  if (isAbsoluteUrl(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith(PUBLIC_BASE_PATH)) {
    return trimmed;
  }
  if (trimmed.startsWith("/")) {
    const remainder = trimmed.slice(1);
    if (PUBLIC_BASE_PATH === "/") {
      return `/${remainder}`;
    }
    return `${PUBLIC_BASE_PATH}${remainder}`;
  }
  if (PUBLIC_BASE_PATH === "/") {
    return `/${trimmed}`;
  }
  return `${PUBLIC_BASE_PATH}${trimmed}`;
}

export function joinBasePath(...segments: PathInput[]): string {
  const relativeSegments = segments
    .map((segment) => sanitiseRelativePath(segment))
    .filter((segment): segment is string => segment.length > 0);
  if (relativeSegments.length === 0) {
    return PUBLIC_BASE_PATH;
  }
  const joined = relativeSegments.join("/").replace(/\/{2,}/g, "/");
  if (PUBLIC_BASE_PATH === "/") {
    return `/${joined}`;
  }
  return `${PUBLIC_BASE_PATH}${joined}`;
}

// Append cache-busting version query parameter to a URL if configured.
// If a query parameter named "v" already exists, it will be replaced.
export function withVersion(url: string): string {
  const version = (import.meta as any)?.env?.VITE_POLISHED_ATLAS_VERSION as string | undefined;
  const trimmed = typeof version === "string" ? version.trim() : "";
  if (!trimmed) {
    return url;
  }
  try {
    const base = typeof window !== "undefined" && window.location?.href ? window.location.href : "http://local/";
    const u = new URL(url, base);
    u.searchParams.set("v", trimmed);
    return u.toString();
  } catch {
    const sep = url.includes("?") ? "&" : "?";
    const encoded = encodeURIComponent(trimmed);
    return `${url}${sep}v=${encoded}`;
  }
}
