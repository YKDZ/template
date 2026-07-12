import { spawn } from "node:child_process";
import { createServer } from "node:net";

async function listenOnAvailablePort(): Promise<{
  readonly port: string;
  readonly server: ReturnType<typeof createServer>;
}> {
  return await new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (typeof address !== "object" || address === null) {
        server.close(() => {
          reject(new Error("Could not allocate a Playwright server port"));
        });
        return;
      }

      resolve({ port: String(address.port), server });
    });
  });
}

async function availablePorts(count: number): Promise<string[]> {
  const leases: Array<{
    readonly port: string;
    readonly server: ReturnType<typeof createServer>;
  }> = [];

  try {
    for (let index = 0; index < count; index += 1) {
      leases.push(await listenOnAvailablePort());
    }

    return leases.map((lease) => lease.port);
  } finally {
    await Promise.all(
      leases.map(
        (lease) =>
          new Promise<void>((resolve, reject) => {
            lease.server.close((error) => {
              if (error) {
                reject(error);
                return;
              }

              resolve();
            });
          }),
      ),
    );
  }
}

async function playwrightEnv(): Promise<NodeJS.ProcessEnv> {
  const missingPortNames = [
    process.env.PLAYWRIGHT_API_PORT === undefined
      ? "PLAYWRIGHT_API_PORT"
      : undefined,
    process.env.PLAYWRIGHT_WEB_PORT === undefined
      ? "PLAYWRIGHT_WEB_PORT"
      : undefined,
  ].filter((name) => name !== undefined);
  const ports = await availablePorts(missingPortNames.length);
  const allocatedPorts = Object.fromEntries(
    missingPortNames.map((name, index) => [name, ports[index]]),
  );

  return {
    ...process.env,
    PLAYWRIGHT_API_PORT:
      process.env.PLAYWRIGHT_API_PORT ?? allocatedPorts.PLAYWRIGHT_API_PORT,
    PLAYWRIGHT_WEB_PORT:
      process.env.PLAYWRIGHT_WEB_PORT ?? allocatedPorts.PLAYWRIGHT_WEB_PORT,
  };
}

const env = await playwrightEnv();
delete env.NO_COLOR;

const command = process.platform === "win32" ? "playwright.cmd" : "playwright";
const child = spawn(command, ["test", ...process.argv.slice(2)], {
  env,
  stdio: "inherit",
});

child.once("error", (error: Error) => {
  console.error(error);
  process.exitCode = 1;
});

child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
  if (signal) {
    console.error(`Playwright exited with signal ${signal}`);
    process.exitCode = 1;
    return;
  }

  process.exitCode = code ?? 1;
});
