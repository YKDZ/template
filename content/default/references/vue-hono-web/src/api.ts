export async function getHealth(): Promise<{ status: "ok" }> {
  const response = await fetch("/api/health");

  if (!response.ok) {
    throw new Error(`Health check failed with ${response.status}`);
  }

  return (await response.json()) as { status: "ok" };
}
