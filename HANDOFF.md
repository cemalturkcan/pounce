# Handoff

State of `feat/hardening`. Runtime: Bun 1.4.5 (`bun src/server.ts`, `--daemon` for the HTTP daemon on `Bun.serve`); there is no Node runtime path any more. Code is grouped by feature under `src/` (see the project layout in the README). Tests run on `bun:test` with msw for HTTP boundaries. CI (`.github/workflows/ci.yml`) runs `bun run check` and the Playwright-engine e2e on pull requests.

Gates on Bun 1.4.5 (2026-11-21, after the final review fixes): `bun run check` exit 0 (oxfmt, oxlint `--deny-warnings` with no disable comments, `tsc`, unit 513/513, e2e patchright 300 pass + 9 skip) and `WEB_AGENT_ENGINE=playwright bun run test:e2e` 305 pass + 1 skip, 0 fail; `bun test src` three times in a row 513/513 each. The skips are `skipIf` cases that do not apply to the engine: console-hook cases that need page-call capture (patchright) and one patchright-only case (playwright).

## Deferred, with reasons

- **routeWebSocket** registrations made by a script cannot be removed when the script ends; Playwright has no API for it.
- **Tool-choice eval misses.** In the 16-task eval, `product-price` still reaches `read_text` before `extract`, and `staging-layout` and `figma-match` pick the right tool first but then re-read the images themselves. Descriptions are not the lever there.
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
