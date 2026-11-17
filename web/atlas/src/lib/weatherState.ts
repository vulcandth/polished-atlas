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
  if (random() >= 0.1) return null;
  if (random() < 0.3) {
    return random() < 0.25
      ? { x: width + 8, y: Math.floor(random() * (height + 8)) }
      : { x: Math.floor(random() * (width + 7)) + 8, y: 0 };
  }
  return leaves.length ? leaves[Math.floor(random() * leaves.length)] : null;
}
