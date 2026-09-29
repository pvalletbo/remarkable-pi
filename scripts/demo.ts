import { resolve } from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Effect } from "effect";
import { mockTablet, samplePdf } from "../test/helpers.js";
import { saveConfig, loadConfig } from "../src/config.js";
import { importPdf } from "../src/artifacts.js";
import { prepareDelivery } from "../src/bridge.js";

process.env.REMARKABLE_PI_HOME = resolve(".demo/home");
await mkdir(".demo", { recursive: true });
const pdfPath = resolve(".demo/sample-notes.pdf");
await writeFile(pdfPath, samplePdf());
if (process.argv.includes("--once")) {
  const config = await loadConfig();
  const artifact = await Effect.runPromise(importPdf(pdfPath, config, "Demo notebook"));
  const delivery = await Effect.runPromise(prepareDelivery(artifact, config));
  console.log(JSON.stringify(delivery, null, 2));
} else {
  const tablet = await mockTablet();
  await saveConfig({ url: tablet.url, pollIntervalMs: 1000, settleMs: 1000, exportIntervalMs: 5000 });
  console.log(`\nMock tablet running at ${tablet.url}; no hardware or model calls needed.\n`);
  console.log(`In another terminal, from ${process.cwd()}:\n\n  REMARKABLE_PI_HOME=${JSON.stringify(process.env.REMARKABLE_PI_HOME)} pi -e ./extensions/remarkable.ts\n\nInside pi:\n  /remarkable select Demo notebook\n  /remarkable watch\n\nAttach mode will show the original PDF path and page images, without invoking a model.\nType n + Enter here to simulate new notes; d disconnects, r reconnects, q quits.\n`);
  const input = createInterface({ input: process.stdin, output: process.stdout });
  let revision = 1;
  let closing = false;
  const close = async () => { if (closing) return; closing = true; input.close(); await tablet.close(); };
  input.on("line", line => {
    if (line.trim() === "n") { tablet.update(`New note ${++revision}: next step is testing`); console.log(`Notebook updated (${revision}).`); }
    else if (line.trim() === "d") { tablet.status(503); console.log("Tablet disconnected."); }
    else if (line.trim() === "r") { tablet.status(200); console.log("Tablet reconnected."); }
    else if (line.trim() === "q") void close();
  });
  input.on("close", () => void close());
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
}
