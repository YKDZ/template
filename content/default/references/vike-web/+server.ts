import type { Server } from "vike/types";

import { createApp } from "#/server/app";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const app = createApp();

export default {
  fetch: app.fetch,
  prod: {
    port,
  },
} satisfies Server;
