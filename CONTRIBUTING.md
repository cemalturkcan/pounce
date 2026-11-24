# Contributing

## Setup

You need Bun 1.4.5 or newer, Google Chrome, `pdftotext` (poppler-utils) for the PDF cases and `ffmpeg` for the
recording cases.

```sh
bun install --frozen-lockfile
bun src/server.ts --version
```

Bun runs the TypeScript sources directly; there is no build step for development. `bun src/server.ts` takes the same
commands as the `pounce` binary. To run a daemon from source next to an installed pounce, give it its own port and
data dir; `daemon start` starts the installed systemd service only when that service serves the same port and data dir.

```sh
export WEB_AGENT_DAEMON_PORT=39001 WEB_AGENT_DAEMON_DATA_DIR=/tmp/pounce-dev
bun src/server.ts daemon start
bun src/server.ts daemon stop
```

## Checks

```sh
bun run fmt:check    # oxfmt; bun run fmt rewrites
bun run lint         # oxlint with the anti-slop rules in tools/oxlint/anti-slop
bun run typecheck
bun run check        # all of the above, then the unit and e2e tests
```

## Tests

```sh
bun run test                                  # unit tests in src/ and scripts/
bun test src/install/install.spec.ts          # one file
bun run test:e2e                              # end to end, headless Chrome against a local fixture site
WEB_AGENT_ENGINE=playwright bun run test:e2e  # the same on plain Playwright
bun test --timeout 300000 e2e/daemon.spec.ts  # one e2e file
```

Tests run on `bun:test`; spec files sit next to the code they test, HTTP boundaries are mocked with msw, and the
shared harness is in `tests/`. Both suites run one worker per two CPU threads.

Each e2e file starts its own fixture servers and daemons on free ports with their own Chrome profile in a temporary
folder, so files do not share state and the suites run beside an installed pounce on the default port. They launch
the installed Google Chrome headless. `e2e/timings.json` holds per-file durations so the slowest files start first;
refresh it after adding or growing a spec with
`bun test --timeout 300000 e2e --parallel=8 --timings=e2e/timings.json --update-timings`.

CI (`.github/workflows/ci.yml`) runs on pull requests and by hand: one job lints the workflows with actionlint and runs
`bun run check`, the other runs the e2e suite on the Playwright engine.

`eval/` holds evaluations that call the real Claude Code CLI or model, so they are not part of `bun run test`:

```sh
bun eval/run.ts --label after                 # which tools Claude Code picks for plain-language tasks
bun eval/score.ts eval/results before after   # compare two runs
bun eval/ask-this-product.ts --label after    # one ask_pages question over 15 pricing pages
bun eval/browse-record.ts                     # record ask_pages browsing for e2e/browse.spec.ts
```

## Layout

`src/server.ts` is the entry point. Code under `src/` is grouped by feature: `cli/` and `install/` for the commands,
`server/` for the daemon, `config/`, `tools/` for the MCP tools, `browser/` and `page/` for Chrome and page work,
`script/` for `run_script`, `ask/` and `browse/` for `ask_pages`, `visual/` for `compare_design`, `log/`, `overlays/`
and `shared/`. `skills/pounce/SKILL.md` is the guide agents read; the installer copies it.

## Releases

1. Set `version` in `package.json` and commit it to `main`.
2. Push a tag `v<version>`, for example `git tag v0.3.0 && git push origin v0.3.0`.

The release workflow (`.github/workflows/release.yml`) fails when the tag does not match `package.json`, otherwise it
builds `pounce-linux-x64` and `pounce-linux-arm64` with `bun run build:binary`, writes `SHA256SUMS` and uploads them to
the GitHub release, which is what the `install` script downloads. It runs no tests, so run `bun run check` before
tagging. `bun run build:binary` builds the same binaries locally into `dist/`.

The npm package (`bun add -g pounce`) is published by hand from the same commit with `npm publish`, which needs an npm login.
`npm pack` shows what goes into it: `src/` without the spec files, `skills/pounce/SKILL.md`, the README and the
notices.
