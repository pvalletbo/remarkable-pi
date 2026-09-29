import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Effect } from "effect";
import { readFile, stat } from "node:fs/promises";
import { defaults, loadConfig, paths, saveConfig, validateConfig } from "../src/config.js";
import { fetchNotes, prepareDelivery } from "../src/bridge.js";
import { importPdf, storePdf } from "../src/artifacts.js";
import { noteContent } from "../src/message.js";
import { parseDocuments, selectDocument, Tablet, validateId } from "../src/tablet.js";
import { tunnelArgs } from "../src/tunnel.js";
import { isolatedHome, mockTablet, samplePdf } from "./helpers.js";

let home: Awaited<ReturnType<typeof isolatedHome>>;
let tabletMock: Awaited<ReturnType<typeof mockTablet>> | undefined;
beforeEach(async () => { home = await isolatedHome(); });
afterEach(async () => { await tabletMock?.close(); tabletMock = undefined; await home.close(); });

it("validates and saves private configuration", async () => {
  expect(await loadConfig()).toEqual(defaults);
  await saveConfig({ url: "http://127.0.0.1:8088/", maxPages: 3 });
  expect((await loadConfig()).url).toBe("http://127.0.0.1:8088");
  expect((await stat(paths().configFile)).mode & 0o777).toBe(0o600);
  expect(() => validateConfig({ maxPages: 999 })).toThrow();
  expect(() => validateConfig({ settleMs: NaN })).toThrow();
  expect(() => validateConfig({ typo: 1 })).toThrow("Unknown config key");
  for (const url of ["file:///etc/passwd", "http://user:secret@host", "http://host/other", "http://host?x=y"]) expect(() => validateConfig({ url })).toThrow();
});

it("handles stock misspelled names and rejects unsafe IDs/types", () => {
  const docs = parseDocuments([{ ID: "abc-123", VissibleName: "../../notes", Type: "DocumentType", Version: 4 }]);
  expect(docs[0]?.name).toBe("../../notes");
  expect(docs[0]?.revision).toContain("4");
  expect(() => validateId("../etc/passwd")).toThrow();
  expect(() => parseDocuments({ error: "disabled" })).toThrow();
  expect(() => parseDocuments([{ ID: "abc", VissibleName: "notes", Type: "Other" }])).toThrow();
});

it("lists nested notebooks and uses only the two read-only stock routes", async () => {
  tabletMock = await mockTablet();
  const tablet = new Tablet({ ...defaults, url: tabletMock.url });
  const documents = await Effect.runPromise(tablet.listAll());
  const selected = selectDocument(documents, "/Agent notes/Demo notebook");
  const artifact = await Effect.runPromise(fetchNotes(tablet, selected));
  expect((await readFile(artifact.pdfPath)).subarray(0, 8).toString()).toBe("%PDF-1.4");
  expect((await stat(artifact.pdfPath)).mode & 0o777).toBe(0o600);
  expect(tabletMock.requests).toEqual(["POST /documents/", "POST /documents/folder-1", "GET /download/notebook-1/placeholder"]);
});

it("never silently selects duplicate notebook names", () => {
  const docs = parseDocuments([
    { ID: "one", VissibleName: "Notes", Type: "DocumentType" },
    { ID: "two", VissibleName: "Notes", Type: "DocumentType" },
  ]);
  expect(() => selectDocument(docs, "Notes")).toThrow("Multiple");
  expect(selectDocument(docs, "two").id).toBe("two");
  expect(() => selectDocument(docs, "Nope")).toThrow("not found");
});

it("rejects non-PDF and oversized tablet exports", async () => {
  tabletMock = await mockTablet();
  tabletMock.setPdf(Buffer.from("<html>Tablet asleep</html>"));
  const tablet = new Tablet({ ...defaults, url: tabletMock.url });
  await expect(Effect.runPromise(tablet.download("notebook-1"))).rejects.toThrow("did not return a PDF");
  tabletMock.setPdf(samplePdf());
  const bounded = new Tablet({ ...defaults, url: tabletMock.url, maxPdfBytes: 10 });
  await expect(Effect.runPromise(bounded.download("notebook-1"))).rejects.toThrow("exceeds");
});

it("stores names as metadata, not filesystem paths; validates local import limits", async () => {
  const artifact = await Effect.runPromise(storePdf("abc", "../../elsewhere", samplePdf()));
  expect(artifact.pdfPath.startsWith(paths().exportsDir)).toBe(true);
  expect(artifact.pdfPath).not.toContain("elsewhere");
  await expect(Effect.runPromise(importPdf(artifact.pdfPath, { ...defaults, maxPdfBytes: 10 }))).rejects.toThrow("exceeds");
});

it("renders actual PDF text and vector drawing to local page images, with bounded last-page selection", async () => {
  const config = { ...defaults, maxPages: 2, maxImageEdge: 800 };
  const artifact = await Effect.runPromise(storePdf("abc", "Test notes", samplePdf("Read handwritten plan", 3)));
  const delivery = await Effect.runPromise(prepareDelivery(artifact, config));
  expect(delivery.rendered.totalPages).toBe(3);
  expect(delivery.rendered.pages.map(p => p.number)).toEqual([2, 3]);
  expect(delivery.rendered.text).toContain("Read handwritten plan");
  const content = await noteContent(delivery);
  expect(content.filter(c => c.type === "image")).toHaveLength(2);
  const image = await readFile(delivery.rendered.pages[0]!.imagePath);
  expect(image.subarray(1, 4).toString()).toBe("PNG");
  expect(delivery.rendered.previewHash).toMatch(/^[a-f0-9]{64}$/);
  const cached = await Effect.runPromise(prepareDelivery(artifact, config));
  expect(cached.rendered.previewHash).toBe(delivery.rendered.previewHash);
  expect((await noteContent(delivery, false)).every(c => c.type === "text")).toBe(true);
});

it("keeps SSH forwarding loopback-only and does not run a remote command", () => {
  const args = tunnelArgs("192.168.1.10");
  expect(args).toContain("127.0.0.1:8088:10.11.99.1:80");
  expect(args.at(-1)).toBe("root@192.168.1.10");
  for (const host of ["-oProxyCommand=bad", "foo;rm", "root@foo", "foo bar"]) expect(() => tunnelArgs(host)).toThrow();
  expect(() => tunnelArgs("host", 80)).toThrow();
});
