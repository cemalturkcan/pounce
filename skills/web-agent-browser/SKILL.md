---
name: web-agent-browser
description: Working in the user's real, signed-in Chrome through web-agent-mcp. Load before browser work that goes beyond one page - shopping, orders and payments, sign-ups and logins, reading or comparing many pages, visual QA and design checks, scraping and site APIs, scripted flows, network inspection, and verifying a local web app.
---

# The environment

`web-agent-mcp` drives one real Google Chrome with a persistent profile seeded from the user's own browser, so it usually has their history, saved passwords and signed-in sessions. The window is on the user's desktop and they watch it; they set it up so you can work in it freely and quickly.

The browser is one shared daemon: every agent session on this machine sees the same tabs and cookies. Open your own tab for a task and close it when you are done; tabs that `tabs` marks as another client's or unclaimed belong to someone else, while orphaned ones are free to use.

Bulky results are files under the output directory that `tabs` reports. You have file tools on the same machine, so reading or grepping those files is cheaper than pulling the same content through a tool result.

# The user's standing rulings

- Orders, sign-ups and payments the user asks for are carried through to the final confirmation without stopping to ask. Where the request leaves a detail open, pick the option that best fits it and say in your report which one you chose. `save_pages` with the tab in `tabs` and `include: ["pdf"]` keeps the confirmation.
- The only pauses are steps that need the user themselves: a CAPTCHA or bot check you could not get past, a code sent to their phone or email, a passkey or security-key prompt, a bank's approval screen. Those go through `handoff`, which notifies them and waits. A `Challenge:` line in a result means a bot check is showing; try it yourself first (click its checkbox or follow its prompt with `human: true`, then wait for it to clear) and hand it over only when that fails. A check that clears by itself is waited out first (`Challenge cleared:`), a `Challenge solved:` line means the check on the page now shows as solved, so carry on, and a `Blocked:` line means the site refused the visit: stop and tell the user, because retrying or reloading makes the block worse.
- `ask_pages` and `compare_design` have no default limits: no time limit per model call, no page clipping, the model's full output budget, and no step or time limit when `ask_pages` browses a page. Lower them only when speed or cost matters more than completeness.
- `compare_design` takes any reference image: a Figma export, a mockup, an earlier screenshot of the same page, or a screenshot of another site.

# Which tool for which task

| Task | Tools |
|---|---|
| Open a page, go somewhere else, back, reload | `navigate` (without `tab` it opens a new tab and returns its id); `tabs` for tab ids, the output directory and closing tabs (`close`) |
| See a page on a phone, in dark mode, another locale or time zone, offline, or at a plain size | `emulate` (`device` for a full phone or tablet identity, `viewport` for a size alone; reload when the result says the page was loaded with the old identity; `reset: true` when done) |
| Read an article, docs, results or a table | `read_page` (`format: "markdown"`, `scope: "main"`); page with `offset` only as far as needed |
| Product name, price, availability, specs, a table's rows | `read_page` with `format: "structured"` first; it returns what the page declares as data |
| Find a button or field and act on it | `snapshot` with `query` when you know the label, `snapshot` with `interactive: true` otherwise, then `click` / `fill` / `press` with the ref |
| Fill and submit a form | `fill` with `fields` (each a `target` and `value`) and `submit`; it reports fields the browser marks invalid |
| Sign in | check whether the session is already signed in; `site` for the tab lists matching secret names, then `fill` with `secret`; `site` with `http_auth` for the browser's own login dialog |
| A cookie banner or pop-up in the way | `navigate` and `save_pages` accept cookie banners by themselves (reported as `Event: accepted the cookie banner (…)`); `dismiss_overlays` for anything still covering the page |
| A CAPTCHA or bot check | try it: `click` its checkbox or follow its prompt with `human: true`, then `wait_for`; `handoff` when it does not clear |
| An SMS or email code, passkey, bank approval | `handoff` |
| A site asks for location, camera, notifications | `site` with `grant` |
| Upload a file | `fill` with `target` and `files` |
| An alert, confirm or prompt is open | `dialog` (`accept`, with `text` for a prompt, or `dismiss`) |
| Wait for something the page does later | `wait_for` |
| Keep a receipt or confirmation | `save_pages` with `tabs` and `include: ["pdf"]` |
| Many pages: facts, comparisons, which pages mention something | `save_pages` with `urls`, then `ask_pages` with `dir`; or `ask_pages` with `urls` directly |
| Facts behind toggles, tabs, hover or sub-pages across many pages | `ask_pages` (browse auto); one page → act yourself |
| Many pages: broken layouts, visual glitches | `ask_pages` with `mode: "review"` and `urls` or `tabs` (full-page screenshots by default) |
| Does a page match a design, mockup or earlier screenshot | `compare_design` with the image path |
| See one page yourself | `screenshot` (the image enters the conversation) |
| Video of a flow, animation or bug as it happens | `recording` with `action: "start"` and the tab, work in the tab as usual, then `action: "stop"`; the result gives the mp4 path (also when the tab or browser closed first) |
| The API behind a page, table or search | `network` to find the call, `network` with its `id` for the full request and response, then `request` to call it or `from_request` to replay it with changes |
| Make a page see a different, failing or mocked response | `intercept` |
| Cookies, localStorage, sessionStorage, IndexedDB | `storage` with `area` (cookies can be set and deleted; change web storage with `evaluate`) |
| Keep the whole traffic | `network` with `har: true` (unmasked) |
| Many steps you can already describe (repeat, paginate, loop over rows or tabs) | `run_script`; runs of minutes with `background: true`, then `run_script` with `job` to check or cancel it |
| Read one JavaScript value in the page | `evaluate` |
| A page's JavaScript errors | `logs` with `source: "page"` (the page's own messages on local development hosts by default with the patchright engine, on every site with the playwright engine; `site` with `console_capture: true` turns them on for one site, then reload) |
| A tool failed, often with `[req <id>]` | `logs` with `source: "server"` and that `request_id` |
| What a site taught you last time | `site` (read when a result says notes exist; `note` appends what took effort) |

