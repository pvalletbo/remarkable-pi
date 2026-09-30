import { expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { resolve, join } from "node:path";
import { once } from "node:events";
import { Effect } from "effect";
import { defaults, saveConfig } from "../src/config.js";
import { fetchNotes } from "../src/bridge.js";
import { listSessions, selectSession, sendArtifact } from "../src/ipc.js";
import { selectDocument, Tablet } from "../src/tablet.js";
import { isolatedHome, mockTablet } from "./helpers.js";

type RecordValue = Record<string, any>;

const piRuntime = process.env.REMARKABLE_PI_TEST_PI_RUNTIME === "node" ? "node" : "bun";

it(`loads in real offline ${piRuntime}-hosted pi, imports PDF images as context, watches, and removes the old receiver on session replacement`, async () => {
  const home = await isolatedHome();
  const mock = await mockTablet();
  await saveConfig({ url: mock.url, pollIntervalMs: 1000, settleMs: 0, exportIntervalMs: 5000, maxImageEdge: 500 });
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(home.home, "pi-agent"), PI_OFFLINE: "1" };
  delete env.PI_SESSION_ID;
  delete env.PI_SESSION_FILE;
  const child = spawn(piRuntime === "node" ? "node" : process.execPath, [
    resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
    "--mode", "rpc", "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve", "--no-tools", "--offline",
    "--provider", "anthropic", "--model", "claude-sonnet-4-20250514", "--api-key", "offline-test-not-used",
    "-e", resolve("extensions/remarkable.ts"),
  ], { env, stdio: ["pipe", "pipe", "pipe"] });
  const events: RecordValue[] = [];
  const pending = new Map<string, { resolve: (value: RecordValue) => void; reject: (reason: Error) => void; timer: NodeJS.Timeout }>();
  let buffer = "", stderr = "", nextId = 0;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", data => { stderr += data; });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", data => {
    buffer += data;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line) as RecordValue;
        events.push(record);
        if (record.type === "response" && pending.has(record.id)) {
          const waiter = pending.get(record.id)!;
          clearTimeout(waiter.timer); pending.delete(record.id);
          if (record.success) waiter.resolve(record); else waiter.reject(new Error(record.error));
        }
      } catch (error) { stderr += `\nNon-JSON stdout: ${line}\n${error}`; }
    }
  });
  const rpc = (type: string, params: RecordValue = {}) => new Promise<RecordValue>((resolve, reject) => {
    const id = String(++nextId);
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`RPC ${type} timeout. ${stderr}`)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, type, ...params }) + "\n");
  });
  try {
    const commands = await rpc("get_commands");
    expect(commands.data.commands.some((c: RecordValue) => c.name === "remarkable")).toBe(true);
    let sessions = await listSessions();
    expect(sessions, stderr + JSON.stringify(events)).toHaveLength(1);
    const oldEndpoint = sessions[0]!;
    const tablet = new Tablet({ ...defaults, url: mock.url });
    const document = selectDocument(await Effect.runPromise(tablet.listAll()), "notebook-1");
    const artifact = await Effect.runPromise(fetchNotes(tablet, document));
    await sendArtifact(oldEndpoint, artifact);
    let messages = (await rpc("get_messages")).data.messages as RecordValue[];
    const note = messages.find(m => m.customType === "remarkable-notes");
    expect(note, stderr + JSON.stringify(events)).toBeDefined();
    expect(note!.content.some((c: RecordValue) => c.type === "image" && c.mimeType === "image/png")).toBe(true);
    expect(note!.details.artifact.pdfPath).toBe(artifact.pdfPath);
    expect(events.filter(e => e.type === "agent_start")).toHaveLength(0);
    expect((await rpc("prompt", { message: "/remarkable select Demo notebook" })).data.disposition).toBe("handled");
    await rpc("prompt", { message: "/remarkable watch" });
    await new Promise(resolve => setTimeout(resolve, 700));
    await rpc("new_session");
    sessions = await listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.sessionId).not.toBe(oldEndpoint.sessionId);
    await expect(sendArtifact(oldEndpoint, artifact)).rejects.toThrow();
    messages = (await rpc("get_messages")).data.messages;
    expect(messages.some(m => m.customType === "remarkable-notes")).toBe(false);
    const newEndpoint = selectSession(sessions, sessions[0]!.sessionId);
    await sendArtifact(newEndpoint, artifact);
    messages = (await rpc("get_messages")).data.messages;
    expect(messages.some(m => m.customType === "remarkable-notes")).toBe(true);
    expect(events.filter(e => e.type === "agent_start")).toHaveLength(0);
    expect(events.filter(e => e.type === "extension_error")).toEqual([]);
  } finally {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(new Error("Test ended")); }
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
      await exited;
      clearTimeout(kill);
    }
    await mock.close();
    await home.close();
  }
}, 30000);
