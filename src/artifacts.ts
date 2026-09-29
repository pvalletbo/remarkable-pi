import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { Effect } from "effect";
import type { Config } from "./config.js";
import { atomicWrite, paths, privateDirectory } from "./config.js";
import { attempt } from "./errors.js";
import { isPdf, validateId } from "./tablet.js";

export interface Artifact {
  id: string;
  name: string;
  hash: string;
  pdfPath: string;
  receivedAt: string;
}

export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");

export function storePdf(id: string, name: string, data: Uint8Array) {
  return attempt("Cannot save local PDF", async () => {
    validateId(id);
    if (!isPdf(data)) throw new Error("Not a PDF");
    const hash = sha256(data);
    const directory = join(paths().exportsDir, id, hash);
    await privateDirectory(directory);
    const pdfPath = join(directory, "notes.pdf");
    // Content-addressed paths are immutable; safe for two sessions to share.
    try { await stat(pdfPath); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await atomicWrite(pdfPath, data);
    }
    const artifact: Artifact = { id, name, hash, pdfPath, receivedAt: new Date().toISOString() };
    await atomicWrite(join(directory, "metadata.json"), JSON.stringify(artifact, null, 2) + "\n");
    return artifact;
  });
}

export function importPdf(path: string, config: Config, name?: string) {
  return Effect.gen(function*() {
    const data = yield* attempt("Cannot read PDF", async () => {
      const info = await stat(path);
      if (!info.isFile() || info.size > config.maxPdfBytes) throw new Error("PDF is not a regular file or exceeds maxPdfBytes");
      const bytes = await readFile(path);
      if (bytes.length > config.maxPdfBytes) throw new Error("PDF exceeds maxPdfBytes");
      return bytes;
    });
    return yield* storePdf("imported", name ?? "Imported notes", data);
  });
}
