#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function main() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const appDir = path.resolve(scriptDir, ".."); // web/atlas
  const repoRoot = path.resolve(scriptDir, "..", "..", ".."); // repo root
  const srcDir = path.resolve(repoRoot, "external/polishedcrystal/gfx/overworld");
  const destDir = path.resolve(appDir, "public/assets/weather");
  const files = ["rain_splash.png", "snow.png", "sand.png"];
  try {
    await fs.mkdir(destDir, { recursive: true });
  } catch {}
  const copyOps = files.map(async (name) => {
    const src = path.join(srcDir, name);
    const dst = path.join(destDir, name);
    try {
      await fs.copyFile(src, dst);
      // console.log(`Copied ${name}`);
    } catch (err) {
      // Be quiet in CI; surface a helpful hint if missing at runtime
      // but still throw here so developers notice during dev/build
      throw new Error(
        `Failed to copy ${name} from ${src} to ${dst}. Make sure the repo root has external/polishedcrystal checked out.\n${err?.message || err}`,
      );
    }
  });
  await Promise.all(copyOps);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
