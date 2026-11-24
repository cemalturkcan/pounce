import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { parseJsonOrThrow } from "../src/shared/decode.ts";

const messageSchema = z.object({
  id: z.number().optional(),
  method: z.string().optional(),
  sessionId: z.string().optional(),
  params: z.record(z.string(), z.json()).optional(),
  result: z.record(z.string(), z.json()).optional(),
  error: z.object({ message: z.string() }).optional(),
});

type Message = z.infer<typeof messageSchema>;

type CdpParams = Record<string, string | boolean>;

const versionSchema = z.object({ webSocketDebuggerUrl: z.string() });
const targetSchema = z.object({ targetId: z.string() });
const attachedSchema = z.object({ sessionId: z.string() });
const navigatedSchema = z.object({ loaderId: z.string().optional() });
const frameNavigatedSchema = z.object({
  frame: z.object({ parentId: z.string().optional(), loaderId: z.string() }),
});

export class RawCdp {
  private lastId = 0;
  private readonly replies = new Map<number, (message: Message) => void>();
  private readonly listeners = new Set<(message: Message) => void>();
  private readonly socket: WebSocket;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      const message = parseJsonOrThrow(String(event.data), messageSchema);
      if (message.id === undefined) {
        for (const listener of this.listeners) listener(message);
        return;
      }
      this.replies.get(message.id)?.(message);
      this.replies.delete(message.id);
    });
  }

  static async fromProfile(profileDir: string) {
    const [port] = (await readFile(path.join(profileDir, "DevToolsActivePort"), "utf8")).split(
      "\n",
    );
    const response = await fetch(`http://127.0.0.1:${port}/json/version`);
    const { webSocketDebuggerUrl } = versionSchema.parse(await response.json());
    const socket = new WebSocket(webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve);
      socket.addEventListener("error", reject);
    });
    return new RawCdp(socket);
  }

  send<T>(schema: z.ZodType<T>, method: string, params: CdpParams = {}, sessionId?: string) {
    this.lastId += 1;
    const id = this.lastId;
    return new Promise<T>((resolve, reject) => {
      this.replies.set(id, (message) => {
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(schema.parse(message.result ?? {}));
      });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  private nextEvent(
    method: string,
    sessionId: string,
    matches: (params: Message["params"]) => boolean,
  ) {
    return new Promise<number>((resolve) => {
      const listener = (message: Message) => {
        if (
          message.method !== method ||
          message.sessionId !== sessionId ||
          !matches(message.params)
        )
          return;
        this.listeners.delete(listener);
        resolve(performance.now());
      };
      this.listeners.add(listener);
    });
  }

  async openUserTab(url: string) {
    const { targetId } = await this.send(targetSchema, "Target.createTarget", { url });
    const { sessionId } = await this.send(attachedSchema, "Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    await this.send(z.object({}), "Page.enable", {}, sessionId);
    return { targetId, sessionId };
  }

  async commitMs(tab: { sessionId: string }, url: string) {
    let loaderId: string | undefined;
    const committed = this.nextEvent("Page.frameNavigated", tab.sessionId, (params) => {
      const navigated = frameNavigatedSchema.safeParse(params);
      return (
        navigated.success &&
        !navigated.data.frame.parentId &&
        navigated.data.frame.loaderId === loaderId
      );
    });
    const loaded = this.nextEvent("Page.loadEventFired", tab.sessionId, () => true);
    const startedAt = performance.now();
    const navigated = await this.send(navigatedSchema, "Page.navigate", { url }, tab.sessionId);
    loaderId = navigated.loaderId;
    const committedAt = await committed;
    await loaded;
    return committedAt - startedAt;
  }

  async closeTab(tab: { targetId: string }) {
    await this.send(z.object({}).passthrough(), "Target.closeTarget", { targetId: tab.targetId });
  }

  close() {
    this.socket.close();
  }
}
