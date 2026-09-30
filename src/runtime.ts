/** Resolve Bun even when the extension is loaded by a Node-hosted pi process. */
export function bunExecutable(): string {
  return process.env.REMARKABLE_PI_BUN || (process.versions.bun ? process.execPath : "bun");
}
