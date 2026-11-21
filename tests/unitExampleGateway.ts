import { http, HttpResponse } from "msw";
import { z } from "zod";
import { type JsonObject, jsonObjectSchema } from "../src/ask/adapter.ts";
import { setupFetchServer } from "./unitFetchServer.ts";

const EXAMPLE_GATEWAY_ENDPOINT = "https://llm-gateway.example.invalid/v1/messages";

const gatewayBodySchema = z.object({
  model: z.string(),
  tools: z.array(jsonObjectSchema).optional(),
  messages: z.array(z.object({ role: z.string(), content: z.array(jsonObjectSchema) })),
});

type GatewayBody = z.infer<typeof gatewayBodySchema>;
type GatewayReceived = { body?: GatewayBody };

export const createExampleGateway = () => {
  const server = setupFetchServer();
  const received: GatewayReceived = {};
  return {
    received,
    listen: () => server.listen(),
    close: () => server.close(),
    reset: () => {
      server.resetHandlers();
      received.body = undefined;
    },
    respondWith: (payload: JsonObject) => {
      server.use(
        http.post(EXAMPLE_GATEWAY_ENDPOINT, async ({ request }) => {
          received.body = gatewayBodySchema.parse(await request.json());
          return HttpResponse.json(payload);
        }),
      );
    },
  };
};
