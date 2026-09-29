import { afterEach, beforeEach, expect, it } from "vitest";
import { Effect } from "effect";
import { stat } from "node:fs/promises";
import { storePdf } from "../src/artifacts.js";
import { ipcRequest, listSessions, selectSession, sendArtifact, startReceiver, validateArtifact } from "../src/ipc.js";
import { isolatedHome, samplePdf } from "./helpers.js";
import { once } from "node:events";

let home: Awaited<ReturnType<typeof isolatedHome>>;
let receivers: Awaited<ReturnType<typeof startReceiver>>[];
let previousSession: string | undefined;
beforeEach(async () => { home = await isolatedHome(); receivers = []; previousSession = process.env.PI_SESSION_ID; delete process.env.PI_SESSION_ID; });
afterEach(async () => {
  for (const receiver of receivers) await receiver.close();
  if (previousSession === undefined) delete process.env.PI_SESSION_ID; else process.env.PI_SESSION_ID = previousSession;
  await home.close();
});

it("discovers live authenticated Unix-socket receivers and sends only to the chosen session", async () => {
  const received: string[] = [];
  const first = await startReceiver({ sessionId: "session-one", cwd: "/project/one" }, async artifact => { received.push(`one:${artifact.hash}`); });
  const second = await startReceiver({ sessionId: "session-two", cwd: "/project/two" }, async artifact => { received.push(`two:${artifact.hash}`); });
  receivers.push(first, second);
  const sessions = await listSessions();
  expect(sessions).toHaveLength(2);
  expect(() => selectSession(sessions)).toThrow("Multiple");
  expect(selectSession(sessions, "session-t").cwd).toBe("/project/two");
  expect(() => selectSession(sessions, "session-")).toThrow("Ambiguous");
  process.env.PI_SESSION_ID = "session-one";
  expect(selectSession(sessions).sessionId).toBe("session-one");
  const artifact = await Effect.runPromise(storePdf("notes", "Notes", samplePdf()));
  await sendArtifact(second.endpoint, artifact);
  expect(received).toEqual([`two:${artifact.hash}`]);
  expect((await stat(second.endpoint.socketPath)).mode & 0o777).toBe(0o600);
  await first.close();
  expect(await listSessions()).toHaveLength(1);
});

it("rejects unauthorized requests, changed targets, and filesystem-path injection", async () => {
  const receiver = await startReceiver({ sessionId: "target", cwd: "/project" }, async () => {});
  receivers.push(receiver);
  await expect(ipcRequest({ ...receiver.endpoint, token: "wrong" }, "status")).rejects.toThrow("Unauthorized");
  await expect(ipcRequest(receiver.endpoint, "deliver", { sessionId: "other" })).rejects.toThrow("Target session changed");
  expect(() => validateArtifact({ id: "../../etc", hash: "a".repeat(64), name: "foo" })).toThrow();
  expect(() => validateArtifact({ id: "notes", hash: "../passwd", name: "foo" })).toThrow();
  const artifact = validateArtifact({ id: "notes", hash: "a".repeat(64), name: "foo", pdfPath: "/etc/passwd" });
  expect(artifact.pdfPath).not.toBe("/etc/passwd");
});

it("propagates client cancellation into a pending delivery", async () => {
  let started = false;
  let cancelled = false;
  const receiver = await startReceiver({ sessionId: "cancel-target", cwd: "/project" }, async (_artifact, signal) => {
    started = true;
    await once(signal, "abort");
    cancelled = true;
    throw new Error("Cancelled before submission");
  });
  receivers.push(receiver);
  const artifact = await Effect.runPromise(storePdf("notes", "Notes", samplePdf()));
  const controller = new AbortController();
  const request = sendArtifact(receiver.endpoint, artifact, 10000, controller.signal);
  const failure = expect(request).rejects.toThrow();
  for (let tries = 0; !started && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(started).toBe(true);
  controller.abort();
  await failure;
  for (let tries = 0; !cancelled && tries < 100; tries++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(cancelled).toBe(true);
});

it("does not acknowledge failed deliveries and rejects concurrent work", async () => {
  let release: (() => void) | undefined;
  const receiver = await startReceiver({ sessionId: "target", cwd: "/project" }, () => new Promise<void>((_resolve, reject) => { release = () => reject(new Error("render failed")); }));
  receivers.push(receiver);
  const artifact = await Effect.runPromise(storePdf("notes", "Notes", samplePdf()));
  const first = sendArtifact(receiver.endpoint, artifact);
  const firstFailure = expect(first).rejects.toThrow("render failed");
  await new Promise(resolve => setTimeout(resolve, 30));
  await expect(sendArtifact(receiver.endpoint, artifact)).rejects.toThrow("already in progress");
  release!();
  await firstFailure;
});
