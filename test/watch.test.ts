import { afterEach, beforeEach, expect, it } from "vitest";
import { Effect } from "effect";
import { defaults } from "../src/config.js";
import { watchNotes } from "../src/bridge.js";
import { Tablet, selectDocument } from "../src/tablet.js";
import { isolatedHome, mockTablet, samplePdf } from "./helpers.js";

let home: Awaited<ReturnType<typeof isolatedHome>>;
let mock: Awaited<ReturnType<typeof mockTablet>>;
let controller: AbortController;
let task: Promise<unknown> | undefined;
beforeEach(async () => { home = await isolatedHome(); mock = await mockTablet(); controller = new AbortController(); });
afterEach(async () => { controller.abort(); await task; await mock.close(); await home.close(); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(test: () => boolean, timeout = 15000) {
  const start = Date.now();
  while (!test()) { if (Date.now() - start > timeout) throw new Error("Condition timed out"); await delay(25); }
}

it("sends initial notes, suppresses timestamp-only changes, detects missing-metadata edits, and cancels cleanly", async () => {
  mock.metadata(false);
  const config = { ...defaults, url: mock.url, pollIntervalMs: 50, exportIntervalMs: 100, settleMs: 30, maxImageEdge: 500 };
  const tablet = new Tablet(config);
  const document = selectDocument(await Effect.runPromise(tablet.listAll()), "notebook-1");
  const received: string[] = [];
  task = Effect.runPromise(watchNotes({ tablet, document, config, deliver: async delivery => { received.push(delivery.rendered.previewHash); }, onError: error => { throw error; } }), { signal: controller.signal }).catch(() => {});
  await until(() => received.length === 1);
  await delay(250);
  expect(received).toHaveLength(1);
  mock.setPdf(samplePdf("Plan: share notes locally", 1, "20260202000000"));
  await delay(1000);
  expect(received).toHaveLength(1);
  mock.update("New handwritten task");
  await until(() => received.length === 2);
  expect(received[0]).not.toBe(received[1]);
  controller.abort();
  await task;
  const requests = mock.requests.length;
  await delay(200);
  expect(mock.requests).toHaveLength(requests);
});

it("retries failed deliveries and reconnects without losing the selected notebook", async () => {
  const config = { ...defaults, url: mock.url, pollIntervalMs: 50, exportIntervalMs: 100, settleMs: 30, maxImageEdge: 500 };
  const tablet = new Tablet(config);
  const document = selectDocument(await Effect.runPromise(tablet.listAll()), "notebook-1");
  let attempts = 0;
  let received = 0;
  const errors: string[] = [];
  task = Effect.runPromise(watchNotes({
    tablet, document, config,
    deliver: async () => { attempts++; if (attempts === 1) throw new Error("temporary receiver error"); received++; },
    onError: error => { errors.push(error.message); },
  }), { signal: controller.signal }).catch(() => {});
  await until(() => received === 1);
  expect(attempts).toBe(2);
  expect(errors.some(e => e.includes("temporary receiver error"))).toBe(true);
  mock.status(503);
  await until(() => errors.some(e => e.includes("HTTP 503")));
  mock.update("After reconnect");
  mock.status(200);
  await until(() => received === 2);
  mock.missing(true);
  await until(() => errors.some(e => e.includes("disappeared or moved")));
  expect(received).toBe(2);
});
