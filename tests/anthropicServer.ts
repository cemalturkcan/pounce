import { afterAll, afterEach, beforeAll, expect } from "bun:test";
import { http } from "msw";
import { setupFetchServer } from "./unitFetchServer.ts";

export const messagesUrl = "https://api.anthropic.com/v1/messages?beta=true";
export const tokenUrl = "https://platform.claude.com/v1/oauth/token";
export const profileUrl = "https://api.anthropic.com/api/oauth/profile";

type AnthropicCall = {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  redirect: RequestRedirect;
  signal: AbortSignal;
};

type AnthropicReply = (call: AnthropicCall) => Response | Promise<Response>;

export function useAnthropicServer() {
  const calls: AnthropicCall[] = [];
  const queued: AnthropicReply[] = [];
  const unexpected: string[] = [];
  const unexpectedCall: AnthropicReply = (call) => {
    const description = `${call.method} ${call.url}`;
    unexpected.push(description);
    throw new Error(`No Anthropic reply set for ${description}`);
  };
  let reply = unexpectedCall;
  const answer = async ({ request }: { request: Request }) => {
    const call = {
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: await request.clone().text(),
      redirect: request.redirect,
      signal: request.signal,
    };
    calls.push(call);
    return (queued.shift() ?? reply)(call);
  };
  const server = setupFetchServer(
    http.post(messagesUrl.replace("?beta=true", ""), answer),
    http.post(tokenUrl, answer),
    http.get(profileUrl, answer),
  );
  const forget = () => {
    calls.length = 0;
    queued.length = 0;
    reply = unexpectedCall;
  };
  beforeAll(() => server.listen());
  afterEach(() => {
    forget();
    expect(unexpected.splice(0), "Anthropic calls without a reply").toStrictEqual([]);
  });
  afterAll(() => server.close());
  return {
    calls,
    reply: (next: AnthropicReply) => {
      reply = next;
    },
    replyOnce: (next: AnthropicReply) => {
      queued.push(next);
    },
    callsTo: (url: string) => calls.filter((call) => call.url === url),
    forget,
  };
}
