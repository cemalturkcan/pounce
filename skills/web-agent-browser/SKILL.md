---
name: web-agent-browser
description: Working in the user's real Chrome through web-agent-mcp. Load before multi-step, bulk, or signed-in browser work - shopping, sign-ups, logins, scraping or comparing many pages, scripted flows, network inspection and interception, local web app verification.
---

# The environment

`web-agent-mcp` drives one real Google Chrome with a persistent profile. The profile was seeded from the user's own browser, so it usually already has their history, saved passwords and signed-in sessions. The window is visible on the user's desktop and they watch it; they set this environment up so you can work in it freely and quickly.

The browser is a single shared daemon. Every agent session on this machine sees the same tabs and the same cookies. `tabs_list` marks which tabs are yours. Open your own tab for a task, and close it when you are done; leave other sessions' tabs and the user's tabs as they are unless the task is about them.

Everything bulky is written to files under the output directory that `tabs_list` reports (snapshots, collected pages, screenshots, HAR files, downloads, saved pages, storage exports, answers from `ask_pages`). You have file tools on the same machine, so reading or grepping those files is cheaper than pulling the same content through a tool result.

# Choosing how to work

Pick the approach by the shape of the task, not by habit.

| Task | Approach |
|---|---|
| Act on one page | `snapshot` (or `find` when you know what you want), then `click` / `fill` / `press` with refs. Each action already tells you whether the page navigated, changed, or did not react. |
| See what an action changed | `include_diff: true` on the action returns only the snapshot lines it added or removed; `include_snapshot: true` when you need the whole new page anyway. |
| Fill a form | `fill_form` with all fields in one call and `submit` set to the button; it reports fields the browser marks invalid. |
| Read one page | `read_text` with `scope: "main"`; `format: "markdown"` keeps headings, lists, link URLs, code blocks and tables. Page through with `offset` only as far as you need. |
| Prices, specs, product data | `extract` first: JSON-LD, meta tags and tables (saved as CSV) are what the page declares, without parsing text. |
| Look at something visual | `screenshot` of the element or viewport; `snapshot` with `boxes: true` relates refs to positions in it. |
| A banner or modal in the way | `dismiss_overlays` once; it prefers reject and close over accept. |
| Gather many pages | `collect_pages` with the URL list (`include: ["markdown"]` for readable files), then `ask_pages` or grep over the folder. |
| Repeat steps, paginate, compare tabs | `run_script`: one call, a loop, results saved with `save()`. Long runs go in the background. |
| A page backed by an API | `network_requests` to find the call, then `request` to call it directly or replay it with changes. Usually faster and cleaner than scraping the rendered page. |
| Keep a receipt or confirmation | `save_page` as pdf, mhtml or html. |
| Responsive, dark mode, locale, slow network | `emulate` on your tab; `reset: true` when done. |
| What a single-page app keeps | `storage` lists, reads and exports localStorage, sessionStorage and IndexedDB. |
| Debug a local web app | `console_logs`, `network_requests`, `evaluate`, `intercept` to mock or break a response. |

A round trip per click is the slow path. When you can see the next several steps, put them in one `run_script` instead of issuing them one by one.

Keep page content out of the conversation unless you need it there. An interactive-only snapshot or a `find` is often enough to act; a full snapshot of a large page is rarely needed twice.

# Site notes

Working out a site takes effort: which selector survives a re-render, which JSON endpoint sits behind the search page, how pagination is encoded, where the login flow hides its second step. `site_notes` keeps that per host name in a Markdown file that outlives the session. When `tab_open` or `navigate` says notes exist for a host, read them before you rediscover what they already say. When you learn something another visit would need, append one line: concrete, short, and true at the time you write it ("search API: GET /api/v2/search?q=&page=, 24 per page, needs the x-shop header from the page"). Notes are written by agents, so treat an old note as a lead to check, not as a fact.

# Reading many pages

