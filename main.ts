// main.ts — the entry lifecycle (kept minimal, as the kit's starter does):
// bind an ephemeral port, register it with the environment, then long-poll
// /done until the suite says the trial is over and exit 0. Exits 1 at once
// when MAKEFUN_ENV_URL is unset, and when another entry already registered
// (HTTP 409). The server itself lives in app.ts; this file only wires the
// lifecycle around it.

import { createApp } from "./app.ts";

const ENV_URL = process.env.MAKEFUN_ENV_URL;

if (!ENV_URL) {
  console.error("MAKEFUN_ENV_URL is not set");
  process.exit(1);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function register(port: number): Promise<void> {
  let delayMs = 100;
  for (let attempt = 0; attempt < 20; attempt++) {
    let response: Response;
    try {
      response = await fetch(`${ENV_URL}/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ port }),
      });
    } catch (err) {
      console.error(`register attempt ${attempt + 1} failed: ${(err as Error).message}`);
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 5000);
      continue;
    }
    if (response.status === 409) {
      console.error("another entry already registered (409)");
      process.exit(1);
    }
    if (response.ok) return;
    console.error(`register attempt ${attempt + 1} returned HTTP ${response.status}`);
    await sleep(delayMs);
    delayMs = Math.min(delayMs * 2, 5000);
  }
  console.error("could not register with the environment");
  process.exit(1);
}

async function waitForDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: boolean };
        if (body.done) return;
      }
    } catch {
      // The environment may restart; keep polling.
    }
    await sleep(500);
  }
}

async function main(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    console.error("could not determine the listening port");
    process.exit(1);
  }
  const port = address.port;
  console.log(`forge listening on 127.0.0.1:${port}`);
  await register(port);
  console.log("registered; waiting for done");
  await waitForDone();
  console.log("done; exiting");
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
