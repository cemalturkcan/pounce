import { isDeepStrictEqual } from "node:util";
import type { AskAdapter, AskInput, AskMessage, AskReply, ConverseInput, ConverseReply } from "./ask-adapter.ts";

export type ScriptStep = (input: ConverseInput, index: number) => ConverseReply | Error | Promise<ConverseReply | Error>;

export type RecordedCall = Omit<ConverseInput, "signal">;

export type ScriptedAdapter = AskAdapter &
  Required<Pick<AskAdapter, "converse">> & {
    calls: RecordedCall[];
    replies: ConverseReply[];
    problems: string[];
  };

function record(input: ConverseInput): RecordedCall {
  const { signal: _signal, ...rest } = input;
  return structuredClone(rest);
}

function expectedHistory(previous: RecordedCall, reply: ConverseReply | undefined): AskMessage[] {
  return reply && reply.content.length ? [...previous.messages, { role: "assistant", content: reply.content }] : previous.messages;
}

export function scriptedAdapter(steps: ScriptStep[], options: { name?: string; onComplete?: (input: AskInput) => Promise<AskReply> } = {}): ScriptedAdapter {
  const calls: RecordedCall[] = [];
  const replies: ConverseReply[] = [];
  const problems: string[] = [];
  const fail = (message: string) => {
    problems.push(message);
    return new Error(message);
  };
  return {
    name: options.name ?? "scripted adapter",
    calls,
    replies,
    problems,
    complete: async (input) => {
      if (!options.onComplete) throw new Error("scripted adapter has no onComplete");
      return options.onComplete(input);
    },
    converse: async (input) => {
      const index = calls.length;
      const first = calls[0];
      const previous = calls.at(-1);
      calls.push(record(input));
      if (first && JSON.stringify(input.system) !== JSON.stringify(first.system)) throw fail(`system changed at call ${index + 1}`);
      if (first && JSON.stringify(input.tools) !== JSON.stringify(first.tools)) throw fail(`tools changed at call ${index + 1}`);
      if (previous) {
        const expected = expectedHistory(previous, replies[index - 1]);
        if (!isDeepStrictEqual(structuredClone(input.messages.slice(0, expected.length)), expected)) throw fail(`history changed at call ${index + 1}: earlier messages or the previous reply were not sent back unchanged`);
      }
      const step = steps[index];
      if (!step) throw new Error(`script exhausted at step ${index + 1}`);
      const outcome = await step(input, index);
      if (outcome instanceof Error) throw outcome;
      replies[index] = structuredClone(outcome);
      return outcome;
    },
  };
}
