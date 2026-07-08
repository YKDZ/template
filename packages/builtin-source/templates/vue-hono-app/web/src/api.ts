const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? "/";

export async function getHealth(): Promise<{ status: "ok" }> {
  const response = await fetch(`${apiBaseUrl.replace(/\/$/, "")}/api/health`);

  if (!response.ok) {
    throw new Error(`Health check failed with ${response.status}`);
  }

  return (await response.json()) as { status: "ok" };
}
