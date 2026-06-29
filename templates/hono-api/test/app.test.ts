import { app } from "@/app.js";

describe("Hono API", () => {
  it("responds to the health route", async () => {
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
