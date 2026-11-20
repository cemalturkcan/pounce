---
name: web-agent-browser
description: Working in the user's real, signed-in Chrome through web-agent-mcp. Load before browser work that goes beyond one page - shopping, orders and payments, sign-ups and logins, reading or comparing many pages, visual QA and design checks, scraping and site APIs, scripted flows, network inspection, and verifying a local web app.
---

# The environment

`web-agent-mcp` drives one real Google Chrome with a persistent profile seeded from the user's own browser, so it usually has their history, saved passwords and signed-in sessions. The window is on the user's desktop and they watch it; they set it up so you can work in it freely and quickly.

The browser is one shared daemon: every agent session on this machine sees the same tabs and cookies. Open your own tab for a task and close it when you are done; tabs that `tabs_list` marks as another client's or unclaimed belong to someone else.

Bulky results are files under the output directory that `tabs_list` reports. You have file tools on the same machine, so reading or grepping those files is cheaper than pulling the same content through a tool result.

# The user's standing rulings

- Orders, sign-ups and payments the user asks for are carried through to the final confirmation without stopping to ask. Where the request leaves a detail open, pick the option that best fits it and say in your report which one you chose. `save_page` with `format: "pdf"` keeps the confirmation.
- The only pauses are steps that need the user themselves: a CAPTCHA or bot check, a code sent to their phone or email, a passkey or security-key prompt, a bank's approval screen. Those go through `handoff`, which notifies them and waits. A `Challenge:` line in a result means one is showing; hand it over rather than trying to solve it.
- `ask_pages` and `compare_design` have no default limits: no time limit per model call, no page clipping, and the model's full output budget. Lower them only when speed or cost matters more than completeness.
- `compare_design` takes any reference image: a Figma export, a mockup, an earlier screenshot of the same page, or a screenshot of another site.

# Which tool for which task

| Task | Tools |
|---|---|
| Open a page, go somewhere else, back, reload | `tab_open`, `navigate`; `tabs_list` to find tab ids and the output directory |
| See a page on a phone, in dark mode, another locale or time zone, offline | `emulate` (`reset: true` when done); `tab_resize` for a plain size |
| Read an article, docs, results or a table | `read_text` (`format: "markdown"`, `scope: "main"`); page with `offset` only as far as needed |
| Product name, price, availability, specs, a table's rows | `extract` first; it returns what the page declares as data |
| Find a button or field and act on it | `find` when you know the label, `snapshot` (`interactive: true`) otherwise, then `click` / `fill` / `press` with the ref |
| Fill and submit a form | `fill_form` with every field and `submit`; it reports fields the browser marks invalid |
| Sign in | check whether the session is already signed in; `secrets_list`, then `fill` / `fill_form` with `secret`; `http_auth` for the browser's own login dialog |
| A cookie banner or pop-up in the way | `dismiss_overlays` |
| A CAPTCHA, SMS or email code, passkey, bank approval | `handoff` |
| A site asks for location, camera, notifications | `permissions` |
| Upload a file | `upload` |
| Wait for something the page does later | `wait_for` |
| Keep a receipt or confirmation | `save_page` |
| Many pages: facts, comparisons, which pages mention something | `collect_pages`, then `ask_pages` with `dir`; or `ask_pages` with `urls` directly |
| Many pages: broken layouts, visual glitches | `ask_pages` with `mode: "review"` and `urls` or `tabs` (full-page screenshots by default) |
| Does a page match a design, mockup or earlier screenshot | `compare_design` with the image path |
| See one page yourself | `screenshot` (the image enters the conversation) |
| The API behind a page, table or search | `network_requests` to find the call, then `request` to call it or `from_request` to replay it with changes |
| Make a page see a different, failing or mocked response | `intercept` |
| Cookies, localStorage, IndexedDB | `cookies`, `storage` (read only; change storage with `evaluate`) |
| Keep the whole traffic | `network_export` (HAR, unmasked) |
| Many steps you can already describe (repeat, paginate, loop over rows or tabs) | `run_script`; runs of minutes with `background: true` and `jobs` |
| Read one JavaScript value in the page | `evaluate` |
| A page's JavaScript errors | `console_logs` (local development hosts with the default engine) |
| A tool failed, often with `[req <id>]` | `server_log` with that `request_id` |
| What a site taught you last time | `site_notes` (read when a result says notes exist, append what took effort) |

# Worked examples

These show the shape of a good route, not templates.

**Check 30 staging routes for broken layouts.** One call: `ask_pages` with `mode: "review"`, the 30 URLs in `urls`, and a brief such as "Check for broken layouts, overflow and missing images". The result is the issue lines sorted by severity and the routes with no issues. Open the screenshot files it lists, or `screenshot` one route, only for the issues you want to see yourself before fixing them.

**Does this page match this Figma frame?** `tab_open` the page, then `compare_design` with the export's absolute path (`device_scale_factor: 2` for an @2x export). Fix what the regions name, reload, and run it again until only noise remains. Read a crop file from the result when one region needs a closer look.

**Find the API behind this table and fetch all pages.** `tab_open` the page, `network_requests` with `types: ["xhr", "fetch"]`, then `network_requests` with the `id` of the call that returned the rows. `request` with `from_request` and a changed `query` fetches page 2; for all pages, a `run_script` loop over `context.request` saves them with `save()`. Append the endpoint and its paging scheme to `site_notes`.

