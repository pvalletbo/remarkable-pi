import { Effect } from "effect";
import type { Config } from "./config.js";
import { attempt, BridgeError } from "./errors.js";

export interface Document {
  id: string;
  name: string;
  path: string;
  parentId: string;
  type: "document" | "folder";
  revision: string;
}

export function validateId(id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid document ID");
  return id;
}

export function parseDocuments(value: unknown, parentId = "", parentPath = ""): Document[] {
  if (!Array.isArray(value)) throw new Error("Unexpected tablet response: expected a document array (is USB web interface enabled?)");
  return value.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new Error("Invalid tablet document");
    const raw = item as Record<string, unknown>;
    if (typeof raw.ID !== "string" || typeof (raw.VissibleName ?? raw.VisibleName) !== "string") throw new Error("Invalid tablet document ID/name");
    const name = String(raw.VissibleName ?? raw.VisibleName);
    if (raw.Type !== "DocumentType" && raw.Type !== "CollectionType") throw new Error(`Unknown tablet document type: ${raw.Type}`);
    // Names/paths are display-only. Never use them to address local files.
    const revision = JSON.stringify([raw.Version ?? raw.version ?? null, raw.LastModified ?? raw.lastModified ?? raw.ModifiedClient ?? null]);
    return { id: validateId(raw.ID), name, path: `${parentPath}/${name}`, parentId, type: raw.Type === "CollectionType" ? "folder" : "document", revision };
  });
}

async function boundedBody(response: Response, limit: number): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (length > limit) { await response.body?.cancel(); throw new Error(`Response exceeds ${limit} bytes`); }
  if (!response.body) throw new Error("Empty tablet response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error(`Response exceeds ${limit} bytes`);
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

export function isPdf(data: Uint8Array) {
  return new TextDecoder().decode(data.subarray(0, 1024)).includes("%PDF-");
}

export class Tablet {
  constructor(readonly config: Config) {}

  private request(path: string, method: "GET" | "POST", limit: number) {
    return attempt(`Cannot read tablet at ${this.config.url}. Connect USB, unlock it, and enable Settings → Storage → USB web interface`, async (signal) => {
      const response = await fetch(`${this.config.url}${path}`, {
        method, ...(method === "POST" ? { body: "" } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.timeoutMs)]),
        redirect: "error",
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status} for ${path}`); }
      return boundedBody(response, limit);
    });
  }

  listFolder(parentId = "", parentPath = "") {
    const self = this;
    return Effect.gen(function*() {
      if (parentId) yield* Effect.try({ try: () => validateId(parentId), catch: (cause) => new BridgeError({ message: "Invalid folder ID", cause }) });
      // This POST is a read-only listing in the stock API. There is no upload/delete route in this project.
      const data = yield* self.request(`/documents/${parentId}`, "POST", 5 * 1024 * 1024);
      return yield* Effect.try({
        try: () => parseDocuments(JSON.parse(new TextDecoder().decode(data)), parentId, parentPath),
        catch: (cause) => new BridgeError({ message: `Cannot parse tablet listing: ${cause instanceof Error ? cause.message : String(cause)}`, cause }),
      });
    });
  }

  listAll() {
    const self = this;
    return Effect.gen(function*() {
      const results: Document[] = [];
      const queue = [{ id: "", path: "" }];
      const visited = new Set<string>();
      while (queue.length) {
        const folder = queue.shift()!;
        if (visited.has(folder.id)) continue;
        visited.add(folder.id);
        if (visited.size > 1000) return yield* Effect.fail(new BridgeError({ message: "Tablet folder limit (1000) exceeded" }));
        const documents = yield* self.listFolder(folder.id, folder.path);
        for (const document of documents) {
          results.push(document);
          if (document.type === "folder" && document.id !== "trash") queue.push({ id: document.id, path: document.path });
        }
        if (results.length > 10000) return yield* Effect.fail(new BridgeError({ message: "Tablet document limit (10000) exceeded" }));
      }
      return results;
    });
  }

  download(id: string) {
    const self = this;
    return Effect.gen(function*() {
      yield* Effect.try({ try: () => validateId(id), catch: (cause) => new BridgeError({ message: "Invalid document ID", cause }) });
      const data = yield* self.request(`/download/${id}/placeholder`, "GET", self.config.maxPdfBytes);
      if (!isPdf(data)) return yield* Effect.fail(new BridgeError({ message: "Tablet did not return a PDF (it may be asleep or still saving the notebook)" }));
      return data;
    });
  }
}

export function selectDocument(documents: Document[], selector: string): Document {
  const candidates = documents.filter(d => d.type === "document");
  const exactId = candidates.find(d => d.id === selector);
  if (exactId) return exactId;
  const matches = candidates.filter(d => d.name === selector || d.path === selector);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) throw new Error(`Multiple notebooks named ${JSON.stringify(selector)}. Use the full path or document ID.`);
  throw new Error(`Notebook ${JSON.stringify(selector)} not found. Run list, or /remarkable select.`);
}
