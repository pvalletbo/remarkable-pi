# Testing checklist

## Automated (no tablet, network access, or model call)

After dependency installation:

```sh
bun install --frozen-lockfile --ignore-scripts
bun run verify
bun audit
bun run demo -- --once

# Optional: verify an existing Node-hosted pi too (requires Node 22.19+).
bun run test:pi-node
```

Tests use Bun's built-in `bun:test` runner. The default pi integration test starts an isolated, offline Bun-hosted pi RPC subprocess with a dummy API key, no tools, no user configuration, and no ordinary model prompts. It verifies extension discovery, authenticated CLI delivery, real PNG content in conversation messages, watching, session replacement, and receiver cleanup. It asserts no `agent_start` events occur. Storage is temporary and removed after the tests.

The `test`/`verify` scripts build `dist/` because PDF rendering launches a real compiled worker under Bun. If invoking `bun test` directly, run `bun run build` first. The `test:pi-node` command runs the same integration test with pi hosted by Node while keeping the PDF worker on Bun; CI runs both host variants. Bun's eager promise matchers are not used to capture still-pending cancellation/concurrency requests, so those tests can reach their abort/release steps. This also verifies the entry points users will run, rather than mocking the rendering library.

## Manual USB acceptance — not yet physically verified

Record your OS, Bun/pi versions (and Node version if hosting pi with Node) and tablet firmware when testing.

1. Browser opens `http://10.11.99.1` with the tablet unlocked/interface enabled.
2. CLI `doctor` and `list` work; nested notebooks appear with correct names/IDs.
3. `/remarkable select` chooses a dedicated short notebook.
4. Draw text, a diagram and an arrow. Leave the notebook to save.
5. `/remarkable pull` preserves all pages in the saved PDF. Open that file in a normal PDF viewer and compare it to the tablet.
6. Pi displays page images (or their paths if terminal images are unavailable).
7. An image-capable model accurately describes the handwriting/diagram when explicitly asked. This is a model call; hosted-provider privacy/cost applies.
8. `/remarkable watch` initially attaches once, then new saved writing arrives. It does not flood unchanged pages.
9. Unplug USB: watcher reports a connectivity problem, not a successful empty note.
10. Reconnect, unlock and re-enable the interface: changes arrive after retry backoff (up to 60 seconds).
11. `/remarkable stop` stops polling.
12. Open two pi sessions; CLI refuses to guess without an explicit session. Send to one and verify only that conversation receives it.
13. Start a fresh session while watching: the old watcher stops; no notes leak into the new session. CLI watchers pinned to the old instance must fail/retry, not follow it.
14. Reload/resume: selected notebook and mode persist on the active branch, but polling requires explicit restart.

## Manual wireless acceptance (optional)

1. USB acceptance passes first.
2. Built-in SSH over LAN works with host-key verification.
3. `tunnel <wifi-ip>` and `doctor --url http://127.0.0.1:8088` reach the existing web server.
4. Remove the USB data connection. If `doctor` fails, document this firmware limitation and return to USB. Do not install or patch anything as part of this test.
5. Close the tunnel and verify no listener/process remains.

## Known untested environments

Physical reMarkable firmware/USB networking; macOS native canvas and sockets; network forwarding to a remote pi host; cable-free stock-firmware behavior; long/complex real notebooks; vision-model handwriting quality. The automated suite was run on Linux x64, Bun 1.4.2, and pi 0.99.1, with a separate compatibility run using Node 22 to host pi.
