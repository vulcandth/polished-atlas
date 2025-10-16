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
  const manifestPath = path.resolve(repoRoot, "maps/day/animated/map_neighborhoods.json");
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

          const sourceRaw = await fs.readFile(manifestPath, "utf8");
          type NeighborhoodRecord = {
            id?: unknown;
            offset_blocks?: unknown;
            z_offset?: unknown;
            [key: string]: unknown;
          };

          const manifest = JSON.parse(sourceRaw) as {
            generated_at?: string;
            neighborhoods?: NeighborhoodRecord[];
          };
          if (!manifest.neighborhoods || !Array.isArray(manifest.neighborhoods)) {
            throw new Error("Manifest missing neighborhoods array");
          }

          const updates = new Map(
            payload.neighborhoods.map((entry) => [entry.id, entry] as const)
          );

          let updatedCount = 0;
          for (const neighborhood of manifest.neighborhoods) {
            const id = typeof neighborhood.id === "string" ? neighborhood.id : undefined;
            if (!id) {
              continue;
            }
            const update = updates.get(id);
            if (!update) {
              continue;
            }
            if (Array.isArray(update.offset_blocks) && update.offset_blocks.length === 2) {
              const nextOffsets: [number, number] = [
                snapToHalf(update.offset_blocks[0]),
                snapToHalf(update.offset_blocks[1]),
              ];
              neighborhood.offset_blocks = nextOffsets;
            } else if (update.offset_blocks === null) {
              neighborhood.offset_blocks = null;
            }
            if (typeof update.z_offset === "number") {
              neighborhood.z_offset = Number.isFinite(update.z_offset)
                ? Math.trunc(update.z_offset)
                : 0;
            } else if (update.z_offset === null) {
              neighborhood.z_offset = null;
            }
            updatedCount += 1;
          }

          manifest.generated_at = new Date().toISOString();

          await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ ok: true, updated: updatedCount, generated_at: manifest.generated_at })
          );
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
    __REPO_ROOT__: JSON.stringify(repoRoot),
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
