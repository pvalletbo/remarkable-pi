import { spawn } from "node:child_process";

export function tunnelArgs(host: string, port = 8088): string[] {
  // No shell, remote command, device file writes, or disabled host-key checking.
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(host)) throw new Error("Use an IPv4 address or hostname, without username/options");
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Tunnel port must be between 1024 and 65535");
  return ["-N", "-T", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-L", `127.0.0.1:${port}:10.11.99.1:80`, `root@${host}`];
}

export async function runTunnel(host: string, port = 8088) {
  const args = tunnelArgs(host, port);
  console.log(`Opening read-only SSH forwarding at http://127.0.0.1:${port}. Keep this terminal open; Ctrl-C stops it.`);
  console.log("The stock USB web interface must already be enabled and reachable on the tablet; Wi-Fi alone may not keep it active.");
  const child = spawn("ssh", args, { stdio: "inherit" });
  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => code === 0 || signal === "SIGINT" ? resolve() : reject(new Error(`SSH exited (${code ?? signal})`)));
  });
}
