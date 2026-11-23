# Handoff

State of `feat/hardening`. Runtime: Bun 1.4.5 (`bun src/server.ts`, `--daemon` for the HTTP daemon on `Bun.serve`); there is no Node runtime path any more. The tool set is 28 tools after consolidating 43 (one noun per tool, modes as parameters, no aliases for the old names); clients see the new list after they reconnect. Code is grouped by feature under `src/` (see the project layout in the README). Tests run on `bun:test` with msw for HTTP boundaries. CI (`.github/workflows/ci.yml`) runs `bun run check` and the Playwright-engine e2e on pull requests.

Gates on Bun 1.4.5 (2026-11-21, after the final review fixes): `bun run check` exit 0 (oxfmt, oxlint `--deny-warnings` with no disable comments, `tsc`, unit 513/513, e2e patchright 300 pass + 9 skip) and `WEB_AGENT_ENGINE=playwright bun run test:e2e` 305 pass + 1 skip, 0 fail; `bun test src` three times in a row 513/513 each. The skips are `skipIf` cases that do not apply to the engine: console-hook cases that need page-call capture (patchright) and one patchright-only case (playwright).

## Recording

`recording` (src/browser/recording.ts, src/tools/recording.ts) records a tab to mp4 through the system ffmpeg; see the README section. Covered by `src/browser/recording.spec.ts` (frame timing, ffmpeg arguments, the recording life cycle with the screencast and ffmpeg mocked) and `e2e/recording.spec.ts` on both engines (headless; the background-tab case brings another tab to the front). A headed run with the recorded tab behind the user's tab was not part of the test suite.

## Downloads

Downloads are saved by src/browser/tab-watch.ts into the folder src/browser/downloads.ts picks (Chrome's `download.default_directory` from `<profile>/Default/Preferences`, read again for each download; else `XDG_DOWNLOAD_DIR` from `user-dirs.dirs`; else `~/Downloads`). A download in an unclaimed tab that no tool, script or collect run is driving is the user's and keeps its name there; every other one goes to `<folder>/agent`. Names are claimed with an exclusive create and numbered like Chrome (`name (1).ext`). `read_page` on a binary tab still writes to `output/downloads`. Covered by `src/browser/downloads.spec.ts`, `src/browser/tab-watch.spec.ts` and `e2e/downloads.spec.ts` on both engines.

## Script worker

`run_script` runs each script, foreground or background, in its own worker thread (src/script/worker.ts); src/script/host.ts is the main-thread side and src/script/wire.ts the shared message and value encoding. Calls on browser objects block the worker on an `Atomics.wait` while the main thread runs them on the real Playwright object, so synchronous methods (locator chains, `url()`, `on()`) stay synchronous; a call that returns a promise answers with a pending id that is settled by a later message. Class instances come back as handles (released when the worker's proxy is collected, counted so a handle sent again in flight survives), plain data as structured-clone copies, and functions the script passes become callbacks the main thread invokes in the worker (functions given to `evaluate`, `$eval`, `addInitScript` and `waitForFunction` are sent as source). On timeout or cancel the host aborts the script's `signal`, waits up to 200 ms for its listeners, then terminates the worker and removes what the script registered. Covered by `src/script/run.spec.ts`, `src/script/host.spec.ts` and the run_script cases in `e2e/tools-regressions.spec.ts`, `e2e/tools-flow.spec.ts`, `e2e/daemon.spec.ts` and `e2e/visual.spec.ts` on both engines.

## Deferred, with reasons

- **Async iteration over browser objects** (for example the stream of `download.createReadStream()`) is not bridged; a script reads such data with `download.path()` or `saveAs()` instead. `fetch` runs inside the worker, so its bodies iterate as usual.
- **Cyclic plain values** cannot be passed between the script and the browser objects; they fail with a stack overflow error.
- **exposeFunction with patchright** never calls the function from the page (patchright limitation, also outside scripts); the e2e case for it runs on the Playwright engine only.

- **routeWebSocket** registrations made by a script cannot be removed when the script ends; Playwright has no API for it.
- **Tool-choice eval misses.** In the 16-task eval, measured before the tool consolidation, `product-price` read the page as plain text before asking for its structured data (now both `read_page`, `format: "text"` and `format: "structured"`; the eval tasks were updated but not run again), and `staging-layout` and `figma-match` pick the right tool first but then re-read the images themselves. Descriptions are not the lever there.
- **Logger after a long stall.** After an event-loop stall of about 10 s the log write timer fires late, reports one failed write and only counts later failures.
- **ERR_BLOCKED_BY_ADMINISTRATOR** policy lookup is covered by unit tests only; reproducing it end to end needs a policy file under `/etc`.
- **Auto-consent** clicks inside consent containers only; a site with an unusual banner structure may still need `dismiss_overlays` or a click.
- **Background throttling flags** (`--disable-background-timer-throttling`, `--disable-renderer-backgrounding`) stay on because agent work in background tabs depends on them; they cost CPU when many user tabs are open in the shared browser.

## Deploy

The live daemon (`~/.config/web-agent-mcp`, systemd user unit `claude-code-pair-web-agent.service`) still runs an older commit on Node; deploying this branch is left to the owner. `~/code/notes/web-agent-deploy.sh [ref]` (default `feat/hardening`) deploys the committed tree, not the working tree:

1. It extracts `src` and `skills` of the ref (without spec files) plus `package.json` and `bun.lock` into a staging folder next to the target and runs `bun install --frozen-lockfile --production` there. `WEB_AGENT_DEPLOY_STAGE_ONLY=1` stops after this step; `WEB_AGENT_DEPLOY_TARGET` deploys to another folder.
2. It stops the service, moves the current tree aside, moves the staged tree in, starts the service and waits for `http://127.0.0.1:29741/healthz`.
3. If any step fails after the swap, it restores the previous tree and starts the service again.
4. It copies `skills/web-agent-browser/SKILL.md` to `~/.claude/skills/web-agent-browser/SKILL.md`.

Before the first deploy of this branch, change the unit (back it up first): `ExecStart` currently runs `/usr/bin/node src/server.ts --daemon` and must run `/home/cemalturkcan/.bun/bin/bun src/server.ts --daemon` (bun is not on the systemd PATH), then `systemctl --user daemon-reload`. The first Bun deploy also leaves npm leftovers in the target (`package-lock.json`); remove them by hand. Restarting the daemon closes every tab of the agent Chrome.

## Not done by the hardening run

- **claude-code-pair** keeps its local commits and an older submodule pin; the owner no longer uses it.
