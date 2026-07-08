import type { Server } from "vike/types";

import { app } from "#/server/app";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);

export default {
  fetch: app.fetch,
  prod: {
    port,
  },
} satisfies Server;
