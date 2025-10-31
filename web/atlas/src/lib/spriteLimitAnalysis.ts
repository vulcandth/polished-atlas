import type {
  MapCellCoordinate,
  MapObjectMetadataEntry,
  MovementSummary,
  ObjectEventEntry,
  ObjectFacingEntry,
  ObjectMetadata,
  WarpMetadata,
} from "@/types";
import { createCollisionHelper, type CollisionHelper } from "@/lib/collision";
import { getMovementModel } from "@/lib/movementModel";
import { simulateNpcMovement } from "@/lib/movementSimulation";

export type SpriteLimitSeverity = "at-limit" | "exceeds";

export type SpriteLimitIssueType = "scanline-limit" | "total-limit";

export interface SpriteLimitEntityRef {
  kind: "player" | "npc" | "follower" | "weather";
  index?: number; // object index within map for NPCs
  label?: string; // optional detail
  cell: MapCellCoordinate;
}

export interface SpriteLimitIssue {
  type: SpriteLimitIssueType;
  severity: SpriteLimitSeverity;
  count: number;
  limit: number;
  mapLabel: string; // label of the map where this viewport/scanline is computed
  playerCell: MapCellCoordinate;
  viewportPx: { x: number; y: number; width: number; height: number };
  scanlineY?: number; // viewport-local Y (px) for scanline-limit
  contributors: SpriteLimitEntityRef[];
}