# Worked examples

These show the shape of a good route, not templates.

**Check 30 staging routes for broken layouts.** One call: `ask_pages` with `mode: "review"`, the 30 URLs in `urls`, and a brief such as "Check for broken layouts, overflow and missing images". The result is the issue lines sorted by severity and the routes with no issues. Open the screenshot files listed in the `Full answers` file it names, or `screenshot` one route, only for the issues you want to see yourself before fixing them.

**Yearly prices of 10 SaaS products, shown behind a Monthly/Yearly toggle.** One call: `ask_pages` with the 10 pricing URLs in `urls` and "What does each plan cost per year?". Pages that state yearly prices are answered from their text; on the others the model names the toggle, opens the page in its own tab, switches it and reads the cards. Each browsed page is listed with its outcome and steps; read its transcript only when a line looks wrong.

**Does this page match this Figma frame?** `navigate` to the page, then `compare_design` with the export's absolute path (`device_scale_factor: 2` for an @2x export). Fix what the regions name, reload, and run it again until only noise remains. Read a crop file from the result when one region needs a closer look.

**Find the API behind this table and fetch all pages.** `navigate` to the page, `network` with `types: ["xhr", "fetch"]`, then `network` with the `id` of the call that returned the rows. `request` with `from_request` and a changed `query` fetches page 2; for all pages, a `run_script` loop over `context.request` saves them with `save()`. Append the endpoint and its paging scheme with `site` and `note`.

**Sign in and download last month's invoices.** `navigate` to the billing page; if it shows a sign-in form, `site` for the tab lists the matching secret names, then `fill` with `fields` that use `secret` and `submit`. A `Challenge:` line is tried first with `human: true`; one that does not clear, or an SMS code prompt, goes to `handoff` with `until_url` or `until_gone`. On the invoice list, `click` each invoice's download link; the result gives the saved path. If the list is long, `network` usually shows a JSON endpoint with direct links that `request` downloads.

**A tool failed with `[req 3fa91c]`.** `logs` with `source: "server"` and `request_id: "3fa91c"`, then with `since_minutes: 5` to see what happened around it, such as a browser crash and relaunch. Retry once the cause is clear, and mention the request id when you report the failure.

# Things that behave differently here

