import { createServer, request } from "node:http";
import type { IncomingMessage } from "node:http";
import { mkdtemp, readFile, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { atomicWrite, paths, privateDirectory } from "./config.js";
import type { Artifact } from "./artifacts.js";
import { errorMessage } from "./errors.js";
import { validateId } from "./tablet.js";

export interface SessionEndpoint {
  instanceId: string;
  sessionId: string;
  cwd: string;
  name?: string;
  pid: number;
  socketPath: string;
  token: string;
  startedAt: string;
}
export type PublicEndpoint = Omit<SessionEndpoint, "token" | "socketPath">;

export function publicEndpoint(endpoint: SessionEndpoint): PublicEndpoint {
  const { token: _token, socketPath: _path, ...rest } = endpoint;
  return rest;
}

export function validateArtifact(value: unknown): Artifact {
  if (!value || typeof value !== "object") throw new Error("Missing artifact");
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || typeof raw.hash !== "string" || !/^[a-f0-9]{64}$/.test(raw.hash) || typeof raw.name !== "string" || raw.name.length > 1000) throw new Error("Invalid artifact");
  validateId(raw.id);
  return {
    id: raw.id, hash: raw.hash, name: raw.name,
    // Never accept a caller-supplied filesystem path.
    pdfPath: join(paths().exportsDir, raw.id, raw.hash, "notes.pdf"),
    receivedAt: typeof raw.receivedAt === "string" ? raw.receivedAt.slice(0, 100) : new Date().toISOString(),
  };
}

async function readJson(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error("IPC request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function startReceiver(
  info: { sessionId: string; cwd: string; name?: string },
  receive: (artifact: Artifact, signal: AbortSignal) => Promise<void>,
) {
  await privateDirectory(paths().sessionsDir);
  const directory = await mkdtemp(join(tmpdir(), "remarkable-pi-"));
  await chmod(directory, 0o700);
  const endpoint: SessionEndpoint = {
    ...info, instanceId: randomUUID(), pid: process.pid,
    socketPath: join(directory, "bridge.sock"), token: randomBytes(32).toString("hex"),
    startedAt: new Date().toISOString(),
  };
  const registry = join(paths().sessionsDir, `${endpoint.instanceId}.json`);
  let closed = false;
  let receiving = false;
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    const reply = (status: number, data: unknown) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    try {
      const auth = req.headers.authorization ?? "";
      const expected = `Bearer ${endpoint.token}`;
      if (auth.length !== expected.length || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) return reply(401, { error: "Unauthorized" });
      if (closed) return reply(410, { error: "Session closed" });
      if (req.method === "GET" && req.url === "/status") return reply(200, publicEndpoint(endpoint));
      if (req.method !== "POST" || req.url !== "/deliver") return reply(404, { error: "Not found" });
      if (receiving) return reply(409, { error: "A PDF delivery is already in progress; retry shortly" });
      const body = await readJson(req) as Record<string, unknown>;
      if (body.sessionId !== endpoint.sessionId) return reply(409, { error: "Target session changed; select it again" });
      const artifact = validateArtifact(body.artifact);
      if (receiving || closed) return reply(409, { error: "Receiver unavailable; retry shortly" });
      receiving = true;
      const controller = new AbortController();
      const disconnected = () => { if (!res.writableEnded) controller.abort(); };
      res.on("close", disconnected);
      try {
        await receive(artifact, controller.signal);
        if (closed) return reply(410, { error: "Session closed during delivery" });
        reply(200, { ok: true, sessionId: endpoint.sessionId, hash: artifact.hash });
      } finally { res.off("close", disconnected); receiving = false; }
    } catch (error) { if (!res.headersSent) reply(400, { error: errorMessage(error) }); else res.end(); }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(endpoint.socketPath, () => { server.off("error", reject); resolve(); }); });
    await chmod(endpoint.socketPath, 0o600);
    await atomicWrite(registry, JSON.stringify(endpoint, null, 2) + "\n");
  } catch (error) {
    server.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    endpoint,
    async close() {
      if (closed) return;
      closed = true;
      await rm(registry, { force: true });
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function ipcRequest(endpoint: SessionEndpoint, route: "status" | "deliver", body?: unknown, timeoutMs = 75000, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = request({
      socketPath: endpoint.socketPath, path: `/${route}`, method: body ? "POST" : "GET", signal,
      headers: { authorization: `Bearer ${endpoint.token}`, "content-type": "application/json" },
    }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => { text += chunk; if (text.length > 16384) req.destroy(new Error("IPC response too large")); });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const result = JSON.parse(text) as Record<string, unknown>;
          if (res.statusCode !== 200) throw new Error(String(result.error ?? `IPC HTTP ${res.statusCode}`));
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("Session delivery timed out")), timeoutMs);
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

export async function listSessions(): Promise<SessionEndpoint[]> {
  let files: string[];
  try { files = await readdir(paths().sessionsDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: SessionEndpoint[] = [];
  await Promise.all(files.filter(f => /^[a-f0-9-]+\.json$/.test(f)).map(async file => {
    try {
      const endpoint = JSON.parse(await readFile(join(paths().sessionsDir, file), "utf8")) as SessionEndpoint;
      if (typeof endpoint.socketPath !== "string" || typeof endpoint.token !== "string" || typeof endpoint.sessionId !== "string") return;
      const status = await ipcRequest(endpoint, "status", undefined, 800) as PublicEndpoint;
      if (status.instanceId === endpoint.instanceId && status.sessionId === endpoint.sessionId) result.push(endpoint);
    } catch { /* Stale/crashed sessions are not targets. */ }
  }));
  return result.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
}

export function selectSession(sessions: SessionEndpoint[], selector?: string): SessionEndpoint {
  const target = selector || process.env.PI_SESSION_ID;
  if (target) {
    const exactInstance = sessions.find(s => s.instanceId === target);
    if (exactInstance) return exactInstance;
    const matches = sessions.filter(s => s.sessionId === target || s.sessionId.startsWith(target) || s.instanceId.startsWith(target));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error("Ambiguous session. Use the instance ID from sessions.");
    throw new Error("Target session is not running with the extension. Load it and run /reload, then list sessions.");
  }
  if (sessions.length === 1) return sessions[0]!;
  if (!sessions.length) throw new Error("No live pi receivers. Load the extension in pi first.");
  throw new Error("Multiple pi sessions are running. Pass --session <session ID or instance ID>; refusing to guess.");
}

export async function sendArtifact(endpoint: SessionEndpoint, artifact: Artifact, timeoutMs?: number, signal?: AbortSignal) {
  return ipcRequest(endpoint, "deliver", { sessionId: endpoint.sessionId, artifact }, timeoutMs, signal);
}
