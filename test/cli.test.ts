import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { startReceiver } from "../src/ipc.js";
import { isolatedHome, mockTablet } from "./helpers.js";

const execute = promisify(execFile);

it("runs the compiled CLI against the stock mock API and targets an explicit live receiver", async () => {
  const home = await isolatedHome();
  const mock = await mockTablet();
  const received: string[] = [];
  const receiver = await startReceiver({ sessionId: "cli-target", cwd: "/example" }, async artifact => { received.push(artifact.name); });
  const env = { ...process.env };
  delete env.PI_SESSION_ID;
  const cli = (...args: string[]) => execute(process.execPath, [resolve("dist/cli.js"), ...args], { env });
  try {
    const doctor = JSON.parse((await cli("doctor", "--url", mock.url, "--json")).stdout);
    expect(doctor.runtime).toBe("bun");
    expect(doctor.bunVersion).toBe(process.versions.bun);
    const list = JSON.parse((await cli("list", "--url", mock.url, "--json")).stdout);
    expect(list.some((d: { name: string }) => d.name === "Demo notebook")).toBe(true);
    const sessions = JSON.parse((await cli("sessions", "--json")).stdout);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].token).toBeUndefined();
    expect(sessions[0].socketPath).toBeUndefined();
    const fetched = JSON.parse((await cli("fetch", "Demo notebook", "--url", mock.url, "--json")).stdout);
    expect(fetched.pdfPath).toMatch(/notes\.pdf$/);
    expect(received).toHaveLength(0);
    const sent = JSON.parse((await cli("send", "Demo notebook", "--url", mock.url, "--session", "cli-target", "--json")).stdout);
    expect(sent.sessionId).toBe("cli-target");
    expect(received).toEqual(["Demo notebook"]);
    await expect(cli("send", "Demo notebook", "--url", mock.url, "--session", "missing")).rejects.toThrow();
    const imported = JSON.parse((await cli("import", fetched.pdfPath, "--session", "cli-target", "--json")).stdout);
    expect(imported.id).toBe("imported");
    expect(received).toHaveLength(2);
    await expect(cli("config", "set", "maxPages", "999")).rejects.toThrow();
    const config = JSON.parse((await cli("config", "set", "maxPages", "3", "--json")).stdout);
    expect(config.config.maxPages).toBe(3);
  } finally { await receiver.close(); await mock.close(); await home.close(); }
});
