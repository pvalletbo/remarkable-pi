// Standalone worker: do not import this module from an extension.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { createCanvas, DOMMatrix, ImageData, Path2D } from "@napi-rs/canvas";
import { atomicWrite, privateDirectory } from "./config.js";

Object.assign(globalThis, { DOMMatrix, ImageData, Path2D });

async function main() {
  const [pdfPath, directory, pageLimit, edgeLimit, byteLimit] = process.argv.slice(2);
  if (!pdfPath || !directory) throw new Error("Missing renderer arguments");
  const maxPages = Number(pageLimit), maxEdge = Number(edgeLimit), maxBytes = Number(byteLimit);
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 32 || !Number.isInteger(maxEdge) || maxEdge < 400 || maxEdge > 2400 || !Number.isInteger(maxBytes)) throw new Error("Invalid renderer limits");
  if ((await stat(pdfPath)).size > maxBytes) throw new Error("PDF exceeds byte limit");
  const data = new Uint8Array(await readFile(pdfPath));
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
  const task = getDocument({
    data, useSystemFonts: false,
    standardFontDataUrl: join(root, "standard_fonts/") + "/",
    cMapUrl: join(root, "cmaps/") + "/", cMapPacked: true,
    wasmUrl: join(root, "wasm/") + "/", verbosity: 0,
  });
  const document = await task.promise;
  try {
    if (document.numPages > 10000) throw new Error("PDF has too many pages");
    await privateDirectory(directory);
    const pages: { number: number; imagePath: string }[] = [];
    const texts: string[] = [];
    // New writing is generally at the end. Full original PDF is always retained.
    const first = Math.max(1, document.numPages - maxPages + 1);
    for (let number = first; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      if (!Number.isFinite(natural.width) || !Number.isFinite(natural.height) || natural.width <= 0 || natural.height <= 0) throw new Error("Invalid page dimensions");
      const viewport = page.getViewport({ scale: maxEdge / Math.max(natural.width, natural.height) });
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const context = canvas.getContext("2d");
      await page.render({
        canvas: canvas as unknown as HTMLCanvasElement,
        canvasContext: context as unknown as CanvasRenderingContext2D,
        viewport, background: "rgb(255,255,255)",
      }).promise;
      const imagePath = join(directory, `page-${number}.png`);
      await atomicWrite(imagePath, canvas.toBuffer("image/png"));
      pages.push({ number, imagePath });
      const text = await page.getTextContent();
      const line = text.items.map(item => "str" in item ? item.str : "").join(" ");
      if (line.trim()) texts.push(`Page ${number}: ${line}`);
      page.cleanup();
    }
    process.stdout.write(JSON.stringify({ totalPages: document.numPages, pages, text: texts.join("\n").slice(0, 20000), previewHash: "" }));
  } finally { await task.destroy(); }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
