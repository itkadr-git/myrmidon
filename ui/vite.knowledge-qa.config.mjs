import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stub = (name) => path.resolve(__dirname, "src/knowledge-qa", name);

// Dev server for tests/knowledge-screen: the real screens with the two
// context providers replaced by fixed stubs (no backend, no auth).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^(?:.*\/)?context\/CompanyContext$/, replacement: stub("company-context.tsx") },
      { find: /^(?:.*\/)?context\/BreadcrumbContext$/, replacement: stub("breadcrumb-context.tsx") },
      { find: "@", replacement: path.resolve(__dirname, "./src") },
      { find: "lexical", replacement: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs") },
    ],
  },
  server: { host: "127.0.0.1", port: 5188, strictPort: true },
});
