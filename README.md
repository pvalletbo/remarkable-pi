# reMarkable → pi

Share handwritten notes and drawings from a **stock reMarkable 2** with the current, or a specifically chosen, running [pi](https://pi.dev) agent session.

**Local bridge. One direction. No flashing, cloud account, Connect subscription, tablet packages, uploads, or deletes.** The tablet's own web interface exports a PDF; your computer saves it and renders page images locally. A pi extension attaches the PDF's local path and the page images to the conversation.

> **Status:** working prototype, tested with a simulated stock web API **and a real offline pi subprocess**. No physical reMarkable was available during development, so the first USB test on your firmware is still needed. The USB web API is undocumented and may vary between firmware versions. Wireless is conditional; see below.

## First test — about five minutes

Requirements: **Node.js 22.19+**, npm, pi, and Linux or macOS. Windows/WSL has not been tested; native Windows Unix-socket delivery is not supported. The computer running this bridge must be able to reach the tablet. Download dependencies once; normal operation does not need internet access.

### 1. Build and load

```sh
cd /home/ai-agent/git/remarkable-pi   # or wherever you cloned it
npm ci --ignore-scripts
npm run build

# Install the local package for your pi sessions:
pi install "$PWD"
```

In an **already running pi session**, run `/reload` after installing. Or try it in a new session without installing:

```sh
pi -e ./extensions/remarkable.ts
```

Do not resume the same session in two pi processes. The CLI will refuse ambiguous targets rather than guess.

### 2. Enable the tablet's stock interface

1. Connect the reMarkable to **this computer** with a USB **data** cable.
2. Unlock the tablet. Open **Settings → Storage** and turn on **USB web interface**. Menu wording can vary by firmware.
3. Open `http://10.11.99.1` in your computer's browser. You should see your notebooks. This is the tablet, not an internet service.
4. Create a short notebook such as **Agent notes**. Write/draw something, then return to the notebook overview to make sure it is saved.

### 3. Choose the notebook inside pi

```text
/remarkable doctor
/remarkable select
/remarkable pull
```

Choose the notebook from the list. You should see a received-notes message with a local PDF path and page images. Ask pi: **“Read the reMarkable notes I just shared and summarize them.”** Use an image-capable model to read handwriting.

For automatic updates:

```text
/remarkable watch
```

Write another note, let it save (closing/reopening the notebook can help), and wait a few seconds. The watcher exports once immediately, checks metadata every 5 seconds, and re-exports at least every 30 seconds when metadata is absent. Temporary disconnects retry with backoff.

```text
/remarkable stop
```

This stops polling, not the explicit local CLI receiver. Exiting pi or unloading the extension closes the receiver too. There is **no background daemon**.

### Attach versus wake the agent

The default **attach** mode adds reference material without making a model call or starting agent work. While an agent is busy, pi appends it safely at the end of the turn.

```text
/remarkable mode ask
```

**Ask** starts a turn when idle, or queues a follow-up when busy. This can incur model costs and agent actions. Switch back with `/remarkable mode attach`.

**Privacy boundary:** transfers, PDF rendering, and session routing are local. If pi uses a hosted model, the notes/images will be sent to that provider when included in a model request. For an entirely local system, configure pi with an image-capable local model. This bridge does not provide a model or OCR service.

## Commands inside pi

| Command | Action |
| --- | --- |
| `/remarkable select` | Choose exactly one notebook; never watches your whole library |
| `/remarkable select Agent notes` | Select an exact name; full `/folder/name` or document ID also works |
| `/remarkable pull` | Export and attach once |
| `/remarkable watch` | Export now and poll changes for this session |
| `/remarkable stop` | Stop polling |
| `/remarkable mode attach` | Attach as reference context, no turn (default) |
| `/remarkable mode ask` | Start/queue a follow-up turn for each update |
| `/remarkable import /path/notes.pdf` | Share an existing local PDF; spaces allowed without quotes |
| `/remarkable url http://127.0.0.1:8088` | Save a different tablet origin and stop the current watcher |
| `/remarkable doctor` | Check the stock API |
| `/remarkable status` | Show notebook, delivery mode, session/receiver IDs and last error |
| `/remarkable help` | Show command help |

Selection and delivery mode are saved in the **active pi session branch**. Polling is deliberately **not** restarted on reload, resume, fork, new session, or tree navigation. Run `watch` again when you are ready. An in-flight operation is cancelled during session replacement; an external watcher remains pinned to its original receiver and never silently follows a new session.

The stock API cannot identify the currently open notebook. “Current” means the **pi session where you run the command**; choose the notebook once.

## CLI: send to a desired running session

The CLI does not edit pi's JSONL files or type into a terminal. Each extension instance has an authenticated, owner-only Unix-domain socket, registered locally while that session is running.

```sh
node dist/cli.js doctor
node dist/cli.js list
node dist/cli.js fetch 'Agent notes'     # save PDF only; no session needed
node dist/cli.js sessions

node dist/cli.js send 'Agent notes' --session <session-id-or-unique-prefix>
node dist/cli.js watch 'Agent notes' --session <session-id-or-unique-prefix>
node dist/cli.js import ./notes.pdf --session <session-id-or-unique-prefix>
```

`--session` can also specify an **instance ID**, useful if the same session was accidentally opened twice. Without the flag, `PI_SESSION_ID` targets the current session when invoked from pi's shell. Otherwise a single live receiver is selected; multiple receivers produce an error. The receiver's current `attach`/`ask` setting applies to CLI deliveries.

`--url http://...` overrides the tablet origin for one command. `--json` provides machine-readable results (watch emits a JSON record per delivery). `/remarkable url` and CLI `config set url` save an origin for future commands. A running watcher uses the configuration it started with; stop/start it after config changes.

## Wireless: optional, stock-firmware dependent

First get USB working. The project can forward the **existing stock web interface** over the tablet's built-in SSH connection; it **does not** enable services, modify network settings, install software, or patch firmware.

1. Put the tablet and bridge computer on the same trusted LAN.
2. Find the tablet's Wi-Fi IP and built-in SSH password in its device information/copyright/licensing screen (location varies). Use the **reMarkable 2's existing SSH access**, not instructions for enabling developer mode on newer tablets.
3. Keep the USB web interface enabled. Run:

```sh
node dist/cli.js tunnel 192.168.1.123
# Uses your OpenSSH client. Inspect/confirm its host key; enter the tablet's password.
# Keep this terminal open. It forwards only on computer loopback, port 8088.
```

Then inside pi:

```text
/remarkable url http://127.0.0.1:8088
/remarkable doctor
/remarkable watch
```

**Important limitation:** some stock firmware removes `10.11.99.1`, stops the interface, or disables SSH/Wi-Fi when USB is unplugged or the tablet sleeps. A tunnel cannot resurrect an unavailable web interface. If that happens, use USB; the project intentionally does **not** install “webinterface-onboot”, edit startup scripts, or run privileged network commands to force wireless. You can test whether your firmware keeps the web interface alive with USB power, but charging alone is not guaranteed to do so. Fully cable-free operation is **not promised**.

SSH passwords/keys are managed by OpenSSH, never stored in this project's configuration. Ctrl-C stops the tunnel. Return to `/remarkable url http://10.11.99.1` for direct USB.

### If pi runs on a different machine

If your session runs on a server but the tablet is plugged into your laptop, the server cannot directly see the laptop's USB network. From the **laptop**, you can forward that connection to the pi server:

```sh
ssh -N -T -o ExitOnForwardFailure=yes \
  -R 127.0.0.1:8088:10.11.99.1:80 your-user@your-pi-server
```

Keep the tunnel open, and use `/remarkable url http://127.0.0.1:8088` **on the server**. Use your own trusted SSH server; forwarding must be allowed and restricted to loopback (`GatewayPorts no`). The tablet is not modified. This remains point-to-point/local infrastructure, not a hosted bridge service. USB on the laptop is still required.

## Test without a tablet

```sh
npm run verify                 # build, typecheck, full tests (no model calls)
npm run demo -- --once          # generate a vector/text PDF and render it locally
npm run demo                   # interactive simulated tablet on localhost
```

The interactive demo prints an isolated `REMARKABLE_PI_HOME=... pi -e ...` command for a second terminal. Run `select Demo notebook`, then `watch` inside that pi session. In the demo terminal, `n` simulates new notes, `d` disconnects, `r` reconnects, and `q` quits. Demo data lives only in ignored `.demo/`, not your personal configuration. No agent turn is started unless you explicitly choose `ask` or send a normal prompt.

Tests exercise the stock routes, nested folders, real PDF rendering, size limits, private permissions, duplicate names, timestamp-only exports, absent change metadata, reconnects, retry after failed delivery, Unix-socket authentication, routing ambiguity, and **loading/delivery/session replacement in a real pi RPC subprocess running offline**.

## Configuration and storage

```sh
node dist/cli.js config
node dist/cli.js config set maxPages 4
node dist/cli.js config set exportIntervalMs 15000
```

Defaults:

| Key | Default | Purpose |
| --- | ---: | --- |
| `url` | `http://10.11.99.1` | Tablet HTTP(S) origin |
| `pollIntervalMs` | `5000` | Metadata polling |
| `settleMs` | `1500` | Debounce revision changes |
| `exportIntervalMs` | `30000` | Fallback PDF check without metadata |
| `timeoutMs` | `60000` | HTTP/export/render deadline |
| `maxPdfBytes` | `52428800` | Maximum PDF size (50 MiB) |
| `maxPages` | `8` | Last N pages to preview, maximum 32 |
| `maxImageEdge` | `1600` | Maximum page-image dimension |

- Config: `~/.config/remarkable-pi/config.json`.
- PDFs, images and session registrations: `~/.local/share/remarkable-pi/`.
- Standard `XDG_CONFIG_HOME` / `XDG_DATA_HOME` overrides are respected.
- `REMARKABLE_PI_HOME=/some/directory` isolates both under that directory (use the same value in pi and the CLI).
- Directories are `0700`, files and sockets `0600`. IPC tokens are not printed by `sessions`.
- Each PDF is immutable/content-addressed: `exports/<document-id>/<sha256>/notes.pdf`. Notebook names are display metadata, never filesystem paths.
- **There is no automatic retention cleanup in v0.1.** Repeated exports can accumulate, especially if firmware changes PDF timestamps. Stop watchers before manually deleting old `exports/` directories. A resumed pi transcript retains embedded preview images, but old PDF/PNG paths will stop working if you delete them. Crashed receivers leave harmless stale registry files; `sessions` only returns live authenticated instances.

## Limits and troubleshooting

- **Use a short, dedicated notebook initially.** The complete PDF is downloaded, but only the **last N pages** are attached as images and have embedded text extracted. The agent is told exactly which pages it has seen. Raise `maxPages` if needed; long notebooks can be expensive in model context.
- Handwriting stays as pixels/vectors. No local handwriting-to-text OCR is claimed. A vision model can read the rendered images; embedded typed PDF text is extracted separately.
- Metadata changes trigger an export after settling. Without metadata, the bridge periodically downloads and compares PDF hashes and visible preview hashes. Timestamp-only exports are suppressed. If firmware supplies **no metadata** and you edit a page **outside the preview range**, automatic delivery may not notice that edit; `pull` always sends a fresh full-PDF path. Keep the notebook within `maxPages` for reliable initial tests.
- **Browser cannot open `10.11.99.1`:** unlock the tablet, toggle its USB interface, check that the cable carries data and the USB network appears in your OS. VPNs/routes/proxies can interfere. No tablet connection was available here to validate your OS's USB driver.
- **Changes not arriving:** the notebook may still be open/unsaved; leave it, wait, and try `pull`. Polling cannot force a tablet save. Sleep/lock may disconnect the API; the watcher retries.
- **Notebook moved/deleted:** reselect it. The watcher refuses to send a replacement notebook.
- **No images:** choose an image-capable pi model and ensure `images.blockImages` is false. Terminal inline image support affects display only; local PNG paths are still available.
- **Renderer failure:** rebuild, check Node version/native canvas platform support, and try `npm run demo -- --once`. Parsing runs in a bounded-time subprocess, not on pi's event loop. Very large/complex/malformed PDFs may still exceed memory; the byte/page limits are not a hardened sandbox.
- **No live receiver:** run `/reload` after installation; check `/remarkable status`. The CLI and pi must use the same OS user and storage environment.
- **Unmount/uninstall:** stop polling, run `pi remove /absolute/path/to/remarkable-pi`, then `/reload`. You can separately remove the project's config/cache after reviewing what you want to keep. Nothing was installed on the tablet.

## Implementation

TypeScript with **Effect v4** (pinned release candidate `4.0.0-rc.118`), native `fetch`, PDF.js, and prebuilt `@napi-rs/canvas` binaries. The Effect pipeline handles failures, interruptible sequential polling, and backoff; a subprocess isolates PDF rendering. The pi extension is the session-scoped owner of polling and IPC resources.

See [architecture](docs/architecture.md), [protocol notes and sources](docs/protocol.md), and [test checklist](docs/testing.md). MIT licensed.
