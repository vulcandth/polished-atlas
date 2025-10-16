import type {
  MapCellCoordinate,
  MovementAxes,
  MovementBounds,
  MovementMedium,
  MovementModel,
  MovementSummary,
  ObjectEventEntry,
} from "@/types";
import type { CollisionHelper } from "@/lib/collision";

export interface SimulateNpcMovementOptions {
  object: ObjectEventEntry;
  model: MovementModel;
  collisionHelper: CollisionHelper | null;
}

const AXIS_DIRECTIONS: Record<Exclude<MovementAxes, "xy">, { positive: string; negative: string }> = {
  x: { positive: "east", negative: "west" },
  y: { positive: "south", negative: "north" },
};

const CARDINAL_STEPS: Array<{ dx: number; dy: number }> = [
  { dx: 1, dy: 0 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: 0, dy: -1 },
];

function toInt(value: number | null | undefined): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.trunc(value as number);
}

function resolveStartCell(object: ObjectEventEntry): MapCellCoordinate {
  const x = Number.isFinite(object.xTiles) ? Math.trunc(object.xTiles) : Math.trunc((object.xPixels ?? 0) / 16);
  const y = Number.isFinite(object.yTiles) ? Math.trunc(object.yTiles) : Math.trunc((object.yPixels ?? 0) / 16);
  return { x, y };
}

function cloneMapCell(cell: MapCellCoordinate): MapCellCoordinate {
  return { x: cell.x, y: cell.y };
}

function ensurePassable(
  helper: CollisionHelper | null,
  cell: MapCellCoordinate,
  medium: MovementMedium
): { passable: boolean; reason?: string } {
  if (!helper) {
    return { passable: true };
  }
  const passable = helper.isPassable(cell.x, cell.y, medium);
  if (passable) {
    return { passable: true };
  }
  return { passable: false, reason: "blocked" };
}

function describeNotes(notes: string[]): string | null {
  if (notes.length === 0) {
    return null;
  }
  return notes.join(" ");
}

function simulateAxisWalk(
  options: SimulateNpcMovementOptions,
  start: MapCellCoordinate,
  medium: MovementMedium
): MovementSummary {
  const { object, model, collisionHelper } = options;
  const axis: Exclude<MovementAxes, "xy"> = model.axes === "y" ? "y" : "x";
  const range = axis === "x" ? Math.max(0, toInt(object.range?.x)) : Math.max(0, toInt(object.range?.y));
  const directions = AXIS_DIRECTIONS[axis];
  const deltaPositive = axis === "x" ? { dx: 1, dy: 0 } : { dx: 0, dy: 1 };
  const deltaNegative = axis === "x" ? { dx: -1, dy: 0 } : { dx: 0, dy: -1 };
  const positiveCells: MapCellCoordinate[] = [];
  const negativeCells: MapCellCoordinate[] = [];
  const blockedNotes: string[] = [];
  const notes: string[] = [];

  if (!collisionHelper) {
    notes.push("Collision data unavailable; assuming full range is traversable.");
  }

  const walkDirection = (
    delta: { dx: number; dy: number },
    maxRange: number,
    collector: MapCellCoordinate[],
    label: string
  ): void => {
    for (let step = 1; step <= maxRange; step += 1) {
      const cell = {
        x: start.x + delta.dx * step,
        y: start.y + delta.dy * step,
      };
      const { passable } = ensurePassable(collisionHelper, cell, medium);
      if (!passable) {
        const reached = step - 1;
        blockedNotes.push(
          reached > 0
            ? `Blocked ${label} after ${reached} step${reached === 1 ? "" : "s"}.`
            : `Blocked immediately when attempting to move ${label}.`
        );
        break;
      }
      collector.push(cell);
    }
  };

  walkDirection(deltaNegative, range, negativeCells, directions.negative);
  walkDirection(deltaPositive, range, positiveCells, directions.positive);

  const path: MapCellCoordinate[] = [
    ...negativeCells.slice().reverse().map(cloneMapCell),
    cloneMapCell(start),
    ...positiveCells.map(cloneMapCell),
  ];

  let description = "Walks ";
  description += axis === "x" ? "left and right" : "up and down";
  if (range === 0) {
    description += " (range 0).";
  } else {
    description += ` (${negativeCells.length} ${directions.negative}, ${positiveCells.length} ${directions.positive}).`;
  }
  const notesSummary = describeNotes(blockedNotes);
  if (notesSummary) {
    description += ` ${notesSummary}`;
  }

  const summary: MovementSummary = {
    model,
    startCell: cloneMapCell(start),
    medium,
    axis,
    path,
    description,
    blockedNotes,
    notes,
  };
  if (notes.length > 0) {
    summary.notes = notes;
  }
  return summary;
}

