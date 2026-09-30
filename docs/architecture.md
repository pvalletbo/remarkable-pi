# Architecture

```text
Stock reMarkable 2 (USB web interface)
       │ empty-body POST /documents/<folder> (read-only listing)
       │ GET /download/<notebook>/placeholder (PDF)
       ▼
Tablet client — Effect v4 pipeline
       │ validated IDs, bounded bodies, timeouts, no redirects
       ▼
Local immutable PDF cache (owner-only permissions)
       │ Bun subprocess, deadline, low-memory mode, local assets only
       ▼
PDF.js + native canvas → last N page PNGs + embedded PDF text
       │
       ├── in-session watcher → pi ExtensionAPI
       │
       └── CLI → authenticated Unix socket → selected pi extension
                                            │
                                            ▼
                              custom context message (default)
                              or queued user follow-up (opt-in)
```

## Bun runtime and pi compatibility

The CLI has a Bun shebang. Build/typecheck commands execute TypeScript with Bun, tests use `bun:test`, and dependencies are installed from `bun.lock`. Development and demo scripts run directly as TypeScript under Bun; tsx and Vitest are no longer dependencies.

Shared modules retain `node:` imports, which Bun implements, so the extension also works inside an existing Node-hosted pi. The rendering launcher uses `src/runtime.ts` to resolve **Bun**, not blindly `process.execPath` (which is Node inside a standard pi process). `REMARKABLE_PI_BUN` can provide an explicit executable; otherwise a Bun host reuses its own executable and a Node host searches PATH for `bun`.

Bun's `fetch` automatically picks up proxy environment variables, and its released runtime can cache that proxy despite per-request disable options. The tablet client instead uses Bun's compatible `node:http`/`node:https` APIs with direct sockets and no proxy agent. Notebook requests stay on the direct USB/LAN link or the explicit SSH tunnel; regression tests check that neither listing nor PDF downloads contact an environment-configured proxy. Responses remain byte-bounded, incomplete bodies fail, request deadlines/cancellation cover the body, and redirects are never followed.

The PDF subprocess runs with `--smol`, `--no-install`, and `--no-env-file`: lower-memory behavior without runtime dependency downloads or implicit dotenv loading from pi's working directory. Bun's low-memory mode is **not a hard memory/heap cap**. The export-byte/page/image limits and process deadline remain in place. CI verifies both Bun-hosted and Node-hosted pi, but all bridge commands and PDF workers use Bun.

## No tablet writes

`src/tablet.ts` is the only tablet HTTP client. It has exactly two route families: listing and PDF download. Although the stock listing route uses POST, it does not mutate documents. No cloud API, upload route, remove route, SSH command execution, filesystem mount, or raw `.rm` format parsing is implemented.

`src/tunnel.ts` invokes the installed OpenSSH client with argument arrays (no shell). It uses `-N -T`, no remote command, host-key verification left intact, and loopback-bound forwarding to the tablet's existing web server. It cannot start that web server or keep the USB IP alive.

## Effect boundaries

Expected asynchronous failures use typed `BridgeError` values through `Effect.tryPromise`. Tablet listing/traversal, export/storage, preparation and polling compose with `Effect.gen`. Watch ticks run sequentially, so slow exports do not overlap or build a queue. `Effect.result` isolates a failed tick; retries back off without acknowledging unsuccessful delivery. Effect interruption propagates through HTTP abort signals, sleeps, and PDF subprocesses.

The pi API exposes void delivery methods. The receiver acknowledges successful local preparation and submission to pi, **not** successful model reasoning or agent completion. In attach mode, if pi is streaming, pi owns the deferred context message and appends it when that turn ends.

## Change detection

- Inspect revision fields, if present, and debounce changes.
- Export at least on a fallback interval because many firmware versions omit revision fields.
- Hash the original PDF for content-addressed storage.
- Render changed PDFs; hash the previews/text/page count.
- Deliver when preview content or trustworthy revision fields change, ignoring timestamp-only exports with identical previews and revision.
- Mark a version delivered only after the callback succeeds.

The current bounded preview is intentionally not a whole-document visual hash. An out-of-range page edit with absent revision metadata can be invisible to automatic delivery. Manual pull is unconditional. Whole-document fingerprints and explicit page selection are candidates for a later version.

## Session ownership

`extensions/remarkable.ts` starts session resources from `session_start`, not the extension factory. Shutdown aborts work and closes the receiver idempotently. A generation guard rejects delivery to a replacement session/branch after an asynchronous render. Notebook selection follows custom session entries on the active branch; watchers are never auto-resumed.

The registry identifies both logical session IDs and ephemeral instance IDs. The latter distinguishes duplicate opens of one pi session. CLI watchers hold one resolved endpoint for their entire lifetime. Session replacement deletes/closes that endpoint. A new session gets a new socket, token and instance ID; the old watcher cannot retarget itself.

The IPC server accepts only validated artifact ID/hash metadata and derives the PDF path inside its own export store. It does not accept a caller-supplied PDF path. The extension verifies the SHA-256 and size before rendering. Bearer tokens plus `0700` directories/`0600` sockets prevent other OS users from delivering notes; this is not a security boundary against another process running as the same user or a privileged user.

## Privacy and storage

All bridge data stays on the computer/tablet link. PDFs/PNGs are private files; image data is embedded in pi's session transcript for model access/replay. This means pi session files contain private note content too. Hosted pi models receive that content when it is included in a request; a local bridge is not a guarantee of local inference.

There is no backend service, always-on HTTP listener, telemetry, cloud authentication, or automatic startup service. The mock HTTP server exists only in tests/demo and binds to loopback. Renderer assets (fonts, CMaps, WASM) are loaded from installed dependencies rather than downloaded.

The PDF subprocess deadline and Bun low-memory mode protect responsiveness, but there is no hard process-memory cap, including for native canvas allocations. This is not a hardened untrusted-document sandbox. Automatic disk-cache retention is intentionally deferred; inspect and clean old exports when needed.
