export type WeatherType = "none" | "rain" | "thunderstorm" | "snow" | "sandstorm" | "cherry_blossoms";

export function weatherType(value: unknown): WeatherType {
  return value === "rain" || value === "thunderstorm" || value === "snow" ||
    value === "sandstorm" || value === "cherry_blossoms" ? value : "none";
}

export type WeatherPoint = { x: number; y: number };

// SpawnCherryBlossom: one 10% attempt, then 30% from an edge; otherwise
// choose a cherry-leaf collision cell. Random particle motion is independent
// of the deliberately nonrandom map-weather selection policy.
export function cherrySpawnPoint(
  width: number, height: number, leaves: readonly WeatherPoint[], random = Math.random,
): WeatherPoint | null {
  // The percent macro truncates against $ff before comparing a random byte.
  if (random() >= 25 / 256) return null;
  if (random() < 76 / 256) {
    // OAM positions are offset by (8, 16). Pixi anchors the 8px petal at its center.
    return random() < 0.25
      ? { x: width + 4, y: Math.floor(random() * (height + 16)) - 12 }
      : { x: Math.floor(random() * (width + 7)) + 4, y: -12 };
  }
  return leaves.length ? leaves[Math.floor(random() * leaves.length)] : null;
}
