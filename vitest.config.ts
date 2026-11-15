import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: ["test/global-setup.ts"], env: { P2PCG_NO_OPEN: "1", P2PCG_AUTO_SHARE: "off" } },
});
