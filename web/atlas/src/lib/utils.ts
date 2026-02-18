import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Converts in-game data to its simplest form for URL anchors and comparisons.
 * - Decapitalizes everything
 * - Removes underscores, dashes, apostrophes, periods, spaces, angle brackets
 * - Replaces ♂ and ♀ with m and f
 * - Replaces é with e
 */
export const reduce = (str: string): string => {
  return str
    .toLowerCase()
    .replaceAll(" ", "")
    .replaceAll("<", "")
    .replaceAll(">", "")
    .replaceAll("_", "")
    .replaceAll("-", "")
    .replaceAll("'", "")
    .replaceAll(".", "")
    .replaceAll("♂", "m")
    .replaceAll("♀", "f")
    .replaceAll("é", "e");
};
