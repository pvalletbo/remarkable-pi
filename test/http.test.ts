import { afterEach, expect, it } from "bun:test";
import { createServer } from "node:http";
import type { RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { Effect } from "effect";
import { defaults } from "../src/config.js";
import { Tablet } from "../src/tablet.js";

const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

it("never follows a tablet export redirect to another server", async () => {
  let forwarded = 0;
  const target = await serve((_req, res) => { forwarded++; res.end("%PDF-1.4\n"); });
  const origin = await serve((_req, res) => { res.writeHead(302, { location: `${target}/notes.pdf` }); res.end(); });
  await expect(Effect.runPromise(new Tablet({ ...defaults, url: origin }).download("notes"))).rejects.toThrow("HTTP 302");
  expect(forwarded).toBe(0);
});

it("bounds streamed exports even without a Content-Length", async () => {
  const url = await serve((_req, res) => {
    res.write("%PDF-1.4\n");
    res.end(Buffer.alloc(4096)); // write + end makes this response chunked.
  });
  await expect(Effect.runPromise(new Tablet({ ...defaults, url, maxPdfBytes: 128 }).download("notes"))).rejects.toThrow("exceeds 128 bytes");
});

it("times out while an export body is stalled, not only while waiting for headers", async () => {
  const url = await serve((_req, res) => { res.writeHead(200); res.write("%PDF-1.4\n"); });
  const started = Date.now();
  await expect(Effect.runPromise(new Tablet({ ...defaults, url, timeoutMs: 100 }).download("notes"))).rejects.toThrow("Cannot read tablet");
  expect(Date.now() - started).toBeLessThan(2000);
});

it("Effect cancellation closes the underlying tablet connection promptly", async () => {
  let received!: () => void;
  const requestSeen = new Promise<void>(resolve => { received = resolve; });
  let closed = false;
  const url = await serve((_req, res) => {
    res.on("close", () => { closed = true; });
    res.writeHead(200); res.write("%PDF-1.4\n");
    received();
  });
  const controller = new AbortController();
  // Do not use an eager promise matcher before reaching the abort.
  const result = Effect.runPromise(new Tablet({ ...defaults, url }).download("notes"), { signal: controller.signal }).catch(error => error);
  await requestSeen;
  controller.abort();
  expect(await result).toBeInstanceOf(Error);
  for (let i = 0; !closed && i < 100; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(closed).toBe(true);
});
