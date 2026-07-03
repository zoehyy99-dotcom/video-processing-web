import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const browserProcessingHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    headers: browserProcessingHeaders,
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  preview: {
    headers: browserProcessingHeaders,
  },
  plugins: [react()],
});
