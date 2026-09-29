import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";
import { Effect } from "effect";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "../dist/config.js";
import { sha256, importPdf } from "../dist/artifacts.js";
import type { Artifact } from "../dist/artifacts.js";
import { fetchNotes, prepareDelivery, watchNotes } from "../dist/bridge.js";
import type { Delivery } from "../dist/bridge.js";
import { errorMessage } from "../dist/errors.js";
import { startReceiver } from "../dist/ipc.js";
import { noteContent } from "../dist/message.js";
import { selectDocument, Tablet } from "../dist/tablet.js";
import type { Document } from "../dist/tablet.js";

type Mode = "attach" | "ask";
interface State { document?: Document; mode: Mode }
const help = `reMarkable → pi (read-only)
/remarkable select [notebook name, /folder/name, or ID]
/remarkable watch     Import now, then poll changes
/remarkable pull      Import once
/remarkable stop      Stop polling
/remarkable mode attach|ask
/remarkable import /absolute/path/to/notes.pdf
/remarkable url http://10.11.99.1
/remarkable doctor | status
Attach adds context without starting an agent turn. Ask queues a follow-up turn.
Use a short dedicated notebook; the last 8 pages are previewed by default.`;

export default function remarkable(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let generation = 0;
  let state: State = { mode: "attach" };
  let receiver: Awaited<ReturnType<typeof startReceiver>> | undefined;
  let watchController: AbortController | undefined;
  let watchTask: Promise<void> | undefined;
  let watchState = "stopped";
  let lastError = "";
  let errorAt = 0;
  let lifecycleController: AbortController | undefined;

  const notify = (text: string, level: "info" | "warning" | "error" = "info") => {
    if (context?.hasUI) context.ui.notify(text, level);
  };
  const status = () => context?.ui.setStatus("remarkable-pi", state.document ? `rM: ${state.document.name} · ${watchState} · ${state.mode}` : "rM: /remarkable select");
  const persist = () => pi.appendEntry("remarkable-pi-settings", state);

  async function stopWatch() {
    watchController?.abort();
    await watchTask?.catch(() => {});
    watchController = undefined;
    watchTask = undefined;
    watchState = "stopped";
    status();
  }

  async function share(delivery: Delivery, expectedGeneration: number, signal?: AbortSignal) {
    const ctx = context;
    if (!ctx || generation !== expectedGeneration || lifecycleController?.signal.aborted || signal?.aborted) throw new Error("Session changed; notes were not sent to the new session");
    const settings = pi.getSettings();
    const images = !!ctx.model?.input.includes("image") && !settings.images?.blockImages;
    const content = await noteContent(delivery, images);
    if (generation !== expectedGeneration || lifecycleController?.signal.aborted || signal?.aborted) throw new Error("Session changed or polling stopped during delivery");
    if (state.mode === "ask") {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    } else {
      pi.sendMessage({
        customType: "remarkable-notes", content, display: true,
        details: { artifact: delivery.artifact, totalPages: delivery.rendered.totalPages, previewPages: delivery.rendered.pages.map(p => p.number) },
      }, { triggerTurn: false });
    }
    notify(`Received ${delivery.artifact.name}: ${delivery.rendered.totalPages} PDF pages, ${delivery.rendered.pages.length} previews. ${state.mode === "ask" ? "Agent follow-up queued." : "Context attached; ask the agent when ready."}`);
    if (!images) notify("Page images were not sent: choose an image-capable model and ensure images.blockImages is false.", "warning");
  }

  async function receive(artifact: Artifact, expectedGeneration: number, requestSignal: AbortSignal) {
    const signal = AbortSignal.any([lifecycleController!.signal, requestSignal]);
    const config = await loadConfig();
    const info = await stat(artifact.pdfPath);
    if (!info.isFile() || info.size > config.maxPdfBytes) throw new Error("Invalid/oversized cached PDF");
    const data = await readFile(artifact.pdfPath);
    if (data.length > config.maxPdfBytes || sha256(data) !== artifact.hash) throw new Error("Cached PDF integrity check failed");
    const delivery = await Effect.runPromise(prepareDelivery(artifact, config), { signal });
    await share(delivery, expectedGeneration, signal);
  }

  async function cleanup() {
    generation++;
    lifecycleController?.abort();
    await stopWatch();
    await receiver?.close();
    receiver = undefined;
    context?.ui.setStatus("remarkable-pi", undefined);
    context = undefined;
  }

  pi.on("session_start", async (_event, ctx) => {
    await cleanup();
    context = ctx;
    lifecycleController = new AbortController();
    lastError = "";
    errorAt = 0;
    state = { mode: "attach" };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "remarkable-pi-settings") {
        const saved = entry.data as State;
        if (saved && (saved.mode === "attach" || saved.mode === "ask")) state = { ...saved };
      }
    }
    try {
      await loadConfig(); // Fail loudly rather than silently using invalid configuration.
      receiver = await startReceiver({ sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, name: pi.getSessionName() }, (artifact, signal) => receive(artifact, generation, signal));
      status();
    } catch (error) { notify(`reMarkable receiver failed: ${errorMessage(error)}`, "error"); }
    // Polling never starts automatically on session resume/reload/fork.
  });
  pi.on("session_shutdown", cleanup);
  pi.on("session_tree", async (_event, ctx) => {
    generation++;
    lifecycleController?.abort();
    await stopWatch();
    lifecycleController = new AbortController();
    state = { mode: "attach" };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === "remarkable-pi-settings") {
        const saved = entry.data as State;
        if (saved && (saved.mode === "attach" || saved.mode === "ask")) state = { ...saved };
      }
    }
    status();
  });

  pi.registerCommand("remarkable", {
    description: "Share reMarkable PDFs with this session: select, watch, pull, stop, mode, import, doctor",
    handler: async (args, ctx) => {
      const match = args.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const command = match?.[1] ?? "help";
      const argument = match?.[2]?.trim() ?? "";
      context = ctx;
      const expectedGeneration = generation;
      const commandSignal = lifecycleController?.signal;
      const ensureCurrent = () => { if (generation !== expectedGeneration) throw new Error("Session changed during command; retry in the current session"); };
      try {
        if (command === "help") return notify(help);
        if (command === "status") {
          const config = await loadConfig();
          return notify(`Tablet: ${config.url}\nNotebook: ${state.document?.path ?? "not selected"}\nPolling: ${watchState}\nDelivery: ${state.mode}\nSession: ${ctx.sessionManager.getSessionId()}\nReceiver: ${receiver ? receiver.endpoint.instanceId : "unavailable (try /reload)"}\nLast error: ${lastError || "none"}`);
        }
        if (command === "stop") { await stopWatch(); return notify("Stopped reMarkable polling. Local session receiver remains available."); }
        if (command === "mode") {
          if (argument !== "attach" && argument !== "ask") throw new Error("Usage: /remarkable mode attach|ask");
          state = { ...state, mode: argument };
          persist(); status();
          return notify(argument === "ask" ? "New notes will start/queue an agent turn. Your model provider may receive the notes." : "New notes attach as context only; no agent turn is started.");
        }
        if (command === "url") {
          if (!argument) throw new Error("Usage: /remarkable url http://10.11.99.1");
          await stopWatch();
          await saveConfig({ url: argument });
          return notify(`Tablet URL saved: ${argument}. Run /remarkable watch to restart.`);
        }
        const config = await loadConfig();
        ensureCurrent();
        const tablet = new Tablet(config);
        const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect, { signal: commandSignal });
        if (command === "doctor") {
          const documents = await run(tablet.listFolder());
          return notify(`Tablet reachable at ${config.url}; ${documents.length} root entries. Receiver ${receiver ? "ready" : "unavailable"}. Local PDF rendering enabled.`);
        }
        if (command === "import") {
          if (!argument) throw new Error("Usage: /remarkable import /absolute/path/to/notes.pdf (spaces are allowed, no quoting required)");
          const artifact = await run(importPdf(argument, config, basename(argument)));
          await share(await run(prepareDelivery(artifact, config)), expectedGeneration);
          return;
        }
        if (command === "select") {
          await stopWatch();
          const documents = await run(tablet.listAll());
          let selected: Document;
          if (argument) selected = selectDocument(documents, argument);
          else {
            if (!ctx.hasUI) throw new Error("Pass a notebook ID or exact name in non-interactive mode");
            const notebooks = documents.filter(d => d.type === "document");
            if (!notebooks.length) throw new Error("No notebooks found");
            const labels = notebooks.map((d, i) => `${i + 1}. ${d.path} [${d.id.slice(0, 8)}]`);
            const choice = await ctx.ui.select("Share which notebook?", labels);
            if (choice === undefined) return;
            selected = notebooks[labels.indexOf(choice)]!;
          }
          ensureCurrent();
          state = { ...state, document: selected };
          persist(); status();
          return notify(`Selected ${selected.path}. Run /remarkable watch (or pull for a single export).`);
        }
        if (command !== "watch" && command !== "pull") throw new Error(help);
        if (argument) throw new Error("Select a notebook with /remarkable select first; watch/pull take no arguments");
        const document = state.document;
        if (!document) throw new Error("Run /remarkable select first. The web interface cannot identify the currently open notebook.");
        if (command === "pull") {
          await share(await run(prepareDelivery(await run(fetchNotes(tablet, document)), config)), expectedGeneration);
          return;
        }
        await stopWatch();
        ensureCurrent();
        watchController = new AbortController();
        const signal = AbortSignal.any([watchController.signal, lifecycleController!.signal]);
        watchState = "starting";
        status();
        watchTask = Effect.runPromise(watchNotes({
          tablet, document, config,
          deliver: (delivery, deliverySignal) => share(delivery, expectedGeneration, deliverySignal),
          onState: value => { watchState = value; status(); },
          onError: error => {
            const text = errorMessage(error);
            if (text !== lastError || Date.now() - errorAt > 60000) { notify(text, "warning"); errorAt = Date.now(); }
            lastError = text;
          },
        }), { signal }).catch(error => { if (!signal.aborted) notify(errorMessage(error), "error"); });
        notify(`Watching ${document.path}. First export is on its way. Leave the tablet awake; close/reopen the notebook if changes are not visible.`);
      } catch (error) { if (generation === expectedGeneration) notify(errorMessage(error), "error"); }
    },
  });
}
