// @template-anchor api-type-import-start
import type { AppType } from "__API_PACKAGE__";
import { hc } from "hono/client";
// @template-anchor api-type-import-end

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/";

export const api = hc<AppType>(apiBaseUrl);
