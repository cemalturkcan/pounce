# Handoff

State of `feat/hardening` after the hardening run of 2026-11-20. Gates on the final tree: `tsc` clean; unit 280/280 on Node 22 and Node 26; e2e on Node 26 (the daemon runtime) 235/235 with patchright and 234 + 1 skip with `WEB_AGENT_ENGINE=playwright` (the skip is the popup-blocker test, which cannot apply because Playwright launches Chrome with popup blocking off).

## Deferred, with reasons

- **run_script isolation.** Synchronous script code is time-limited on every slice when promise hooks are off (the Node 26 daemon) or repairable (Node 22). If a dependency later enables a promise-tracking async hook on Node 26, only code before the first `await` and callback bodies stay limited, and the case is recorded as a fault. Moving scripts into a worker thread would remove this edge but needs a proxy for every Playwright object.
- **routeWebSocket** registrations made by a script cannot be removed when the script ends; Playwright has no API for it.
- **Tool-choice eval misses.** In the 16-task eval, `product-price` still reaches `read_text` before `extract`, and `staging-layout` and `figma-match` pick the right tool first but then re-read the images themselves. Descriptions are not the lever there.
- **Logger after a long stall.** After an event-loop stall of about 10 s the log write timer fires late, reports one failed write and only counts later failures.
- **ERR_BLOCKED_BY_ADMINISTRATOR** policy lookup is covered by unit tests only; reproducing it end to end needs a policy file under `/etc`.
- **Auto-consent** clicks inside consent containers only; a site with an unusual banner structure may still need `dismiss_overlays` or a click.
- **Background throttling flags** (`--disable-background-timer-throttling`, `--disable-renderer-backgrounding`) stay on because agent work in background tabs depends on them; they cost CPU when many user tabs are open in the shared browser.

## Not done by the hardening run

- **Deployment of this branch to the live daemon** (`~/.config/web-agent-mcp`, systemd `claude-code-pair-web-agent.service`) is left to the owner. Deploy the committed tree, not the working tree:
  ```bash
  systemctl --user stop claude-code-pair-web-agent.service
  rm -rf ~/.config/web-agent-mcp/src && git archive feat/hardening src | tar -x -C ~/.config/web-agent-mcp
  find ~/.config/web-agent-mcp/src -name '*.test.ts' -delete
  git show feat/hardening:package.json > ~/.config/web-agent-mcp/package.json
  git show feat/hardening:package-lock.json > ~/.config/web-agent-mcp/package-lock.json
  (cd ~/.config/web-agent-mcp && npm ci --omit=dev)
  cp skills/web-agent-browser/SKILL.md ~/.claude/skills/web-agent-browser/SKILL.md
  systemctl --user start claude-code-pair-web-agent.service
  ```
  Restarting the daemon closes every tab of the agent Chrome.
- **claude-code-pair** keeps its local commits and an older submodule pin; the owner no longer uses it.
