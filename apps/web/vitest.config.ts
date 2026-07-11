import { defineConfig } from "vitest/config";

/**
 * Config de tests de @phygitalia/web. Entorno node (probamos route handlers y
 * librerías de servidor, sin DOM). Los tests viven junto al código en __tests__/.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    globals: false,
  },
});
