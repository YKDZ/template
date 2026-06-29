import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  use: {
    baseURL: "http://localhost:4173",
    ...devices["Desktop Chrome"]
  },
  webServer: [
    {
      command: "pnpm --dir ../api run build && PORT=8787 pnpm --dir ../api run start",
      port: 8787,
      reuseExistingServer: false
    },
    {
      command: "VITE_API_BASE_URL=http://localhost:8787 pnpm run preview -- --host 127.0.0.1",
      port: 4173,
      reuseExistingServer: false
    }
  ]
});
