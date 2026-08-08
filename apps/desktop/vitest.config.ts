import { defineConfig } from "vitest/config";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";

export default defineConfig({ root: resolve(__dirname), plugins: [react()], test: { environment: "jsdom", setupFiles: [resolve(__dirname, "tests/setup.ts")], include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"] } });
