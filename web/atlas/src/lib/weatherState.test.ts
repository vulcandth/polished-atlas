import { describe, expect, it } from "vitest";
import { cherrySpawnPoint, weatherType } from "./weatherState";

const sequence = (...values: number[]) => () => {
  const value = values.shift();
  if (value === undefined) throw new Error("Unexpected random draw");
  return value;
};

describe("generated weather policy", () => {
  it("recognizes blossoms and leaves missing or unknown weather off", () => {
    for (const value of [undefined, null, "", "cloudy", {}]) expect(weatherType(value)).toBe("none");
    for (const value of ["rain", "thunderstorm", "snow", "sandstorm", "cherry_blossoms"]) {
      expect(weatherType(value)).toBe(value);
    }
  });
  it("makes a single ten-percent blossom spawn attempt", () => {
    expect(cherrySpawnPoint(160, 144, [{ x: 8, y: 8 }], sequence(0.1))).toBeNull();
  });
  it("chooses a leaf collision cell without inventing candidates", () => {
    const leaves = [{ x: 24, y: 40 }, { x: 88, y: 56 }];
    expect(cherrySpawnPoint(160, 144, leaves, sequence(0.09, 0.3, 0.75))).toEqual(leaves[1]);
    expect(cherrySpawnPoint(160, 144, [], sequence(0, 0.9))).toBeNull();
  });
  it("spawns edge petals from the top or right", () => {
    expect(cherrySpawnPoint(160, 144, [], sequence(0, 0.29, 0.24, 0.5))).toEqual({ x: 168, y: 76 });
    expect(cherrySpawnPoint(160, 144, [], sequence(0, 0, 0.25, 0))).toEqual({ x: 8, y: 0 });
  });
});
