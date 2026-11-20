# web-agent-mcp

An MCP server that lets coding agents work in a real Google Chrome with a persistent, signed-in profile. It runs as one local daemon shared by every agent session on the machine.

- Drives the system Chrome through [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright) (a Playwright fork without the usual automation leaks); `WEB_AGENT_ENGINE=playwright` switches to plain Playwright.
- Elements are addressed by refs from accessibility snapshots; every action reports whether the page navigated, changed, or did not react.
- Bulky output (snapshots, collected pages, screenshots, HAR files, downloads) is written to files and only paths and short indexes are returned.
- Tools cover tabs, navigation, snapshots and search, text and Markdown reading, screenshots, clicks and form filling (including credentials from gopass without exposing them), uploads, server-side Playwright scripts and background jobs, bulk page collection, questions over many pages answered by a small model (`ask_pages`), structured data extraction, network inspection, HAR export, request interception, direct requests with the browser session, cookies, storage, emulation, overlay dismissal, page saving, per-site notes, and human handoff.

The agent-facing guide is [`skills/web-agent-browser/SKILL.md`](skills/web-agent-browser/SKILL.md).

## Requirements

Node.js 22.18 or newer (TypeScript runs through type stripping, no build step) and Google Chrome. Optional: `gopass` for stored credentials, a local Claude Code sign-in for the default `ask_pages` adapter.

## Run

```bash
npm ci
npm run daemon            # HTTP daemon on http://127.0.0.1:29741/mcp
npm run daemon:status
npm run daemon:stop
node src/server.ts        # stdio mode
```

Register it with Claude Code:

```bash
claude mcp add --transport http --scope user web-agent-mcp http://127.0.0.1:29741/mcp
```

The daemon only accepts requests whose `Host` and `Origin` point at its loopback endpoint.

## Ask Pages

The built-in `ask_pages` adapter sends selected page text directly to the Anthropic Messages API. It defaults to Claude Haiku 5.5 and uses the Claude account session saved by `claude auth login` in `~/.claude/.credentials.json` or in the directory set by `CLAUDE_CONFIG_DIR`. Run the MCP server as the signed-in OS user. Claude Code manages the session, and the adapter rereads the file for each call.

Pass exactly one of `files`, `dir`, `urls`, or `tabs` with your question.

## Profile import

With the daemon stopped, copy cookies, saved passwords, history, bookmarks and site storage from your Chrome profile into the agent profile (the previous agent profile is kept as a backup):

```bash
npm run import-profile -- [--from ~/.config/google-chrome] [--profile Default] [--live]
```

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WEB_AGENT_DAEMON_DATA_DIR` / `WEB_AGENT_DATA_DIR` | `~/.local/share/claude-code-pair/web-agent` | Profile, output, site notes, registry |
| `WEB_AGENT_DAEMON_PORT` | `29741` | Daemon port |
| `WEB_AGENT_ENGINE` | `patchright` | `patchright` or `playwright` |
| `WEB_AGENT_CHROME_CHANNEL` / `WEB_AGENT_CHROME_EXECUTABLE` | `chrome` | Which browser to launch |
| `WEB_AGENT_HEADLESS` | headed when a display exists | Force headless or headed |
| `WEB_AGENT_PASSWORD_STORE` | `gnome-libsecret` | Chrome password store, so imported cookies and passwords decrypt |
| `WEB_AGENT_DEFAULT_LAUNCH_ARGS` | | Extra Chrome flags, space-separated |
| `WEB_AGENT_SECRETS` | `gopass` | `gopass` or `none` |
| `WEB_AGENT_CONSOLE_HOOK` | `local` | Console capture on `local` dev hosts, `all`, or `off` |
| `WEB_AGENT_ASK_ADAPTER` | built-in Anthropic adapter | Absolute path to an ES module that overrides the `ask_pages` adapter. See `examples/ask-adapter.example.mjs`. |
| `WEB_AGENT_LOG_DIR` | `<data dir>/logs` | Where the daemon writes its JSON Lines log (config key `logDir`) |
| `WEB_AGENT_LOG_LEVEL` | `info` | Lowest level written: `debug`, `info`, `warn` or `error`. `debug` adds the first 500 characters of every tool result. |

## Debugging

The daemon writes one JSON object per line to `<data dir>/logs/daemon-YYYY-MM-DD.jsonl` (UTC days; files older than 14 days are deleted at startup). Each line has `time`, `level`, `event`, and where it applies `requestId`, `session` and `tab`. Events cover every tool call (`tool_call`: tool, duration, outcome, the first lines of an error, a summarized input), daemon start and shutdown, MCP sessions opening, closing and being swept, browser launches, failures, crashes and relaunches, tabs that crash or are closed outside a tool, background jobs, and internal faults and unhandled rejections with their stacks. Inputs are summarized: long strings are cut, and fields such as `secret`, `password`, `text`, `value`, `code`, `script`, `expression` and `body` are logged only as their length. Every string passes through the same masking as tool results, so stored secrets and one-time codes do not appear.

A failed tool result ends with `[req <id>]`; that id finds the matching line. Agents can read the log with the `server_log` tool, and `tabs_list` shows the log directory and the errors of the last hour.

```bash
cd ~/.local/share/claude-code-pair/web-agent/logs
jq -c 'select(.requestId == "3fa91c")' daemon-*.jsonl
jq -c 'select(.level == "error" or .level == "warn")' daemon-$(date -u +%F).jsonl | tail -20
jq -c 'select(.event == "tool_call") | {time, tool, ms, ok}' daemon-$(date -u +%F).jsonl | tail
jq -r 'select(.event == "tool_call") | "\(.ms)\t\(.tool)"' daemon-*.jsonl | sort -n | tail
```

Errors are also printed to stderr, so the service journal keeps them:

```bash
journalctl --user -u claude-code-pair-web-agent.service -n 100
```

## Tests

```bash
npm run typecheck
npm test                 # unit
npm run test:e2e         # headless Chrome against a local fixture
```