**Sign in and download last month's invoices.** `tab_open` the billing page; if it shows a sign-in form, `secrets_list` for the site and `fill_form` with `secret` fields and `submit`. A `Challenge:` line or an SMS code prompt goes to `handoff` with `until_url` or `until_gone`. On the invoice list, `click` each invoice's download link; the result gives the saved path. If the list is long, `network_requests` usually shows a JSON endpoint with direct links that `request` downloads.

**A tool failed with `[req 3fa91c]`.** `server_log` with `request_id: "3fa91c"`, then with `since_minutes: 5` to see what happened around it, such as a browser crash and relaunch. Retry once the cause is clear, and mention the request id when you report the failure.

# Things that behave differently here

- Refs come from the latest snapshot of a tab and stop resolving once the page changes. A "not in the latest snapshot" error means take a new snapshot, not that the element is gone.
- Each action reports whether the page navigated, changed or did not react, plus `Event:` lines for dialogs (accepted automatically), downloads (saved automatically, with the path), new tabs (with their id, including OAuth popups and their closing) and popups the browser blocked. A separate check is needed only when that is not enough; `include_diff: true` returns just the snapshot lines an action changed.
- Leaving a page that warns about unsaved changes is cancelled and reported; `force: true` on `navigate` or `tab_close` leaves anyway.
- `fill` on a custom dropdown or picker clicks it open and picks the option by name; when it cannot, the error says what to click.
- A result that starts with `Note: the tab moved to …` means the page navigated since your last call on that tab, by the user or by itself. `Note: this looks like a sign-in page` means the session probably expired.
- A click that reports another element intercepting pointer events has a banner, modal or sticky header over the target; `dismiss_overlays` handles banners and modals, iframes included.
- `evaluate` runs in the page's own JavaScript world. In `run_script`, functions passed to `page.evaluate` or `locator.evaluate` run in an isolated world that shares the DOM but not the page's globals.
- Console capture is off on ordinary sites with the default stealth engine; `console_logs` works on localhost, 127.0.0.1, `*.localhost` and `*.test`.
- Secrets typed with `secret` are masked in results and written files, one-time codes for 2 minutes; usernames are not masked, and raw exports (`cookies` export, `network_export`, `storage` export) keep values as they are. Do not read a secret back out of the page.
- `ask_pages` answers come from a fast model reading quickly; check the facts a decision rests on against the page. When each page needs work it cannot do, such as following a link, use `run_script` or Claude Code subagents over the collected files instead.
- When the user closes the window or Chrome dies, the next `tab_open` starts it again with the same profile; earlier tab ids are gone.

# `run_script` shapes

Paginate and save, returning a count and a path:

```js
const rows = [];
for (let n = 1; n <= 20; n += 1) {
  await page.goto(`https://example.com/list?page=${n}`, { waitUntil: "domcontentloaded" });
  const items = await page.locator(".item").evaluateAll((els) => els.map((el) => ({ title: el.querySelector("h2")?.innerText, price: el.querySelector(".price")?.innerText })));
  if (items.length === 0) break;
  rows.push(...items);
  log("page", n, items.length);
}
return { count: rows.length, file: await save("items.json", JSON.stringify(rows, null, 2)) };
```

Check many routes against a folder of baselines (`compareDesign` returns the `compare_design` report, with `summary` holding its text):

```js
const results = [];
for (const route of ["/", "/pricing", "/login"]) {
  await page.goto(`http://localhost:3000${route}`, { waitUntil: "networkidle" });
  const name = route === "/" ? "home" : route.slice(1);
  const report = await compareDesign(page, `/home/me/baselines/${name}.png`, { model: "none" });
  results.push({ route, regions: report.regions.length, diff: report.files.diff });
}
return results;
```

In a background job, `log()` is all you see while it runs, and checking `signal.aborted` in long loops lets `jobs` `cancel` stop it cleanly.

# Operating the daemon

The daemon is the systemd user unit `claude-code-pair-web-agent.service` on `http://127.0.0.1:29741/mcp`. `systemctl --user restart claude-code-pair-web-agent.service` restarts it and closes every open tab, so do it only when `tabs_list` or `server_log` show the daemon itself is unhealthy. Its configuration is in `~/.config/web-agent-mcp`, and its profile, output, logs and site notes in `~/.local/share/claude-code-pair/web-agent`.

`ask_pages` and the model layer of `compare_design` call Anthropic's Messages API through the built-in adapter with the local Claude Code sign-in. An adapter module replaces it: an ES module default-exporting `{ name, complete({ system, prompt, model, maxTokens, images, signal }) }` (or a function returning one), loaded from `WEB_AGENT_ASK_ADAPTER` when set, otherwise from `~/.config/web-agent-mcp/ask-adapter.mjs` when it exists. `tabs_list` names the active adapter, and `examples/ask-adapter.example.mjs` shows the shape.

`npm run import-profile` in the daemon directory copies cookies, saved passwords, history and site storage from the user's Chrome profile into the agent profile, after moving the previous agent profile aside. The daemon must be stopped first, and it replaces the agent's sessions, so the user runs it or asks for it.