type FacingProfile = {
  tileCount: number;
  // Raw tile offsets within the facing (top-left per 8x8 tile)
  tiles: Array<{ dx: number; dy: number }>;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const SCREEN_WIDTH_PX = 160;
const SCREEN_HEIGHT_PX = 144;
// The player camera is not perfectly centered vertically in Gen 2.
// Assume the camera is centered horizontally and biased slightly upward by 8px.
const CAMERA_ANCHOR_X = Math.floor(SCREEN_WIDTH_PX / 2); // 80
const CAMERA_ANCHOR_Y = Math.floor(SCREEN_HEIGHT_PX / 2) - 8; // 64

const TOTAL_SPRITE_LIMIT = 40;
const SCANLINE_SPRITE_LIMIT = 10;

function buildFacingProfile(facing: ObjectFacingEntry | null | undefined): FacingProfile | null {
  if (!facing || !Array.isArray(facing.tiles) || facing.tiles.length === 0) {
    return null;
  }
  let minX = 0;
  let minY = 0;
  let maxX = 0;
  let maxY = 0;
  const tiles: Array<{ dx: number; dy: number }> = [];
  for (const tile of facing.tiles) {
    const dx = Math.trunc(tile.dx ?? 0);
    const dy = Math.trunc(tile.dy ?? 0);
    if (dx < minX) minX = dx;
    if (dy < minY) minY = dy;
    const x2 = dx + 8;
    const y2 = dy + 8;
    if (x2 > maxX) maxX = x2;
    if (y2 > maxY) maxY = y2;
    tiles.push({ dx, dy });
  }
  return {
    tileCount: facing.tiles.length,
    tiles,
    minX,
    minY,
    maxX,
    maxY,
  };
}

function resolveDefaultFacing(metadata: ObjectMetadata): ObjectFacingEntry | null {
  const downKey =
    metadata.defaultFacingForDirection.DOWN ||
    (metadata.defaultFacingForDirection as any)["Down"] ||
    (metadata.defaultFacingForDirection as any)["down"] ||
    "FACING_STEP_DOWN_0";
  const entry = metadata.facings[downKey];
  if (entry && Array.isArray(entry.tiles)) {
    return entry;
  }
  const first = Object.values(metadata.facings)[0];
  return first ?? null;
}

function resolveFacingConstantForEntry(entry: ObjectEventEntry, metadata: ObjectMetadata): string | null {
  const movementKey = entry.movement?.constant ?? "";
  const movement = movementKey ? metadata.movements[movementKey] : undefined;
  const movementAction = movement?.action ?? "";
  if (movementAction === "OBJECT_ACTION_CUT_TREE" && metadata.facings["FACING_CUT_TREE"]) {
    return "FACING_CUT_TREE";
  }
  if (movementAction === "OBJECT_ACTION_FRUIT") {
    const treeNameRaw = entry.extra?.["tree"];
    const treeName = typeof treeNameRaw === "string" ? treeNameRaw : "";
    if (treeName.includes("APRICORN") && metadata.facings["FACING_APRICORN"]) {
      return "FACING_APRICORN";
    }
    if (metadata.facings["FACING_BERRY"]) {
      return "FACING_BERRY";
    }
    if (metadata.facings["FACING_PICKED_FRUIT"]) {
      return "FACING_PICKED_FRUIT";
    }
  }
  if (movementAction === "OBJECT_ACTION_BIG_GYARADOS") {
    if (metadata.facings["FACING_BIG_GYARADOS_2"]) {
      return "FACING_BIG_GYARADOS_2";
    }
    if (metadata.facings["FACING_BIG_GYARADOS_1"]) {
      return "FACING_BIG_GYARADOS_1";
    }
  }
  if (movementAction === "OBJECT_ACTION_BIG_SNORLAX" && metadata.facings["FACING_BIG_DOLL_SYM"]) {
    return "FACING_BIG_DOLL_SYM";
  }
  if (movementAction === "OBJECT_ACTION_SAILBOAT_TOP" && metadata.facings["FACING_SAILBOAT_TOP"]) {
    return "FACING_SAILBOAT_TOP";
  }
  if (movementAction === "OBJECT_ACTION_SAILBOAT_BOTTOM" && metadata.facings["FACING_SAILBOAT_BOTTOM"]) {
    return "FACING_SAILBOAT_BOTTOM";
  }
  const facingValue = movement?.facing ?? "";
  if (facingValue) {
    if (metadata.facings[facingValue]) {
      return facingValue;
    }
    const normalized = facingValue.toUpperCase();
    const mapped =
      (metadata.defaultFacingForDirection as any)[facingValue] ??
      (metadata.defaultFacingForDirection as any)[normalized] ??
      (metadata.defaultFacingForDirection as any)[normalized.toLowerCase?.() ?? normalized];
    if (mapped && metadata.facings[mapped]) {
      return mapped;
    }
  }
  const fallback =
    (metadata.defaultFacingForDirection as any).DOWN ??
    (metadata.defaultFacingForDirection as any).Down ??
    (metadata.defaultFacingForDirection as any).down ??
    "FACING_STEP_DOWN_0";
  if (fallback && metadata.facings[fallback]) {
    return fallback;
  }
  const firstKey = Object.keys(metadata.facings)[0];
  return firstKey ?? null;
}

function getObjectFacingForAnalysis(entry: ObjectEventEntry, metadata: ObjectMetadata): ObjectFacingEntry | null {
  const key = resolveFacingConstantForEntry(entry, metadata);
  if (key && metadata.facings[key]) {
    return metadata.facings[key] ?? null;
  }
  return resolveDefaultFacing(metadata);
}

function enumerateObjectCells(summary: MovementSummary | null): MapCellCoordinate[] {
  if (!summary) {
    return [];
  }
  if (Array.isArray(summary.reachable) && summary.reachable.length > 0) {
    return summary.reachable.slice();
  }
  if (Array.isArray(summary.steps) && summary.steps.length > 0) {
    const cells: MapCellCoordinate[] = [];
    const seen = new Set<string>();
    const add = (c: MapCellCoordinate) => {
      const k = `${c.x},${c.y}`;
      if (!seen.has(k)) {
        seen.add(k);
        cells.push({ x: c.x, y: c.y });
      }
    };
    add(summary.startCell);
    for (const step of summary.steps) {
      add(step.from);
      add(step.to);
    }
    return cells;
  }
  return [summary.startCell];
}

function isObjectVisibleAtTime(entry: ObjectEventEntry, timeOfDay: string): boolean {
  // Respect event flags: if the event is set, the object is hidden (not visible in-game)
  if (entry.eventFlagSet) {
    return false;
  }
  const slots = entry.timeOfDay?.slots;
  if (!Array.isArray(slots) || slots.length === 0) {
    return true;
  }
  return slots.includes(timeOfDay);
}

type AnalysisContext = {
  objectMetadata: ObjectMetadata;
  warpMetadata: WarpMetadata | null;
  cellPixelSize: number; // usually 16
  collision: CollisionHelper | null;
  timeOfDay: string;
  scanlineLimit: number;
  totalLimit: number;
  includeFollower: boolean;
  includeWeather: boolean;
};

function computeViewportForPlayer(cell: MapCellCoordinate, ctx: AnalysisContext): {
  x: number; y: number; width: number; height: number;
} {
  const pxX = cell.x * ctx.cellPixelSize;
  const pxY = cell.y * ctx.cellPixelSize;
  // Horizontal camera bias: observed one collision cell to the right
  const horizontalBias = ctx.cellPixelSize; // move screen one cell right
  return {
    x: pxX - (CAMERA_ANCHOR_X - horizontalBias),
    y: pxY - CAMERA_ANCHOR_Y,
    width: SCREEN_WIDTH_PX,
    height: SCREEN_HEIGHT_PX,
  };
}

function rectsIntersect(ax: number, ay: number, aw: number, ah: number, bx: number, by: number, bw: number, bh: number): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}
function clampToViewportY(y: number): number {
  if (y < 0) return 0;
  if (y >= SCREEN_HEIGHT_PX) return SCREEN_HEIGHT_PX - 1;
  return y;
}

