import { afterEach, expect } from "bun:test";
import type { HttpRequestEventMap, Interceptor } from "@mswjs/interceptors";
import { FetchInterceptor } from "@mswjs/interceptors/fetch/web";
import { type RequestHandler } from "msw";
import { defineNetwork, InterceptorSource } from "msw/experimental";
import { AsyncHandlersController } from "msw/node";

const simulatedNetworkFailures = new WeakSet<Error>();

export function simulateNetworkFailure(cause: Error): never {
  const failure = Object.assign(new TypeError("fetch failed", { cause }), {
    code: "UND_ERR_SOCKET",
    errno: 0,
  });
  simulatedNetworkFailures.add(failure);
  throw failure;
}

class QuietInterceptorSource extends InterceptorSource {
  readonly handlerExceptions: string[] = [];

  rejectSimulatedNetworkFailuresQuietly() {
    this.emitter.earlyOn("frame", ({ frame }) => {
      frame.events.on("unhandledException", ({ error, request }) => {
        if (error instanceof Error && simulatedNetworkFailures.has(error)) return;
        this.handlerExceptions.push(
          `${request.method} ${request.url}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      });
    });
  }
}

export const setupFetchServer = (...handlers: RequestHandler[]) => {
  // SAFETY: Bun's global fetch is patched only by the web build of FetchInterceptor, whose class is declared against the browser copy of Interceptor; msw's BatchInterceptor calls just apply, on and dispose on it, which both builds implement from the same source.
  const fetchInterceptor = new FetchInterceptor() as FetchInterceptor &
    Interceptor<HttpRequestEventMap>;
  const source = new QuietInterceptorSource({ interceptors: [fetchInterceptor] });
  const network = defineNetwork({
    sources: [source],
    handlers: new AsyncHandlersController(handlers),
    onUnhandledFrame: "error",
    context: { quiet: true },
  });
  afterEach(() => {
    expect(source.handlerExceptions.splice(0), "exceptions thrown by msw handlers").toStrictEqual(
      [],
    );
  });
  return {
    listen: async () => {
      await network.enable();
      source.rejectSimulatedNetworkFailuresQuietly();
    },
    close: () => network.disable(),
    use: (...next: RequestHandler[]) => network.use(...next),
    resetHandlers: () => network.resetHandlers(),
  };
};