function buildBounds(start: MapCellCoordinate, rangeX: number, rangeY: number): MovementBounds {
  return {
    left: start.x - rangeX,
    right: start.x + rangeX,
    top: start.y - rangeY,
    bottom: start.y + rangeY,
  };
}

function boundsContains(bounds: MovementBounds, cell: MapCellCoordinate): boolean {
  return (
    cell.x >= bounds.left &&
    cell.x <= bounds.right &&
    cell.y >= bounds.top &&
    cell.y <= bounds.bottom
  );
}

function simulateRandomWalk(
  options: SimulateNpcMovementOptions,
  start: MapCellCoordinate,
  medium: MovementMedium
): MovementSummary {
  const { object, model, collisionHelper } = options;
  const rangeX = Math.max(0, toInt(object.range?.x));
  const rangeY = Math.max(0, toInt(object.range?.y));
  const bounds = buildBounds(start, rangeX, rangeY);
  const width = bounds.right - bounds.left + 1;
  const height = bounds.bottom - bounds.top + 1;
  const totalCells = Math.max(1, width * height);
  const reachable: MapCellCoordinate[] = [];
  const visited = new Set<string>();
  const queue: MapCellCoordinate[] = [];
  const notes: string[] = [];

  const addToQueue = (cell: MapCellCoordinate): void => {
    const key = `${cell.x},${cell.y}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);
    queue.push(cell);
  };

  const startPassable = ensurePassable(collisionHelper, start, medium);
  if (!startPassable.passable) {
    notes.push("Start position is blocked by terrain for this medium.");
  } else {
    addToQueue(cloneMapCell(start));
  }

  while (queue.length > 0) {
    const cell = queue.shift()!;
    reachable.push(cloneMapCell(cell));
    for (const { dx, dy } of CARDINAL_STEPS) {
      const next: MapCellCoordinate = { x: cell.x + dx, y: cell.y + dy };
      if (!boundsContains(bounds, next)) {
        continue;
      }
      const { passable } = ensurePassable(collisionHelper, next, medium);
      if (!passable) {
        continue;
      }
      addToQueue(next);
    }
  }

  reachable.sort((a, b) => (a.y - b.y) || (a.x - b.x));

  const reachableCount = reachable.length > 0 ? reachable.length : startPassable.passable ? 1 : 0;
  const blockedCells = Math.max(0, totalCells - reachableCount);

  let description = `Wanders within a ${width}×${height} area.`;
  if (collisionHelper) {
    description += ` ${reachableCount} cell${reachableCount === 1 ? "" : "s"} reachable`;
    if (blockedCells > 0) {
      description += `; ${blockedCells} blocked by terrain.`;
    } else {
      description += ".";
    }
  } else {
    description += " Collision data unavailable; assuming full area is reachable.";
  }

  const summary: MovementSummary = {
    model,
    startCell: cloneMapCell(start),
    medium,
    bounds,
    reachable: reachable.length > 0 ? reachable : undefined,
    description,
  };
  if (notes.length > 0) {
    summary.notes = notes;
  }
  return summary;
}

function fallbackSummary(options: SimulateNpcMovementOptions, start: MapCellCoordinate, medium: MovementMedium): MovementSummary {
  const { model } = options;
  const notes: string[] = [];
  let description: string;
  switch (model.category) {
    case "static":
      if (model.facing) {
        description = `Stands still facing ${model.facing}.`;
      } else {
        description = "Stands still.";
      }
      break;
    case "spin":
      description = `Spins ${model.spinDirection ?? "in place"}.`;
      break;
    case "scripted":
      description = "Movement driven by scripted events.";
      break;
    case "follow":
      description = model.followExact
        ? "Follows its leader exactly."
        : "Follows its leader loosely.";
      break;
    case "player":
      description = "Controlled by the player.";
      break;
    case "object":
      description = "Stationary interactive object.";
      break;
    case "effect":
      description = "Visual or ambient effect without movement.";
      break;
    default:
      description = "Special-case movement.";
      break;
  }
  if (model.note) {
    notes.push(model.note);
  }
  const summary: MovementSummary = {
    model,
    startCell: cloneMapCell(start),
    medium,
    description,
  };
  if (notes.length > 0) {
    summary.notes = notes;
  }
  return summary;
}

export function simulateNpcMovement(options: SimulateNpcMovementOptions): MovementSummary {
  const medium: MovementMedium = options.model.medium ?? "land";
  const start = resolveStartCell(options.object);
  switch (options.model.category) {
    case "axis-walk":
      return simulateAxisWalk(options, start, medium);
    case "random-walk":
      return simulateRandomWalk(options, start, medium);
    default:
      return fallbackSummary(options, start, medium);
  }
}
