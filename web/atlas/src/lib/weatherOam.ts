// Whole maps are viewed as adjacent Game Boy screens. A tile straddling
// two screens competes independently for the visible pixels on each side.
export type OamPoint = { x: number; y: number };
export type OamRect = OamPoint & { width: number; height: number };
export type OamGroup = { tiles: OamPoint[]; weatherSlot?: number };

/** Groups and their tiles arrive in reverse OAM order (objects before weather).
 * Return visible rectangles only for groups that lost at least one tile.
 */
export function weatherOamClips(groups: OamGroup[], mapWidth: number, mapHeight: number): Map<number, OamRect[]> {
  const screens = new Map<number, { slots: number; lines: Uint8Array }>();
  const columns = Math.ceil(mapWidth / 160);
  const clips = new Map<number, OamRect[]>();
  for (const [index, group] of groups.entries()) {
    const slices = new Map<number, OamRect[]>();
    for (const { x, y } of group.tiles) {
      const right = Math.min(x + 8, mapWidth);
      const bottom = Math.min(y + 8, mapHeight);
      for (let top = Math.max(0, y); top < bottom;) {
        const row = Math.floor(top / 144);
        const endY = Math.min(bottom, (row + 1) * 144);
        for (let left = Math.max(0, x); left < right;) {
          const col = Math.floor(left / 160);
          const endX = Math.min(right, (col + 1) * 160);
          const key = row * columns + col;
          const rect = { x: left, y: top, width: endX - left, height: endY - top };
          const parts = slices.get(key);
          if (parts) parts.push(rect);
          else slices.set(key, [rect]);
          left = endX;
        }
        top = endY;
      }
    }
    const visible: OamRect[] = [];
    let rejected = false;
    for (const [key, parts] of slices) {
      let screen = screens.get(key);
      if (!screen) {
        screen = { slots: 0, lines: new Uint8Array(144) };
        screens.set(key, screen);
      }
      // Map objects allocate their whole facing in OAM before scanline culling.
      const available = 40 - screen.slots;
      if (group.weatherSlot !== undefined ? group.weatherSlot >= available : group.tiles.length > available) {
        rejected = true;
        continue;
      }
      if (group.weatherSlot === undefined) screen.slots += group.tiles.length;
      for (const rect of parts) {
        const top = rect.y % 144;
        const end = top + rect.height;
        let line = top;
        while (line < end && screen.lines[line] < 10) line++;
        if (line < end) {
          rejected = true;
          continue;
        }
        for (line = top; line < end; line++) screen.lines[line]++;
        visible.push(rect);
      }
    }
    if (rejected) clips.set(index, visible);
  }
  return clips;
}
