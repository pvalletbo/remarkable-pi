#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { basename } from "node:path";
import { Effect } from "effect";
import { defaults, loadConfig, paths, saveConfig } from "./config.js";
import type { Config } from "./config.js";
import { importPdf } from "./artifacts.js";
import { fetchNotes, watchNotes } from "./bridge.js";
import { errorMessage } from "./errors.js";
import { listSessions, publicEndpoint, selectSession, sendArtifact } from "./ipc.js";
import { selectDocument, Tablet } from "./tablet.js";
import { runTunnel } from "./tunnel.js";

const help = `remarkable-pi — local, read-only reMarkable → pi bridge

Usage: remarkable-pi <command> [argument] [options]

  doctor                    Check tablet connectivity and live pi receivers
  list                      List notebooks (including nested folders)
  fetch <name|/path|ID>      Download a notebook PDF to the local cache
  sessions                  List running pi sessions with this extension
  send <name|/path|ID>       Download a notebook and attach it to a pi session
  watch <name|/path|ID>      Import now, then poll and send changed previews
  import <file.pdf>          Attach an existing local PDF to a pi session
  config                    Show configuration and local storage paths
  config set <key> <value>   Save a configuration value
  tunnel <wifi-host>         Open an optional read-only SSH tunnel

Options:
  --url <origin>            Override tablet URL for this command only
  --session <ID>            Target session/instance ID or unique prefix
  --json                    Print machine-readable output
  --port <number>           SSH tunnel local port (default 8088)
  --help                    Show this help

Default tablet: http://10.11.99.1 (stock USB web interface).
Enable Settings → Storage → USB web interface on the unlocked tablet.
Names are exact and case-sensitive; use IDs when names are duplicated.
PI_SESSION_ID selects the current pi session when invoked from its shell.
No flashing, uploads, deletes, tablet packages, or cloud API calls.
`;

async function main() {
  if (!process.versions.bun) throw new Error("This CLI requires Bun. Run bun dist/cli.js <command> instead of node dist/cli.js.");
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { url: { type: "string" }, session: { type: "string" }, json: { type: "boolean" }, port: { type: "string" }, help: { type: "boolean", short: "h" } },
  });
  const [command, ...args] = positionals;
  if (!command || values.help) return console.log(help);
  const output = (data: unknown, text: string) => console.log(values.json ? JSON.stringify(data, null, 2) : text);
  if (command === "config") {
    if (args.length) {
      if (args[0] !== "set" || args.length !== 3 || !Object.hasOwn(defaults, args[1]!)) throw new Error("Usage: config set <key> <value>; run config to see keys");
      const key = args[1]! as keyof Config;
      const value = key === "url" ? args[2]! : Number(args[2]);
      await saveConfig({ [key]: value });
    }
    const config = await loadConfig();
    return output({ config, paths: paths() }, JSON.stringify({ config, paths: paths() }, null, 2));
  }
  if (command === "tunnel") {
    if (args.length !== 1) throw new Error("Usage: tunnel <wifi-host> [--port 8088]");
    return runTunnel(args[0]!, values.port ? Number(values.port) : 8088);
  }
  if (command === "sessions") {
    const sessions = await listSessions();
    return output(sessions.map(publicEndpoint), sessions.length ? sessions.map(s => `${s.sessionId}  instance=${s.instanceId}\n  ${s.name || "(unnamed)"} · ${s.cwd} · PID ${s.pid}`).join("\n") : "No live pi receivers. Load the extension in pi and /reload.");
  }
  const stored = await loadConfig();
  const config = values.url ? { ...stored, url: (await import("./config.js")).validateConfig({ ...stored, url: values.url }).url } : stored;
  const tablet = new Tablet(config);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const run = <A>(effect: Effect.Effect<A, unknown>) => Effect.runPromise(effect, { signal: controller.signal });
  try {
    if (command === "doctor") {
      const sessions = await listSessions();
      let tabletError: string | undefined;
      let rootEntries = 0;
      try { rootEntries = (await run(tablet.listFolder())).length; }
      catch (error) { tabletError = errorMessage(error); process.exitCode = 1; }
      const data = { runtime: "bun", bunVersion: process.versions.bun, tabletUrl: config.url, tabletReachable: !tabletError, rootEntries, tabletError, liveReceivers: sessions.length, paths: paths() };
      return output(data, `${tabletError ? `FAIL: ${tabletError}` : `OK: tablet reachable (${rootEntries} root entries)`}\n${sessions.length} live pi receiver(s).\nCache: ${paths().exportsDir}\nTest rendering and the full pipeline without hardware: bun run demo`);
    }
    if (command === "import") {
      if (args.length !== 1) throw new Error("Usage: import <file.pdf> [--session ID]; quote paths containing spaces");
      const endpoint = selectSession(await listSessions(), values.session);
      const artifact = await run(importPdf(args[0]!, config, basename(args[0]!)));
      await sendArtifact(endpoint, artifact, config.timeoutMs + 15000, controller.signal);
      return output({ sessionId: endpoint.sessionId, ...artifact }, `Attached ${artifact.pdfPath} to session ${endpoint.sessionId}`);
    }
    if (!["list", "fetch", "send", "watch"].includes(command)) throw new Error(`Unknown command: ${command}\n${help}`);
    // Select the receiver before any network export, and never retarget a watcher.
    const endpoint = command === "send" || command === "watch" ? selectSession(await listSessions(), values.session) : undefined;
    const documents = await run(tablet.listAll());
    if (command === "list") return output(documents, documents.map(d => `${d.type === "folder" ? "DIR " : "PDF "} ${d.id}  ${d.path}`).join("\n"));
    if (!args.length) throw new Error(`Usage: ${command} <name|/path|ID>`);
    const document = selectDocument(documents, args.join(" "));
    if (command === "watch") {
      output({ event: "watching", notebook: document.path, sessionId: endpoint!.sessionId }, `Watching ${document.path} → ${endpoint!.sessionId}. Ctrl-C stops. Target is fixed for this process.`);
      await run(watchNotes({
        tablet, document, config,
        deliver: async (delivery, signal) => {
          await sendArtifact(endpoint!, delivery.artifact, config.timeoutMs + 15000, signal);
          output({ event: "delivered", sessionId: endpoint!.sessionId, ...delivery.artifact }, `Attached ${delivery.artifact.name} (${delivery.artifact.hash.slice(0, 12)})`);
        },
        onError: error => console.error(`Retrying: ${errorMessage(error)}`),
      }));
      return;
    }
    const artifact = await run(fetchNotes(tablet, document));
    if (endpoint) await sendArtifact(endpoint, artifact, config.timeoutMs + 15000, controller.signal);
    return output({ ...artifact, ...(endpoint ? { sessionId: endpoint.sessionId } : {}) }, endpoint ? `Attached ${artifact.pdfPath} to session ${endpoint.sessionId}` : artifact.pdfPath);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

main().catch(error => { console.error(`Error: ${errorMessage(error)}`); process.exitCode = 1; });
