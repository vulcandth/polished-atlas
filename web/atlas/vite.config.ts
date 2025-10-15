import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  define: {
    __REPO_ROOT__: JSON.stringify(repoRoot),
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
