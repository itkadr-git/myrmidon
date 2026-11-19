import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { createUiDevWatchOptions } from "./src/lib/vite-watch.ts";
import { createApiProxy } from "./src/lib/vite-api-proxy.ts";
import { serviceWorkerBuildIdPlugin } from "./src/lib/vite-sw-build-id.ts";

const apiProxy = createApiProxy();
const configDirname =
  import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), serviceWorkerBuildIdPlugin()],
  build: {
    minify: "esbuild",
  },
  esbuild:
    mode === "production"
      ? {
          drop: ["console", "debugger"],
          legalComments: "none",
        }
      : undefined,
  resolve: {
    alias: {
      "@": path.resolve(configDirname, "./src"),
      lexical: path.resolve(configDirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  server: {
    port: 5173,
    watch: createUiDevWatchOptions(process.cwd()),
    proxy: apiProxy,
  },
  preview: {
    port: 3101,
    host: "0.0.0.0",
    allowedHosts: true,
    proxy: apiProxy,
  },
}));
