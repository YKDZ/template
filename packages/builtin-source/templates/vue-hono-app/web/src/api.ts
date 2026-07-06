// @template-anchor api-type-imports

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/";

export const api = hc<AppType>(apiBaseUrl);
