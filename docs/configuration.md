# Configuration

`pounce install` writes everything described here. You only need this page to change a setting by hand or to run
pounce somewhere unusual.

## Folders

| What       | Where                                                          | Notes                                                                                                                  |
| ---------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Binary     | `$XDG_BIN_HOME/pounce`, else `~/.local/bin/pounce`             | Left alone when pounce runs from a package manager (`bun add -g`)                                                      |
| Config dir | `$XDG_CONFIG_HOME/pounce`, else `~/.config/pounce`             | Holds `config.json` and an optional `ask-adapter.mjs`                                                                  |
| Data dir   | `$XDG_DATA_HOME/pounce`, else `~/.local/share/pounce`          | Holds `profile/`, `output/`, `sites/`, `logs/` and the daemon registry `daemon.json`                                   |
| Service    | `$XDG_CONFIG_HOME/systemd/user/pounce.service`                 | See [Service](#service)                                                                                                |
| Downloads  | Chrome's `download.default_directory`, else `XDG_DOWNLOAD_DIR` | From the profile's preferences and `user-dirs.dirs`, else `~/Downloads`; agents' downloads go to its `agent` subfolder |

Older installs used other names. When the new folder does not exist and the old one does, the old one is used and
nothing is moved:

- config: `~/.config/web-agent-mcp` (always under `$HOME`, whatever `XDG_CONFIG_HOME` says)
- data: `$XDG_DATA_HOME/claude-code-pair/web-agent` (`~/.local/share/claude-code-pair/web-agent`)

## config.json

The installer saves its answers here with mode `0600`. Every field is optional.

```json
{
  "agents": ["claude", "codex"],
  "entries": { "claude": { "type": "http", "url": "http://127.0.0.1:29741/mcp" } },
  "ask": { "mode": "claude" },
  "profile": "fresh",
  "desktop": false,
  "env": { "WEB_AGENT_CHROME_EXECUTABLE": "/usr/bin/chromium" }
}
```

| Field     | Meaning                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `agents`  | The agents picked last time; the picker starts with them checked                                                                     |
| `entries` | The MCP entry pounce wrote into each agent's config. A `pounce` entry that differs from this one is someone else's and is left alone |
| `ask`     | The model behind `ask_pages` and `compare_design`; see below. Without it, `claude` is used                                           |
| `profile` | `fresh`, or the profile that was copied, as `<browser>:<profile dir>` (for example `chrome:Default`)                                 |
| `desktop` | Whether pounce was made the default browser                                                                                          |
| `env`     | `WEB_AGENT_*` variables from [the list below](#environment-variables), kept from every `pounce install` run that had them set        |

`ask` takes one of these:

| Value                                         | Model                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `{ "mode": "claude" }`                        | Your Claude Code login (`~/.claude/.credentials.json`, or `$CLAUDE_CONFIG_DIR`)          |
| `{ "mode": "api-key", "apiKey": "sk-ant-…" }` | An Anthropic API key; `ANTHROPIC_API_KEY` in the daemon's environment takes precedence   |
| `{ "mode": "adapter", "path": "/abs/x.mjs" }` | Your own adapter module; see [adapters.md](adapters.md)                                  |
| `{ "mode": "off" }`                           | `ask_pages` and the model layer of `compare_design` refuse and point at `pounce install` |

The daemon reads `config.json` when it starts, so restart it after a change. An invalid file stops the daemon with a
message; `pounce install` offers to rewrite it and keeps a copy as `config.json.bak-<time>`.

## Environment variables

Environment variables override the defaults above. `pounce install` saves the `WEB_AGENT_*` variables set when it
runs in the `env` field of `config.json`, adding to those saved by earlier runs, so the daemon, `pounce mcp`,
`pounce open` and the desktop entry all use them. A variable set in the environment overrides the saved value; to
drop a saved one, delete it from `env` and restart the daemon.

| Variable                                                   | Default                                                  | Purpose                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `WEB_AGENT_DAEMON_DATA_DIR` / `WEB_AGENT_DATA_DIR`         | the data dir above                                       | Data dir                                                                                         |
| `WEB_AGENT_DAEMON_PORT`                                    | `29741`                                                  | Daemon port on `127.0.0.1`                                                                       |
| `WEB_AGENT_CHROME_USER_DATA_DIR`                           | `<data dir>/profile`                                     | Chrome profile the browser runs on                                                               |
| `WEB_AGENT_OUTPUT_DIR`                                     | `<data dir>/output`                                      | Bulky results: snapshots, collected pages, screenshots, network exports, recordings              |
| `WEB_AGENT_SITES_DIR`                                      | `<data dir>/sites`                                       | Per-site notes kept by `site`                                                                    |
| `WEB_AGENT_LOG_DIR`                                        | `<data dir>/logs`                                        | Daemon log                                                                                       |
| `WEB_AGENT_LOG_LEVEL`                                      | `info`                                                   | `debug`, `info`, `warn` or `error`; `debug` adds the start of every tool result                  |
| `WEB_AGENT_ENGINE`                                         | `patchright`                                             | `patchright` or `playwright`                                                                     |
| `WEB_AGENT_CHROME_CHANNEL` / `WEB_AGENT_CHROME_EXECUTABLE` | `chrome`                                                 | Which browser to launch                                                                          |
| `WEB_AGENT_HEADLESS`                                       | headed when `DISPLAY` or `WAYLAND_DISPLAY` is set        | `true`/`1` or `false`/`0`                                                                        |
| `WEB_AGENT_CHROME_SANDBOX`                                 | `true`                                                   | `false` for containers without unprivileged user namespaces                                      |
| `WEB_AGENT_CHROME_POLICY_DIRS`                             | `/etc/opt/chrome/policies/*`, `/etc/chromium/policies/*` | Colon-separated folders searched for the policy behind `ERR_BLOCKED_BY_ADMINISTRATOR`            |
| `WEB_AGENT_PASSWORD_STORE`                                 | `gnome-libsecret`                                        | Chrome password store, so copied cookies and passwords decrypt                                   |
| `WEB_AGENT_DEFAULT_LOCALE`                                 | Chrome's own                                             | Browser locale for every tab, such as `en-US`                                                    |
| `WEB_AGENT_DEFAULT_TIMEZONE_ID`                            | the system's                                             | Time zone for every tab, such as `Europe/Berlin`                                                 |
| `WEB_AGENT_DEFAULT_LAUNCH_ARGS`                            |                                                          | Extra Chrome flags, each starting with `--`                                                      |
| `WEB_AGENT_SECRETS`                                        | `gopass`                                                 | `gopass` or `none`; the store `fill` reads `secret` from                                         |
| `WEB_AGENT_AUTO_CONSENT`                                   | `accept`                                                 | Cookie banners on agent tabs: `accept`, `reject` or `off`                                        |
| `WEB_AGENT_CONSOLE_HOOK`                                   | `local`                                                  | Where patchright captures the page's own console calls: `local` dev hosts, `all` sites, or `off` |
| `WEB_AGENT_ASK_ADAPTER`                                    |                                                          | Absolute path of an adapter module; overrides the `ask` setting, `off` included                  |
| `ANTHROPIC_API_KEY`                                        |                                                          | The key for `ask` mode `api-key`                                                                 |

## Service

On a machine with `systemd --user`, `pounce install` writes `pounce.service` with
`ExecStart=<pounce> --daemon`, enables it and starts it (it starts with `graphical-session.target` when one is
active, else with `default.target`). It is left out when a `claude-code-pair-web-agent.service` from an older install
already runs the daemon.

```sh
systemctl --user restart pounce.service      # after changing config.json or upgrading
journalctl --user -u pounce.service -n 100   # errors also go to stderr
```

Without systemd, `pounce daemon start` starts the daemon in the background; `pounce mcp` also starts it on demand.

The daemon serves MCP at `http://127.0.0.1:<port>/mcp` and accepts only requests whose `Host` and `Origin` point at
that loopback address. `POST /open` with `{"url": "…"}` launches Chrome when it is not running and opens the page in
a tab left to you; when Chrome already runs it opens nothing and answers `{"launched":false,"running":true}`.
`pounce open` uses it and then hands the URL to the running Chrome.

## Logs

The daemon writes JSON Lines to `<data dir>/logs/daemon-YYYY-MM-DD.jsonl`, one file per local day, and deletes files
older than 14 days. Each line has `time`, `level`, `event`, and where it applies `requestId`, `session` and `tab`.
Secrets, typed text and query values are logged only as their length. A failed tool result ends with `[req <id>]`;
agents read the matching lines with the `logs` tool (`source: "server"`, `request_id`).

```sh
cd ~/.local/share/pounce/logs
jq -c 'select(.requestId == "3fa91c")' daemon-*.jsonl
jq -c 'select(.level == "error" or .level == "warn")' daemon-$(date +%F).jsonl | tail -20
```
