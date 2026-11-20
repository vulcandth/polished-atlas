import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import fs from "node:fs/promises";

const UPDATE_ENDPOINT = "/__atlas/update-neighborhoods";

function snapToHalf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round(value * 2) / 2;
}

async function readRequestBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("Payload too large"));
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", (err) => reject(err));
  });
}

function atlasDevToolsPlugin(repoRoot: string): Plugin {
  const generated = path.resolve(repoRoot, ".build/generated/dev/maps");
  const positions = path.resolve(repoRoot, "scripts/island_positions.json");
  return {
    name: "atlas-dev-tools",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith(UPDATE_ENDPOINT)) {
          next();
          return;
        }
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.setHeader("Content-Type", "text/plain");
          res.end("Method Not Allowed");
          return;
        }
        try {
          const rawBody = await readRequestBody(req);
          const payload = JSON.parse(rawBody) as {
            neighborhoods?: Array<{
              id: string;
              offset_blocks?: [number, number] | null;
              z_offset?: number | null;
            }>;
          };
          if (!payload.neighborhoods || !Array.isArray(payload.neighborhoods)) {
            throw new Error("Invalid payload: neighborhoods array missing");
          }

          const clocks = await fs.readdir(generated);
          const manifests = await Promise.all(clocks.filter((clock) => ["day", "eve", "morn", "nite"].includes(clock))
            .map(async (clock) => {
              const file = path.join(generated, clock, "animated/map_neighborhoods.json");
              const data = JSON.parse(await fs.readFile(file, "utf8")) as {
                neighborhoods: { id: string; map_labels: string[]; offset_blocks: number[]; z_offset: number }[];
              };
              return { file, data };
            }));
          const day = manifests.find(({ file }) => file === path.join(generated, "day/animated/map_neighborhoods.json"));
          if (!day) throw new Error("Generate the dev atlas before editing island positions.");
          const detached = day.data.neighborhoods.filter((n) => !n.map_labels.includes("NewBarkTown"));
          const updates = new Map(payload.neighborhoods.map((entry) => [entry.id, entry]));
          if (updates.size !== detached.length || detached.some((n) => !updates.has(n.id))) {
            throw new Error("Detached groups have changed. Reload the atlas.");
          }
          const neighborhoods = detached.map(({ id }) => {
            const update = updates.get(id)!;
            const xy = update.offset_blocks;
            if (!Array.isArray(xy) || xy.length !== 2 || !xy.every(Number.isFinite)
                || typeof update.z_offset !== "number" || !Number.isFinite(update.z_offset)) {
              throw new Error("Each island requires finite coordinates and draw order.");
            }
            return { id, offset_blocks: xy.map(snapToHalf), z_offset: Math.trunc(update.z_offset) };
          }).sort((a, b) => a.id.localeCompare(b.id));
          const byId = new Map(neighborhoods.map((n) => [n.id, n]));
          // The canonical file is also read by every clean build. A concurrent
          // reader should see either the old positions or the complete new set.
          const temporary = positions + "." + crypto.randomUUID() + ".tmp";
          await fs.writeFile(temporary, JSON.stringify({ neighborhoods }, null, 2) + "\n");
          await fs.rename(temporary, positions);
          for (const { file, data } of manifests) {
            for (const group of data.neighborhoods) Object.assign(group, byId.get(group.id));
            const temp = file + "." + crypto.randomUUID() + ".tmp";
            await fs.writeFile(temp, JSON.stringify(data, null, 2) + "\n");
            await fs.rename(temp, file);
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: true, updated: neighborhoods.length }));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ ok: false, error: message }));
        }
      });
    },
  };
}

function normaliseBasePath(value: string | undefined): string {
  if (!value) {
    return "/";
  }
  let candidate = value.trim();
  if (candidate.length === 0) {
    return "/";
  }
  if (!candidate.startsWith("/")) {
    candidate = `/${candidate}`;
  }
  if (!candidate.endsWith("/")) {
    candidate = `${candidate}/`;
  }
  return candidate;
}

const repoRoot = path.resolve(__dirname, "../..");
const publicBase = normaliseBasePath(process.env.VITE_PUBLIC_BASE);

export default defineConfig({
  base: publicBase,
  plugins: [react(), atlasDevToolsPlugin(repoRoot)],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    __REPO_ROOT__: JSON.stringify(path.resolve(repoRoot, ".build/generated/dev")),
    __PUBLIC_BASE__: JSON.stringify(publicBase),
  },
  server: {
    port: 5173,
    fs: {
      allow: ["..", repoRoot],
    },
  },
  preview: {
    port: 4173,
  },
  build: {
    sourcemap: true,
    outDir: "dist",
    emptyOutDir: true,
  },
});
