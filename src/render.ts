import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { readFile } from "node:fs/promises";
import { atomicWrite } from "./config.js";
import type { Config } from "./config.js";
import type { Artifact } from "./artifacts.js";
import { sha256 } from "./artifacts.js";
import { attempt } from "./errors.js";
import { bunExecutable } from "./runtime.js";

export interface RenderedPdf {
  totalPages: number;
  pages: { number: number; imagePath: string }[];
  text: string;
  previewHash: string;
}

const execute = promisify(execFile);

export function renderPdf(artifact: Artifact, config: Config) {
  return attempt("Cannot render PDF locally", async (signal) => {
    // Native canvas/PDF parsing stays outside pi's event loop. Killing a timed-out
    // subprocess releases its memory and cannot crash the pi session.
    const worker = fileURLToPath(new URL("../dist/render-worker.js", import.meta.url));
    const directory = join(dirname(artifact.pdfPath), `preview-${config.maxPages}-${config.maxImageEdge}`);
    const manifest = join(directory, "render.json");
    let rendered: RenderedPdf | undefined;
    try {
      const cached = JSON.parse(await readFile(manifest, "utf8")) as RenderedPdf;
      if (Array.isArray(cached.pages) && cached.pages.length <= config.maxPages && cached.pages.every(p => Number.isInteger(p.number) && p.imagePath === join(directory, `page-${p.number}.png`))) {
        await Promise.all(cached.pages.map(p => readFile(p.imagePath)));
        rendered = cached;
      }
    } catch { /* A missing/incomplete cache is regenerated locally. */ }
    if (!rendered) {
      // pi itself may be hosted by Node, so process.execPath is not necessarily Bun.
      const { stdout } = await execute(bunExecutable(), [
        "--smol", "--no-install", "--no-env-file", worker, artifact.pdfPath, directory,
        String(config.maxPages), String(config.maxImageEdge), String(config.maxPdfBytes),
      ], { signal, timeout: config.timeoutMs, maxBuffer: 1024 * 1024 });
      rendered = JSON.parse(stdout) as RenderedPdf;
      await atomicWrite(manifest, JSON.stringify(rendered));
    }
    if (!Array.isArray(rendered.pages) || !Number.isInteger(rendered.totalPages)) throw new Error("Invalid renderer output");
    const previews = await Promise.all(rendered.pages.map(p => readFile(p.imagePath)));
    const hashes = previews.map(sha256);
    rendered.previewHash = sha256(JSON.stringify([rendered.totalPages, rendered.text, hashes]));
    return rendered;
  });
}
