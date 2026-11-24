# pounce

A fast, end-to-end browser for AI agents. pounce is an MCP server that runs one Chrome as a local daemon and shares
it with every agent session on the machine: Claude Code, Codex, Cursor, OpenCode, Gemini CLI, VS Code, Windsurf and
Claude Desktop, or any other MCP client.

Agents open their own tabs, read pages, click, fill forms, run Playwright scripts, watch network traffic, record
video, and ask a small model questions over many pages at once. The profile persists, so a login done once stays
done. It can start fresh or as a copy of your own Chrome profile.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/cemalturkcan/pounce/main/install | bash
```

The script downloads the Linux binary (x64 or arm64) from GitHub Releases, checks its SHA-256, puts it in
`~/.local/bin/pounce` and runs `pounce install`. With [Bun](https://bun.sh) 1.4.5 or newer you can install it from
npm instead:

```sh
bun add -g pounce && pounce install
```

`pounce install` asks:

1. **Agents**: which agents get the pounce MCP server (the ones found on this machine start checked). It edits each
   agent's config in place and copies the pounce skill for agents that read skills.
2. **ask_pages model**: your Claude Code login, an Anthropic API key, your own adapter file, or off.
3. **Profile**: a fresh profile, or a copy of an existing Chrome, Chromium, Brave or Edge profile (close that browser
   first).
4. **Default browser**: whether links from other apps open in pounce (only when a display is available).

It then sets up a `pounce.service` systemd user service (when `systemd --user` runs), saves the answers to
`~/.config/pounce/config.json`, and checks that the daemon answers and Chrome starts. Every question has a flag, so it
also runs without a terminal:

```sh
pounce install -a claude codex --ask off --profile fresh --no-desktop   # no questions
pounce install -y                                                       # every agent found here
pounce install --agent none                                             # print the MCP entry to add by hand
pounce install --help
```

Then restart your agent and ask it to _"Use pounce to open news.ycombinator.com and tell me the top story."_

Requirements: Linux, Google Chrome (or another Chromium-based browser through `WEB_AGENT_CHROME_EXECUTABLE`).
Optional: `ffmpeg` for `recording`, `gopass` for stored credentials.

## What agents get

28 tools. The core loop is `navigate` to open a tab, `snapshot` or `read_page` to look, then `click`, `fill`,
`press`, `hover`, `drag` or `scroll` with refs from that look. Every action reports whether the page navigated,
changed or did not react, and any dialog, download, new tab or CAPTCHA it caused. Beyond that: `run_script` for
server-side Playwright scripts and background jobs, `save_pages` and `ask_pages` for many pages at once,
`compare_design` to check a page against a mockup or an earlier screenshot, `network`, `intercept` and `request` for
traffic, `storage`, `emulate`, `recording` to mp4, `site` for per-site notes and permissions, `handoff` when a step
needs you, and `logs`. Bulky output goes to files; results carry paths.

The agent-facing guide is [`skills/pounce/SKILL.md`](skills/pounce/SKILL.md).

## Commands

```sh
pounce mcp                    # MCP server on stdio, served by the shared daemon (started when down)
pounce daemon start|stop|status
pounce open [url...]          # open pages in the agent browser for yourself
pounce import-profile [--from <user data dir>] [--profile <name>] [--live]
pounce                        # MCP server on stdio with a browser of its own
pounce --version
```

Most agents connect over HTTP to `http://127.0.0.1:29741/mcp`; clients that only run stdio servers use `pounce mcp`.

## More

- [docs/configuration.md](docs/configuration.md): `config.json`, environment variables, folders, the service, logs
- [docs/adapters.md](docs/adapters.md): how `ask_pages` reaches a model, and writing your own adapter
- [CONTRIBUTING.md](CONTRIBUTING.md): development setup, checks, tests and releases

## License

MIT, see [LICENSE](LICENSE).