- Refs come from the latest snapshot of a tab. A ref such as f2e12 starts with the number of the document it belongs to: each iframe has its own, and the page gets a new one on every navigation or reload. A ref acts only on the very element the snapshot showed, and only while that element is still on the page with the same role and name and the tab, and the element's iframe, are still on the same document and the same address, hash included. Text around it may change freely (a quantity, a total, a counter, a timer), so several refs from one snapshot keep working through a form or a dialog. An element that is hidden or ignores the pointer for a moment (a load-more button while it loads, a button locked during a request) is waited for within the action's timeout, and `wait_for` with state hidden or detached on a ref waits on that very element, even after its name or the tab's address changed. A ref stays tied to its element through later snapshots and actions: a removed element is refused as gone, a renamed one with its old and new name, and an element whose name came back to the one the snapshot showed (a toggle pressed twice) works again. It is never moved to another element: after a reload, a navigation, going back, an address change without a load (a single-page app route, a hash route, an anchor jump, a route inside an iframe), or a re-render that replaced the element, or once the element's own role or name changed, an action refuses it with `Ref e12 cannot be used: …` and the reason. Then take a new snapshot; the error does not mean the element is gone from the page. A page that keeps the same element and only changes the text around it to show another item (a recycled list row or card) is not detected, so after such a change take a new snapshot before acting. Likewise, an element renamed while an action is already waiting for it to become enabled or visible (disabled, renamed, then enabled again within the action's timeout) is still acted on.
- `snapshot` shows only an open modal dialog, or else the page's single main landmark, and folds link-only navigation menus into one line; a line in brackets at the top says what was left out. `scope: "full"` returns the whole page, and a folded menu's ref as `target` lists its links; refs are the same either way. Above `max_chars` it keeps alerts, dialogs, headings and controls before text and links. `snapshot` with `diff: true` returns only the lines that changed since the last whole-page snapshot of the tab (an action's `include_snapshot` or `include_diff` also takes one), for example after `wait_for`. `snapshot` with `query` returns one line per matching element with its ref and its container (`button "Sil" [ref=e42] — in row "Silikon Kılıf 249 TL"`), ignoring case and diacritics: exact name matches first, then whole-word matches, controls before text, and elements that only contain the query last under `Also contains`.
- Each action names the element it acted on (`Clicked button "Save" (e12)`; a selector target also gets the element's ref), so a wrong or stale target shows at once. It reports whether the page navigated (with the HTTP status, a redirect, or Chrome's error page and the network error), changed or did not react, plus `Event:` lines for downloads (saved automatically to the `agent` subfolder of the user's download folder, with the path), new tabs (with their id, including OAuth popups and their closing) and popups the browser blocked. A separate check is needed only when that is not enough; `include_diff: true` returns just the snapshot lines an action changed.
- A navigation that does not finish in time is not an error: an action whose navigation is still waiting for the server, and a `navigate` that timed out, report `Still loading <url>` with what the tab shows. The action happened, so do not repeat it (a payment or a submit would go twice); `wait_for` or `snapshot` shows the page once it arrives. A snapshot or `read_page` within a few seconds of a page load first waits briefly for the page's requests and content to settle.
- `click` and `hover` take `x` and `y` viewport coordinates in CSS pixels instead of `target` for a canvas, map, chart or widget without refs; the result names the element at that point.
- An alert, confirm or prompt the page opens is not answered for you: the result says `A confirm dialog is open: "…"`, the page waits, and other calls on that tab fail with the same message until `dialog` accepts (with `text` for a prompt) or dismisses it. Read the message first; a confirm can delete something or leave a checkout. In `run_script`, dialogs on the script's tabs are accepted for it and logged (the tab's next result reports it too), unless the script listens for dialogs itself (`on`, `once` or `waitForEvent` on the page or context). Dialogs from your other calls on that tab, on a user tab, or on another session's tab stay open for their owner.
- Leaving a page that warns about unsaved changes is cancelled and reported; `force: true` on `navigate`, or on `tabs` with `close`, leaves anyway.
- `fill` on a custom dropdown or picker clicks it open and picks the option by name; when it cannot, the error says what to click.
- A result that starts with `Note: the tab moved to …` means the page navigated since your last call on that tab, by the user or by itself. `Note: this looks like a sign-in page` means the session probably expired.
- `human: true` on `click`, `hover`, `drag`, `fill`, `press` and `scroll` moves the mouse along curved paths and presses, types and scrolls with human timing. Pass it when a bot challenge or CAPTCHA appeared or a site rejects instant input; it is slower, so leave it off for normal browsing.
- A click that reports another element intercepting pointer events has a banner, modal or sticky header over the target; `dismiss_overlays` handles banners and modals, iframes included.
- Results have one shape: `read_page` text is always in `content` (with `format: "structured"`, the JSON), and the value `evaluate`, `run_script` and a job returned is always in `value`. Over `max_chars`, that field holds a clipped preview, `clipped` is `true`, `totalChars` is the full size and `file` is the path of the whole result; `run_script` logs over `max_chars` beside a value that fits come the same way, in `logs`. The structured `text` only says what came back. Called from code, parse the result with `JSON.parse` and check `clipped` before using `value` or `content`; with clipped `logs` beside a whole `value`, `clipped` and `file` describe the logs.
- `evaluate` runs in the page's own JavaScript world. In `run_script`, functions passed to `page.evaluate`, `evaluateHandle`, `$$eval` or a locator's `evaluate` and `evaluateAll` run there too, so page globals are visible; with the default patchright engine, `evaluateAll` on a locator chain holding a ref sees the page's elements but not its globals.
- With the default patchright engine, `logs` with `source: "page"` captures uncaught errors and unhandled rejections on every site, but the page's own console calls only on localhost, 127.0.0.1, `*.localhost` and `*.test` and on sites where `site` turned `console_capture` on (kept between sessions, from the next page load, so reload an open page after turning it on), unless the server runs with `WEB_AGENT_CONSOLE_HOOK=all` (console calls on every site) or `off` (neither); messages Chrome itself logs about the page, such as Permissions-Policy header errors, are captured everywhere, and the entries of a page whose calls are not captured start with a note saying so. With `WEB_AGENT_ENGINE=playwright` it captures everything on every site and `WEB_AGENT_CONSOLE_HOOK` has no effect.
- Secrets typed with `secret` are masked in tool results, in the text files the server writes (`save_pages` files, overflow files, reports, script and job output), in page text sent to the `ask_pages` model and in the server log; one-time codes for 2 minutes. Usernames, raw exports (`storage` export, `network` HAR), downloads, binary files and screenshots keep values as they are. Do not read a secret back out of the page.
- `ask_pages` answers come from a fast model reading quickly; check the facts a decision rests on against the page. `ask_pages` browses pages whose answer needs a click, hover or same-site link; for multi-step flows that write (forms, carts, sign-in), act yourself or use `run_script`.
- When the user closes the window or Chrome dies, the next `navigate` starts it again with the same profile; earlier tab ids are gone.

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

A script runs in its own worker thread: browser objects stay handles to the real page, everything else crosses as a copy, and a heavy synchronous loop does not hold up other calls; `timeout_ms` or `cancel` still ends it. In a background job, `log()` is all you see while it runs, and checking `signal.aborted` in long loops lets `run_script` with `job` and `cancel: true` stop it cleanly.

# Operating the daemon

The daemon is the systemd user unit `claude-code-pair-web-agent.service` on `http://127.0.0.1:29741/mcp`. `systemctl --user restart claude-code-pair-web-agent.service` restarts it and closes every open tab, so do it only when `tabs` or `logs` with `source: "server"` show the daemon itself is unhealthy. Its configuration is in `~/.config/web-agent-mcp`, and its profile, output, logs and site notes in `~/.local/share/claude-code-pair/web-agent`.

`ask_pages` and the model layer of `compare_design` call Anthropic's Messages API through the built-in adapter with the local Claude Code sign-in. An adapter module replaces it: an ES module (`.mjs` or `.ts`) default-exporting `{ name, complete({ system, prompt, model, maxTokens, images, signal }) }` (or a function returning one), loaded from `WEB_AGENT_ASK_ADAPTER` when set, otherwise from `~/.config/web-agent-mcp/ask-adapter.mjs` when it exists. `tabs` names the active adapter, and `examples/ask-adapter.example.ts` shows the shape.

`bun run import-profile` in the daemon directory copies cookies, saved passwords, history and site storage from the user's Chrome profile into the agent profile, after moving the previous agent profile aside. The daemon must be stopped first, and it replaces the agent's sessions, so the user runs it or asks for it.
