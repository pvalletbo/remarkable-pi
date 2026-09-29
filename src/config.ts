import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export interface Config {
  url: string;
  pollIntervalMs: number;
  settleMs: number;
  exportIntervalMs: number;
  timeoutMs: number;
  maxPdfBytes: number;
  maxPages: number;
  maxImageEdge: number;
}

export const defaults: Config = {
  url: "http://10.11.99.1",
  pollIntervalMs: 5000,
  settleMs: 1500,
  // Some firmware omits change metadata. Re-export periodically and hash content.
  exportIntervalMs: 30000,
  timeoutMs: 60000,
  maxPdfBytes: 50 * 1024 * 1024,
  maxPages: 8,
  maxImageEdge: 1600,
};

export function paths() {
  // One override keeps demos/tests completely separate from personal state.
  const home = process.env.REMARKABLE_PI_HOME;
  const configDir = home ? resolve(home, "config") : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "remarkable-pi");
  const dataDir = home ? resolve(home, "data") : join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "remarkable-pi");
  return { configDir, dataDir, configFile: join(configDir, "config.json"), sessionsDir: join(dataDir, "sessions"), exportsDir: join(dataDir, "exports") };
}

export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export async function atomicWrite(path: string, data: string | Uint8Array) {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, data, { mode: 0o600, flag: "wx" });
  try { await rename(temp, path); }
  catch (error) {
    const { unlink } = await import("node:fs/promises");
    await unlink(temp).catch(() => {});
    throw error;
  }
}

export function validateConfig(value: unknown): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Config must be an object");
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown config key: ${key}`);
  const config = { ...defaults, ...input } as Config;
  if (typeof config.url !== "string") throw new Error("url must be a string");
  const url = new URL(config.url);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("url must be an HTTP(S) origin without credentials, path, query or fragment");
  }
  const bounds: Record<Exclude<keyof Config, "url">, [number, number]> = {
    pollIntervalMs: [1000, 600000], settleMs: [0, 60000], exportIntervalMs: [5000, 3600000],
    timeoutMs: [1000, 300000], maxPdfBytes: [1024, 100 * 1024 * 1024], maxPages: [1, 32], maxImageEdge: [400, 2400],
  };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    const n = config[key as keyof typeof bounds];
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  }
  config.url = url.origin;
  return config;
}

export async function loadConfig(): Promise<Config> {
  let data: string;
  try { data = await readFile(paths().configFile, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...defaults };
    throw error;
  }
  return validateConfig(JSON.parse(data));
}

export async function saveConfig(update: Partial<Config>) {
  const config = validateConfig({ ...await loadConfig(), ...update });
  await privateDirectory(paths().configDir);
  await atomicWrite(paths().configFile, JSON.stringify(config, null, 2) + "\n");
  return config;
}
