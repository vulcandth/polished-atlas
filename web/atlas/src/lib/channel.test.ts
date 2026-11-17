import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("atlas channels", () => {
  it("retains stable saved settings and links to the dev subdirectory", async () => {
    vi.stubEnv("VITE_ATLAS_CHANNEL", "stable");
    const channel = await import("./channel");
    expect(channel.channelStorageKey("polished-atlas:view-state")).toBe("polished-atlas:view-state");
    expect(channel.otherChannelHref("/polished-atlas/", "stable")).toBe("/polished-atlas/dev/");
  });
  it("isolates dev settings and links back to the stable root", async () => {
    vi.stubEnv("VITE_ATLAS_CHANNEL", "dev");
    const channel = await import("./channel");
    expect(channel.channelStorageKey("polished-atlas:view-state")).toBe("dev:polished-atlas:view-state");
    expect(channel.otherChannelHref("/polished-atlas/dev/", "dev")).toBe("/polished-atlas/");
  });
});
