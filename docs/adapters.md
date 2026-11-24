# ask_pages adapters

`ask_pages` and the model layer of `compare_design` send their prompts through an adapter: a small object that takes a
prompt and returns the model's reply. pounce ships two, and you can write your own for any other model or gateway.

## Which adapter runs

The `ask` setting in [`config.json`](configuration.md#configjson) picks it:

| `ask` mode | Adapter                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `claude`   | `<config dir>/ask-adapter.mjs` when that file exists, else the built-in adapter on your Claude Code login |
| `api-key`  | The built-in adapter on the stored key (or `ANTHROPIC_API_KEY`); without a key, calls refuse              |
| `adapter`  | The module at `path`                                                                                      |
| `off`      | None; calls refuse and point at `pounce install`                                                          |

`WEB_AGENT_ASK_ADAPTER`, an absolute path, overrides all four. The `tabs` tool shows the active adapter as
`askAdapter`. A module is loaded on the first call that needs it; a module that fails to load is tried again on the next
call, so you can fix it without restarting the daemon. `ask-adapter.mjs` in the config dir is checked on every call,
so creating or removing it takes effect without a restart as well.

The Claude Code adapter reads the session that `claude auth login` saved in `~/.claude/.credentials.json` (or in
`$CLAUDE_CONFIG_DIR`), so the daemon has to run as the signed-in user. It does not read the OS keychain: a Claude Code
install that keeps its session there needs the API key or another adapter. It refreshes an expiring session under
the same lock Claude Code uses.

## Writing one

An adapter is an ES module (`.mjs`, or `.ts` since pounce runs on Bun) whose default export is the adapter object or a
function, sync or async, that returns it:

```js
export default {
  name: "my gateway",
  async complete({ system, prompt, model, maxTokens, images = [], signal }) {
    const response = await fetch("https://llm.example.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.MY_LLM_KEY },
      body: JSON.stringify({
        model,
        system,
        max_tokens: maxTokens,
        messages: [
          {
            role: "user",
            content: [
              ...images.map((image) => ({
                type: "image",
                source: { type: "base64", media_type: image.mediaType, data: image.data },
              })),
              { type: "text", text: prompt },
            ],
          },
        ],
      }),
      signal,
    });
    if (!response.ok) throw new Error(`my gateway: HTTP ${response.status}`);
    const body = await response.json();
    return { text: body.content[0].text, stopReason: body.stop_reason, usage: body.usage };
  },
};
```

The types live in [`src/ask/adapter.ts`](../src/ask/adapter.ts) (`AskAdapter`, `AskInput`, `ConverseInput` and the
block types). [`examples/ask-adapter.example.ts`](../examples/ask-adapter.example.ts) is a fuller sketch against a
Messages-style API, with images and `converse`.

### complete

`complete(input)` answers one prompt and resolves to `{ text, usage?, stopReason? }`.

- `system`, `prompt`: the instructions and the pages' text.
- `images`: screenshots in order, each `{ mediaType, data, label? }` with `mediaType` one of `image/png`, `image/jpeg`,
  `image/webp` and `data` base64 without a `data:` prefix. Send them before the text.
- `model`: what the caller asked for. `haiku` (the default), `sonnet` and `opus` arrive as `claude-haiku-5-5`,
  `claude-sonnet-5-5` and `claude-opus-5-5`; any other string arrives unchanged.
- `maxTokens`: up to 128000 by default. Requests that large need a streaming API to avoid HTTP timeouts.
- `signal`: abort the request when it fires (a cancelled call or `timeout_ms`).

Pass the API's stop reason through as `stopReason`: `max_tokens` and `model_context_window_exceeded` are reported as
cut off with the partial answers, `interrupted` as interrupted, and `refusal` as a failed call. `usage` is any map of
numbers; pounce adds them up per call and logs them.

### Call sizes

`ask_pages` sets no limits by default: pages are not clipped, one call takes as many pages as fit about 3 million
characters, the output limit is 128000 tokens, and a call has no time limit unless `timeout_ms` sets one. A call the
API rejects because the prompt exceeds the context window or the request exceeds its size limit is split in half and
retried, down to single pages. `batch_chars`, `max_pages_per_batch`, `max_chars_per_page` and `max_output_tokens`
lower the sizes your adapter receives.

### converse (optional)

With `converse`, `ask_pages` can browse: a page whose answer sits behind a toggle, tab, hover or same-site link is
opened in a tab, and the model works there with browser tools until it calls `report`. Without `converse`, browsing is
skipped and the result says so.

`converse({ system, tools, messages, model, maxTokens, signal, conversationId })` resolves to
`{ content, stopReason?, usage? }`.

- `tools` are `{ name, description, inputSchema }` with a JSON Schema.
- `messages` alternate user turns (`text`, `image` and `tool_result` blocks, all results of a turn in one message, in
  call order) and assistant turns (the blocks of earlier replies).
- `content` holds `text` and `tool_use` (`{ id, name, input }`) blocks. Return each with its `raw` JSON, and anything
  you do not model (such as `thinking` or `redacted_thinking`) as `{ type: "opaque", raw }`.
- `system` and `tools` are the same on every turn and `messages` only grows, so send earlier assistant blocks back as
  their `raw` JSON, byte for byte; thinking signatures depend on it.
- `stopReason` is `tool_use`, `end_turn`, `max_tokens`, `refusal`, `pause_turn`, `model_context_window_exceeded`, or
  `interrupted` for a stream cut short. Tools of a cut-off or refused turn are not run.

The browsing model only looks. Submit buttons, controls in forms with password or payment fields, downloads,
`mailto:`/`tel:`/`javascript:` links and buttons named like buy, pay, subscribe, sign in, register, delete or send are
refused; navigation stays on the page's site (or `browse_sites`) and off checkout, cart, account and sign-in paths.
Each browsed page's transcript is saved next to the raw replies.
