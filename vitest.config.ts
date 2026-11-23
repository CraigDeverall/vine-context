import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// Tests never touch the real data folder, even where a test forgets to pass one.
const VINE_DATA_DIR = mkdtempSync(join(tmpdir(), "vine-test-data-"));

// Tests use the built-in hash embedder whatever the shell's VINE_EMBEDDER says:
// a checkout or worktree without `npm run build:embedder` can't load a model.
// The real-model tests in test/embed.test.ts are chosen by VINE_TEST_EMBEDDER.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000, globalSetup: ["test/global-setup.ts"], env: { VINE_NO_OPEN: "1", VINE_AUTO_SHARE: "off", VINE_DATA_DIR, VINE_EMBEDDER: "hash" } },
});
