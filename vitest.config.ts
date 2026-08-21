import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees/ inside this directory, and
    // each contains a full copy of src/. Without this, a local `npm test` picks
    // up another branch's tests as if they were this checkout's.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.claude/**"],
  },
});