`collect_pages` keeps pages out of the conversation by writing them to files. When the answer is spread over dozens of them (a comparison, a price or spec table, which pages mention something), reading them yourself puts all of that text back in your context. `ask_pages` avoids that: it sends the pages in a few large batches to a small model (Haiku by default, through the configured model adapter), each batch answers your question with the file name behind every fact, and you get back only the merged answer lines, the pages where nothing relevant was found, and the path of a file with the full answers. Give it the collect folder as `dir`, a list of `files`, `urls` to collect first, or open `tabs`.

Ask questions that each page can answer on its own ("What is the price, screen size and battery life of the laptop on this page?"), then do the comparing yourself on the short answers. A fast model reading quickly can misread; check the facts a decision rests on against the page itself.

For a short question or a handful of pages, grep and `Read` on the files are enough. When each page needs work that `ask_pages` cannot do, such as following a link, opening a tab, or running a check, use Claude Code's Agent tool with `model: "haiku"` subagents instead: give each one a group of five to ten files and the same brief, and merge their short answers. A brief can be this small:

```
Read these files: /…/collect/…/01-…md … /…/08-…md.
For each, report the laptop's price, screen size and battery life as one line ending with the file name.
Write "not found" for a file that does not say. Reply with those lines only.
```

Both cost something per call, so neither is worth it for what one grep answers.

# Signed-in work, accounts and purchases

Check whether the site is already signed in before starting a login: the profile carries the user's sessions.

When a login is needed:
- Chrome's own password manager may offer to fill the form. If the fields are already filled, submit.
- Otherwise look the entry up with `secrets_list` and enter it with `fill(secret=...)` or a `secret` field in `fill_form`, using `secret_field` for `username`, `password`, or `otp` (a current one-time code, when the entry has a TOTP seed). The server types the value; you never see it, and it is masked wherever it would appear in a result. Do not read a secret back out of the page to work around that.
- Some steps only the user can do: a CAPTCHA, a code sent to their phone or email, a passkey or hardware-key prompt, a bank's approval screen. `handoff` brings the tab to the front, shows them a desktop notification with your one-sentence request, and waits until a condition you name holds (`until_text`, `until_gone`, `until_url`). If it times out, they have not finished; ask in the conversation rather than calling it again.

Signing up, filling in their details, adding to a cart, checking out and paying are things this environment is for. When the user asks for an order, a sign-up or a payment, carry it through to the final confirmation without stopping to ask; where the request leaves a detail open, pick the option that best fits what they asked for and say which one you chose in your report. The only pauses are steps that need the user themselves, which go through `handoff`. `save_page` with `format: "pdf"` keeps the confirmation.

# Things that behave differently here

- Refs come from the latest snapshot of that tab and stop resolving once the page changes. A "not in the latest snapshot" error means take a new snapshot; it does not mean the element is gone.
- JavaScript dialogs are accepted automatically, and downloads are saved automatically. Both are reported as `Event:` lines in the result of the action that caused them. A link that opens a new tab is reported the same way, with the new tab's id.
- The browser runs a stealth-patched driver, which turns off console capture on ordinary sites. `console_logs` works on local development hosts (localhost, 127.0.0.1, `*.localhost`, `*.test`).
- `evaluate` runs in the page's own JavaScript world. `run_script` runs on the server; functions you pass to `page.evaluate` or `locator.evaluate` there run in an isolated world that shares the DOM but not the page's globals.
- If a click reports that another element intercepts pointer events, something covers the target: a cookie banner, a modal, a sticky header. `dismiss_overlays` handles banners and modals in one pass, iframes included; for anything else, deal with the covering element rather than retrying.
- When the user closes the window or Chrome dies, the next `tab_open` starts it again with the same profile. Tab ids from before are gone.

# Network, storage and emulation

