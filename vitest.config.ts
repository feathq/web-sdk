import { defineConfig } from "vitest/config";

// happy-dom gives us localStorage, BroadcastChannel, document.visibilityState,
// crypto.subtle without a full browser. Faster than jsdom for our needs.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "happy-dom",
  },
});