function analyzeForPlayerCell(
  playerCell: MapCellCoordinate,
  npcs: Array<{ entry: ObjectEventEntry; cells: MapCellCoordinate[]; profile: FacingProfile | null }>,
  ctx: AnalysisContext,
): SpriteLimitIssue[] {
  const issues: SpriteLimitIssue[] = [];
  const viewport = computeViewportForPlayer(playerCell, ctx);
  // For total (40) sprite limit only, count sprites up to 1 collision cell offscreen.
  // Do NOT apply to player or follower; only for NPC totals.
  const totalViewport = {
    x: viewport.x - ctx.cellPixelSize,
    y: viewport.y - ctx.cellPixelSize,
    width: viewport.width + ctx.cellPixelSize * 2,
    height: viewport.height + ctx.cellPixelSize * 2,
  };
  const scanlineCounts = new Uint16Array(SCREEN_HEIGHT_PX);
  const scanlineContrib: Array<Array<SpriteLimitEntityRef>> = Array.from({ length: SCREEN_HEIGHT_PX }, () => []);
  const totalContrib = new Map<string, { ref: SpriteLimitEntityRef; count: number }>();
  let totalSprites = 0;

  // Player contribution
  const playerFacing = resolveDefaultFacing(ctx.objectMetadata);
  const playerProfile = buildFacingProfile(playerFacing);
  if (playerProfile) {
    // Use world pixel position of player for tile placement (consistent regardless of viewport bias)
    const anchorX = playerCell.x * ctx.cellPixelSize;
    const anchorY = playerCell.y * ctx.cellPixelSize;
    const ref: SpriteLimitEntityRef = { kind: "player", cell: { ...playerCell } };
    for (const { dx, dy } of playerProfile.tiles) {
      const tx = anchorX + dx;
      const ty = anchorY + dy;
      if (!rectsIntersect(viewport.x, viewport.y, viewport.width, viewport.height, tx, ty, 8, 8)) {
        continue;
      }
      totalSprites += 1;
      const key = `p|${playerCell.x},${playerCell.y}`;
      const agg = totalContrib.get(key);
      if (agg) agg.count += 1; else totalContrib.set(key, { ref, count: 1 });
      const startY = clampToViewportY(ty - viewport.y);
      const endY = clampToViewportY(ty + 7 - viewport.y);
      for (let y = startY; y <= endY; y += 1) {
        scanlineCounts[y] += 1;
        scanlineContrib[y].push(ref);
      }
    }
  }

  // Player grass effect
  const tallGrassId = ctx.warpMetadata?.collisionConstants?.["COLL_TALL_GRASS"];
  if (Number.isFinite(tallGrassId) && ctx.collision) {
    const cellValue = ctx.collision.getValue(playerCell.x, playerCell.y);
    if (cellValue === tallGrassId) {
      const ref: SpriteLimitEntityRef = { kind: "player", cell: { ...playerCell }, label: "grass-effect" };
      // Two 8x8 tiles relative to player world position: bottom-left and bottom-right of feet
      const tiles = [
        { dx: -8, dy: 8 },
        { dx: 0, dy: 8 },
      ];
      const playerWorldX = playerCell.x * ctx.cellPixelSize;
      const playerWorldY = playerCell.y * ctx.cellPixelSize;
      for (const t of tiles) {
        const tx = playerWorldX + t.dx;
        const ty = playerWorldY + t.dy;
        if (!rectsIntersect(viewport.x, viewport.y, viewport.width, viewport.height, tx, ty, 8, 8)) {
          continue;
        }
        totalSprites += 1;
        const key = `pg|${playerCell.x},${playerCell.y}`;
        const agg = totalContrib.get(key);
        if (agg) agg.count += 1; else totalContrib.set(key, { ref, count: 1 });
        const startY = clampToViewportY(ty - viewport.y);
        const endY = clampToViewportY(ty + 7 - viewport.y);
        for (let y = startY; y <= endY; y += 1) {
          scanlineCounts[y] += 1;
          scanlineContrib[y].push(ref);
        }
      }
    }
  }

  // Weather reservation: applies only to overworld maps, reserves 1 sprite in totals and per-scanline
  const currentMapLabel: string = (ctx as any).currentMapLabel ?? "";
  const isOverworld = Boolean(ctx.warpMetadata?.maps?.[currentMapLabel]?.isOverworld);
  if (ctx.includeWeather && isOverworld) {
    const ref: SpriteLimitEntityRef = { kind: "weather", cell: { ...playerCell }, label: "weather" };
    totalSprites += 1;
    totalContrib.set("w|weather", { ref, count: 1 });
    for (let y = 0; y < SCREEN_HEIGHT_PX; y += 1) {
      scanlineCounts[y] += 1;
      scanlineContrib[y].push(ref);
    }
  }

  // Optional: Follower Pokémon contribution (2x2 sprite adjacent to the player)
  if (ctx.includeFollower && ctx.collision && playerProfile) {
    // Candidate adjacent cells: up, down, left, right
    const candidates: MapCellCoordinate[] = [
      { x: playerCell.x, y: playerCell.y - 1 },
      { x: playerCell.x, y: playerCell.y + 1 },
      { x: playerCell.x - 1, y: playerCell.y },
      { x: playerCell.x + 1, y: playerCell.y },
    ];
    const isCellValid = (c: MapCellCoordinate): boolean => {
      if (c.x < 0 || c.y < 0 || c.x >= ctx.collision!.width || c.y >= ctx.collision!.height) return false;
      // Follower must stand on a walkable cell (assume land movement)
      return ctx.collision!.isPassable(c.x, c.y, "land");
    };

    // Per-scanline maxima across valid follower positions
    const folScanlineMax = new Uint16Array(SCREEN_HEIGHT_PX);
    const folScanlineCell: Array<MapCellCoordinate | null> = Array.from({ length: SCREEN_HEIGHT_PX }, () => null);
    // Totals: best single position
    let folTotalMax = 0;
    let folTotalCell: MapCellCoordinate | null = null;

    for (const cell of candidates) {
      if (!isCellValid(cell)) continue;
      const anchorX = cell.x * ctx.cellPixelSize;
      const anchorY = cell.y * ctx.cellPixelSize;
      // Count visible tiles for totals
      let visibleTiles = 0;
      for (const { dx, dy } of playerProfile.tiles) {
        const tx = anchorX + dx;
        const ty = anchorY + dy;
        if (rectsIntersect(viewport.x, viewport.y, viewport.width, viewport.height, tx, ty, 8, 8)) {
          visibleTiles += 1;
        }
      }
      if (visibleTiles > folTotalMax) {
        folTotalMax = visibleTiles;
        folTotalCell = cell;
      }
      // Per-scanline contribution for this cell
      const cellScan = new Uint16Array(SCREEN_HEIGHT_PX);
      let seenMinY = SCREEN_HEIGHT_PX, seenMaxY = -1;
      for (const { dx, dy } of playerProfile.tiles) {
        const tx = anchorX + dx;
        const ty = anchorY + dy;
        if (!rectsIntersect(viewport.x, viewport.y, viewport.width, viewport.height, tx, ty, 8, 8)) {
          continue;
        }
        const startY = clampToViewportY(ty - viewport.y);
        const endY = clampToViewportY(ty + 7 - viewport.y);
        if (startY < seenMinY) seenMinY = startY;
        if (endY > seenMaxY) seenMaxY = endY;
        for (let y = startY; y <= endY; y += 1) {
          cellScan[y] += 1;
        }
      }
      if (seenMaxY >= seenMinY) {
        for (let y = seenMinY; y <= seenMaxY; y += 1) {
          const c = cellScan[y];
          if (c > folScanlineMax[y]) {
            folScanlineMax[y] = c;
            folScanlineCell[y] = cell;
          }
        }
      }
    }

    // Apply follower totals to global totals
    if (folTotalMax > 0 && folTotalCell) {
      totalSprites += folTotalMax;
      const ref: SpriteLimitEntityRef = { kind: "follower", cell: { ...folTotalCell }, label: "follower" };
      const key = `f|${folTotalCell.x},${folTotalCell.y}`;
      totalContrib.set(key, { ref, count: folTotalMax });
    }
    // Apply follower scanline maxima to global scanlines
    for (let y = 0; y < SCREEN_HEIGHT_PX; y += 1) {
      const c = folScanlineMax[y];
      if (c > 0) {
        scanlineCounts[y] += c;
        const cell = folScanlineCell[y];
        const ref: SpriteLimitEntityRef = { kind: "follower", cell: cell ? { ...cell } : { ...playerCell }, label: "follower" };
        scanlineContrib[y].push(ref);
      }
    }
  }

  // NPCs: per-NPC, choose a single position (at most) contributing to totals/scanlines.
  // For totals, take the position with the maximum visible tiles.
  // For per-scanline, for each scanline Y, take the position with the maximum tiles on that scanline.
  for (const npc of npcs) {
    const profile = npc.profile;
    if (!profile || !Array.isArray(npc.cells) || npc.cells.length === 0) {
      continue;
    }

  // Per-scanline maxima (across positions) and the chosen cell that achieves it
  const npcScanlineMax = new Uint16Array(SCREEN_HEIGHT_PX);
  const npcScanlineCell: Array<MapCellCoordinate | null> = Array.from({ length: SCREEN_HEIGHT_PX }, () => null);

    // Total maximum and chosen cell
    let npcTotalMax = 0;
    let npcTotalCell: MapCellCoordinate | null = null;

  for (const cell of npc.cells) {
      if (cell.x === playerCell.x && cell.y === playerCell.y) {
        continue;
      }
      const anchorX = cell.x * ctx.cellPixelSize;
      const anchorY = cell.y * ctx.cellPixelSize;

      // Count visible tiles for totals (allow 1-cell offscreen preloading)
      let visibleTiles = 0;
      for (const { dx, dy } of profile.tiles) {
        const tx = anchorX + dx;
        const ty = anchorY + dy;
        if (rectsIntersect(totalViewport.x, totalViewport.y, totalViewport.width, totalViewport.height, tx, ty, 8, 8)) {
          visibleTiles += 1;
        }
      }
      if (visibleTiles > npcTotalMax) {
        npcTotalMax = visibleTiles;
        npcTotalCell = cell;
      }

      // Update per-scanline maxima: compute this cell's contribution per scanline,
      // then compare with the current max and take the larger.
      const cellScan = new Uint16Array(SCREEN_HEIGHT_PX);
      let seenMinY = SCREEN_HEIGHT_PX, seenMaxY = -1;
      for (const { dx, dy } of profile.tiles) {
        const tx = anchorX + dx;
        const ty = anchorY + dy;
        if (!rectsIntersect(viewport.x, viewport.y, viewport.width, viewport.height, tx, ty, 8, 8)) {
          continue;
        }
        const startY = clampToViewportY(ty - viewport.y);
        const endY = clampToViewportY(ty + 7 - viewport.y);
        if (startY < seenMinY) seenMinY = startY;
        if (endY > seenMaxY) seenMaxY = endY;
        for (let y = startY; y <= endY; y += 1) {
          cellScan[y] += 1;
        }
      }
      if (seenMaxY >= seenMinY) {
        for (let y = seenMinY; y <= seenMaxY; y += 1) {
          const c = cellScan[y];
          if (c > npcScanlineMax[y]) {
            npcScanlineMax[y] = c;
            npcScanlineCell[y] = cell;
          }
        }
      }
    }

    // Apply per-NPC totals to the global total
    if (npcTotalMax > 0 && npcTotalCell) {
      totalSprites += npcTotalMax;
      const ref: SpriteLimitEntityRef = { kind: "npc", index: npc.entry.index, cell: { ...npcTotalCell }, label: npc.entry.macro };
      const key = `n|${npc.entry.index}|${npcTotalCell.x},${npcTotalCell.y}`;
      totalContrib.set(key, { ref, count: npcTotalMax });
    }

    // Apply per-NPC scanline maxima to the global scanline counts
    for (let y = 0; y < SCREEN_HEIGHT_PX; y += 1) {
      const c = npcScanlineMax[y];
      if (c > 0) {
        scanlineCounts[y] += c;
        const cell = npcScanlineCell[y];
        const ref: SpriteLimitEntityRef = {
          kind: "npc",
          index: npc.entry.index,
          cell: cell ? { ...cell } : npc.cells[0] ? { ...npc.cells[0] } : { x: 0, y: 0 },
          label: npc.entry.macro,
        };
        scanlineContrib[y].push(ref);
      }
    }
  }

  // Evaluate scanline limit issues
  let maxScanline = 0;
  let maxScanlineY = 0;
  for (let y = 0; y < SCREEN_HEIGHT_PX; y += 1) {
    const c = scanlineCounts[y];
    if (c > maxScanline) {
      maxScanline = c;
      maxScanlineY = y;
    }
  }
  if (maxScanline >= ctx.scanlineLimit) {
    const seen = new Set<string>();
    const contributors: SpriteLimitEntityRef[] = [];
    for (const ref of scanlineContrib[maxScanlineY] ?? []) {
      const key = `${ref.kind}|${ref.index ?? -1}|${ref.cell.x},${ref.cell.y}|${ref.label ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        contributors.push(ref);
      }
    }
    issues.push({
      type: "scanline-limit",
      severity: maxScanline > ctx.scanlineLimit ? "exceeds" : "at-limit",
      count: maxScanline,
      limit: ctx.scanlineLimit,
      mapLabel: (ctx as any).currentMapLabel ?? "",
      playerCell: { ...playerCell },
      viewportPx: { ...viewport },
      scanlineY: maxScanlineY,
      contributors,
    });
  }

  // Evaluate total sprite limit
  if (totalSprites >= ctx.totalLimit) {
    const contributors: SpriteLimitEntityRef[] = [];
    const sorted = Array.from(totalContrib.values()).sort((a, b) => b.count - a.count);
    for (const item of sorted) {
      contributors.push(item.ref);
    }
    issues.push({
      type: "total-limit",
      severity: totalSprites > ctx.totalLimit ? "exceeds" : "at-limit",
      count: totalSprites,
      limit: ctx.totalLimit,
      mapLabel: (ctx as any).currentMapLabel ?? "",
      playerCell: { ...playerCell },
      viewportPx: { ...viewport },
      contributors,
    });
  }

  return issues;
}

export interface AnalyzeOptions {
  timeOfDay: string;
  // If provided, restrict to this set of player cells; otherwise scan all passable cells
  restrictPlayerCells?: MapCellCoordinate[];
  // Early exit after finding first issue of each type for faster scans
  stopAtFirst?: boolean;
  // Optional custom limits; defaults are Game Boy hardware limits (10 per scanline, 40 total)
  scanlineLimit?: number;
  totalLimit?: number;
  // Whether to consider a follower Pokémon adjacent to the player
  includeFollower?: boolean;
  // Whether to reserve sprite capacity for weather (overworld only)
  includeWeather?: boolean;
}

export function analyzeMapSpriteLimits(
  map: MapObjectMetadataEntry,
  objectMetadata: ObjectMetadata,
  warp: WarpMetadata | null,
  options: AnalyzeOptions,
): SpriteLimitIssue[] {
  const issues: SpriteLimitIssue[] = [];
  const collision = createCollisionHelper(warp?.maps?.[map.label]?.collision ?? null, warp?.collisionPermissions ?? null);
  const cellPixelSize = Math.max(1, Math.trunc(warp?.cellPixelSize ?? 16));
  const ctx: AnalysisContext = {
    objectMetadata,
    warpMetadata: warp,
    cellPixelSize,
    collision,
    timeOfDay: options.timeOfDay,
    scanlineLimit: Math.max(0, Math.trunc(options.scanlineLimit ?? SCANLINE_SPRITE_LIMIT)),
    totalLimit: Math.max(0, Math.trunc(options.totalLimit ?? TOTAL_SPRITE_LIMIT)),
    includeFollower: Boolean(options.includeFollower),
    includeWeather: Boolean(options.includeWeather),
  };
  // attach current map label for downstream inclusion
  (ctx as any).currentMapLabel = map.label;

  // Prepare NPC movement summaries and facing profiles
  const npcEntries = (map.objects ?? []).filter((obj) => isObjectVisibleAtTime(obj, options.timeOfDay));
  const npcRecords: Array<{ entry: ObjectEventEntry; cells: MapCellCoordinate[]; profile: FacingProfile | null }> = [];
  for (const entry of npcEntries) {
    const model = getMovementModel(entry.movement?.constant ?? null);
    let summary: MovementSummary | null = null;
    try {
      summary = simulateNpcMovement({ object: entry, model, collisionHelper: collision });
    } catch {
      summary = null;
    }
    const cells = enumerateObjectCells(summary);
    const facing = getObjectFacingForAnalysis(entry, objectMetadata);
    const profile = buildFacingProfile(facing);
    npcRecords.push({ entry, cells, profile });
  }

  // Enumerate player cells
  const playerCells: MapCellCoordinate[] = [];
  if (Array.isArray(options.restrictPlayerCells) && options.restrictPlayerCells.length > 0) {
    for (const c of options.restrictPlayerCells) {
      playerCells.push({ x: Math.trunc(c.x), y: Math.trunc(c.y) });
    }
  } else if (collision) {
    for (let y = 0; y < collision.height; y += 1) {
      for (let x = 0; x < collision.width; x += 1) {
        // Consider either land or water passable as valid positions (player can surf)
        if (collision.isPassable(x, y, "land") || collision.isPassable(x, y, "water")) {
          playerCells.push({ x, y });
        }
      }
    }
  }

  // Scan each player cell
  let foundScanline = false;
  let foundTotal = false;
  for (const playerCell of playerCells) {
    const batch = analyzeForPlayerCell(playerCell, npcRecords, ctx);
    for (const issue of batch) {
      if (issue.type === "scanline-limit") {
        foundScanline = true;
      } else if (issue.type === "total-limit") {
        foundTotal = true;
      }
      issues.push(issue);
    }
    if (options.stopAtFirst && foundScanline && foundTotal) {
      break;
    }
  }

  return issues;
}

// Analyze all overworld maps by iterating through object metadata maps and filtering to those
// marked as overworld in the warp metadata. Aggregates issues across maps, preserving mapLabel.
export function analyzeOverworldSpriteLimits(
  objectMetadata: ObjectMetadata,
  warp: WarpMetadata | null,
  options: AnalyzeOptions,
): SpriteLimitIssue[] {
  const results: SpriteLimitIssue[] = [];
  if (!warp) return results;
  const maps = objectMetadata.maps ?? {};
  for (const [label, map] of Object.entries(maps)) {
    const meta = warp.maps?.[label];
    if (!meta || meta.isOverworld !== true) continue;
    const issues = analyzeMapSpriteLimits(map, objectMetadata, warp, options);
    // Ensure mapLabel is set
    for (const issue of issues) {
      if (!issue.mapLabel) {
        (issue as any).mapLabel = label;
      }
      results.push(issue);
    }
  }
  return results;
}

export type MapScope = "all" | "overworld" | "indoor";

export interface AnalyzeAllOptions extends AnalyzeOptions {
  scope?: MapScope;
}

// Analyze maps across the workspace with configurable scope (all/overworld/indoor)
export function analyzeAllSpriteLimits(
  objectMetadata: ObjectMetadata,
  warp: WarpMetadata | null,
  options: AnalyzeAllOptions,
): SpriteLimitIssue[] {
  const results: SpriteLimitIssue[] = [];
  if (!warp) return results;
  const maps = objectMetadata.maps ?? {};
  const scope: MapScope = options.scope ?? "all";
  for (const [label, map] of Object.entries(maps)) {
    const meta = warp.maps?.[label];
    const isOverworld = Boolean(meta?.isOverworld);
    if (scope === "overworld" && !isOverworld) continue;
    if (scope === "indoor" && isOverworld) continue;
    const issues = analyzeMapSpriteLimits(map, objectMetadata, warp, options);
    for (const issue of issues) {
      if (!issue.mapLabel) {
        (issue as any).mapLabel = label;
      }
      results.push(issue);
    }
  }
  return results;
}
