import { app } from "../src/runtime.ts";

describe("Hono API", () => {
  it("responds to the health route", async () => {
    const response = await app.request("/api/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
