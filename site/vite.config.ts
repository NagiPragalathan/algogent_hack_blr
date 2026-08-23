import path from "node:path";
// import.meta.dirname rather than __dirname: Vite native config loader warns
// on the CommonJS global, and this file is ESM.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
});
