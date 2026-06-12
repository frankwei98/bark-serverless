import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./worker/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["worker/test/**/*.test.ts"],
  },
});
