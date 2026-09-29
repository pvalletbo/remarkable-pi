import { Effect } from "effect";
import type { Config } from "./config.js";
import type { Artifact } from "./artifacts.js";
import { storePdf } from "./artifacts.js";
import { attempt, BridgeError } from "./errors.js";
import { renderPdf } from "./render.js";
import type { RenderedPdf } from "./render.js";
import { Tablet } from "./tablet.js";
import type { Document } from "./tablet.js";

export interface Delivery {
  artifact: Artifact;
  rendered: RenderedPdf;
}

export function fetchNotes(tablet: Tablet, document: Document) {
  return Effect.gen(function*() {
    const bytes = yield* tablet.download(document.id);
    return yield* storePdf(document.id, document.name, bytes);
  });
}

export function prepareDelivery(artifact: Artifact, config: Config) {
  return Effect.gen(function*() {
    const rendered = yield* renderPdf(artifact, config);
    return { artifact, rendered } satisfies Delivery;
  });
}

export interface WatchOptions {
  tablet: Tablet;
  document: Document;
  config: Config;
  deliver: (delivery: Delivery, signal: AbortSignal) => Promise<void>;
  onError: (error: BridgeError) => void;
  onState?: (state: string) => void;
}

/** Sequential, interruptible polling. A failed delivery is never acknowledged. */
export function watchNotes(options: WatchOptions) {
  const { tablet, document, config } = options;
  return Effect.gen(function*() {
    let deliveredHash = "";
    let previewHash = "";
    let deliveredRevision = "";
    let lastExport = 0;
    let observedRevision = "";
    let changedAt = 0;
    let failures = 0;
    let first = true;
    while (true) {
      const result = yield* Effect.result(Effect.gen(function*() {
        const folderPath = document.path.slice(0, document.path.lastIndexOf("/"));
        const listing = yield* tablet.listFolder(document.parentId, folderPath);
        const current = listing.find(d => d.id === document.id && d.type === "document");
        if (!current) return yield* Effect.fail(new BridgeError({ message: "Selected notebook disappeared or moved. Select it again; no other notebook will be sent." }));
        const now = Date.now();
        if (current.revision !== observedRevision) {
          observedRevision = current.revision;
          changedAt = now;
          if (!first) lastExport = 0;
        }
        if (!first && now - changedAt < config.settleMs) return;
        if (!first && now - lastExport < config.exportIntervalMs) return;
        options.onState?.("exporting");
        const artifact = yield* fetchNotes(tablet, current);
        if (artifact.hash !== deliveredHash) {
          const delivery = yield* prepareDelivery(artifact, config);
          // PDF exports can change timestamps without changing visible notes.
          // Compare actual local page renders to avoid repeatedly waking the agent.
          if (delivery.rendered.previewHash !== previewHash || current.revision !== deliveredRevision) {
            yield* attempt("Delivery failed", signal => options.deliver(delivery, signal));
            previewHash = delivery.rendered.previewHash;
          }
          deliveredHash = artifact.hash;
          deliveredRevision = current.revision;
        }
        first = false;
        lastExport = Date.now();
        options.onState?.("watching");
      }));
      if (result._tag === "Failure") {
        failures++;
        options.onError(result.failure);
        options.onState?.("disconnected — retrying");
      } else failures = 0;
      yield* Effect.sleep(Math.min(config.pollIntervalMs * 2 ** Math.min(failures, 4), Math.max(config.pollIntervalMs, 60000)));
    }
  });
}