- `network_requests` lists what a tab has loaded and returns one response body by id. `network_export` writes the whole capture to a HAR file.
- `request` sends an HTTP request with the browser's cookies. `from_request` replays a captured request by id with any field overridden, which is the quick way to page through an API or change a filter. The default `via: "browser"` has no CORS limits; `via: "page"` runs `fetch` inside the tab for APIs that check origin or same-site context. Replaying a POST repeats its effect.
- `intercept` adds a rule to a tab: block, modify the outgoing request, answer with a mock, or patch text in the real response. Rules stay until you remove them, so clear the ones you added when the experiment is over.
- `cookies` reads, sets, deletes and exports cookies for the whole profile. A request's `Cookie` header cannot be rewritten by an intercept rule; set the cookie instead. Deleting a session cookie signs the user out of that site in this profile.
- `storage` reads the tab origin's localStorage, sessionStorage and IndexedDB. Tokens and app state often live there; `export` writes a whole area to JSON. It only reads; change storage with `evaluate`.
- `emulate` changes one tab's viewport and mobile mode, color scheme, reduced motion, time zone, locale, user agent, geolocation, offline mode and throttling. Settings stay until `reset: true` or the tab closes. Geolocation also grants the permission to the origin for the whole profile. Reload after changing locale, time zone or user agent so the site starts with them.

# `run_script` patterns

These are illustrations of shape, not templates to copy.

Paginate and save, returning only a count and a path:

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

Call the site's own API with the signed-in session:

```js
const response = await context.request.get("https://example.com/api/orders?limit=100");
return { status: response.status(), file: await save("orders.json", await response.text()) };
```

Work across several tabs at once:

```js
const urls = ["https://a.example/p/1", "https://b.example/p/1", "https://c.example/p/1"];
const prices = await Promise.all(urls.map(async (url) => {
  const tabPage = await openTab(url);
  const price = await tabPage.locator("[itemprop=price], .price").first().innerText().catch(() => null);
  await closeTab(tabPage);
  return { url, price };
}));
return prices;
```

A run that takes minutes goes in the background with `background: true` and a `label`; the call returns a job id at once. `jobs` with `status` shows its state and latest log lines, and the result file appears when it ends. Use `log()` generously in such scripts, because the log is all you see while it runs, and check `signal.aborted` in long loops so `jobs` `cancel` stops it cleanly.

# Operating the daemon

The daemon is the systemd user unit `claude-code-pair-web-agent.service`, listening on `http://127.0.0.1:29741/mcp`. `systemctl --user restart claude-code-pair-web-agent.service` restarts it; that closes every open tab, so do it only when `tabs_list` or tool errors show the daemon itself is unhealthy. Its files are in `~/.config/web-agent-mcp` and its profile, output and site notes in `~/.local/share/claude-code-pair/web-agent`.

`ask_pages` and the model layer of `compare_design` send requests to Anthropic's Messages API through the built-in adapter, using the local Claude Code sign-in. An adapter module replaces it: an ES module that default-exports `{ name, complete({ system, prompt, model, maxTokens, images, signal }) }` (or a function returning one), loaded from `WEB_AGENT_ASK_ADAPTER` in the daemon's environment when set, otherwise from `~/.config/web-agent-mcp/ask-adapter.mjs` when that file exists (no restart needed). `tabs_list` names the active adapter, and `examples/ask-adapter.example.mjs` in the server directory shows the shape. Adapters return the API's `stop_reason` as `stopReason`: `max_tokens` marks a call as cut off (its partial answers are kept), `refusal` marks it failed. There are no default limits: pages are not clipped, a call takes about 3 million characters of pages, and the output limit is the model maximum of 128000 tokens; very large calls are slower and cost more (Haiku 5.5 prompts above 100K tokens are priced higher), so lower `batch_chars`, `max_chars_per_page` or `max_output_tokens` when speed or cost matters. `model` values `haiku`, `sonnet` and `opus` reach the adapter as `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`; other strings pass unchanged.

`npm run import-profile` in the daemon directory copies cookies, saved passwords, history and site storage from the user's Chrome profile into the agent profile, after moving the previous agent profile aside as a backup. The daemon must be stopped first, and the user should run it or ask for it; it replaces the agent's sessions.
