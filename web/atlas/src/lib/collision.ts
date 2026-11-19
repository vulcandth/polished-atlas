import type { MapCollisionMetadata, MovementMedium } from "@/types";

export interface CollisionHelper {
  width: number;
  height: number;
  getValue: (x: number, y: number) => number | null;
  getPermission: (x: number, y: number) => number | null;
  isPassable: (x: number, y: number, medium: MovementMedium) => boolean;
}

const DEFAULT_PERMISSION_TABLE: number[] = Array.from({ length: 0x100 }, () => 0);

// GetSideWallDirectionMask uses the low three bits for ordinary and glowing walls alike.
const WALL_MASKS = [8, 4, 1, 2, 10, 6, 9, 5];

export function canCrossSideWall(helper: CollisionHelper | null, x: number, y: number, dx: number, dy: number): boolean {
  if (!helper) return true;
  const wall = (value: number | null) =>
    value !== null && (value & 0xf0) === 0xb0 ? WALL_MASKS[value & 7] : 0;
  const from = wall(helper.getValue(x, y));
  const to = wall(helper.getValue(x + dx, y + dy));
  if (dx === 1) return !(from & 8 || to & 4);
  if (dx === -1) return !(from & 4 || to & 8);
  if (dy === 1) return !(from & 2 || to & 1);
  if (dy === -1) return !(from & 1 || to & 2);
  return true;
}

function clampToInt(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.trunc(value);
}

export function createCollisionHelper(
  metadata: MapCollisionMetadata | null | undefined,
  permissions: number[] | null | undefined,
): CollisionHelper | null {
  if (!metadata || metadata.cellBytes.length === 0) {
    return null;
  }
  const width = clampToInt(metadata.widthCells);
  const height = clampToInt(metadata.heightCells);
  if (!(width > 0) || !(height > 0)) {
    return null;
  }

  const cells = metadata.cellBytes;
  const permissionTable =
    permissions && permissions.length > 0 ? permissions.slice(0, 0x100) : DEFAULT_PERMISSION_TABLE;

  const getIndex = (x: number, y: number): number | null => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    const col = Math.trunc(x);
    const row = Math.trunc(y);
    if (col < 0 || row < 0 || col >= width || row >= height) {
      return null;
    }
    return row * width + col;
  };

  const helper: CollisionHelper = {
    width,
    height,
    getValue(x: number, y: number): number | null {
      const index = getIndex(x, y);
      if (index === null || index < 0 || index >= cells.length) {
        return null;
      }
      return cells[index];
    },
    getPermission(x: number, y: number): number | null {
      const value = helper.getValue(x, y);
      if (value === null) {
        return null;
      }
      return permissionTable[value] ?? null;
    },
    isPassable(x: number, y: number, medium: MovementMedium): boolean {
      const permission = helper.getPermission(x, y);
      if (permission === null) {
        // Default to land-passable when permission is unknown to avoid over-blocking paths.
        return medium !== "water";
      }
      if (medium === "water") {
        return permission === 1;
      }
      return permission === 0;
    },
  };

  return helper;
}
