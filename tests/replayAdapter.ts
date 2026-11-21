import type { AskAdapter } from "../src/ask/adapter.ts";
import { AppendSignatures, readRecording } from "../src/browse/transcript.ts";

export async function replayAdapter(
  dir: string,
): Promise<AskAdapter & Required<Pick<AskAdapter, "converse">>> {
  const recording = await readRecording(dir);
  const signatures = new AppendSignatures();
  let turn = 0;
  return {
    name: `replay of ${dir}`,
    complete: async () => {
      throw new Error("a replay adapter only answers converse()");
    },
    converse: async (input) => {
      turn += 1;
      const line = recording.turns[turn - 1];
      const diverged = (why: string) => new Error(`replay diverged at turn ${turn}: ${why}`);
      if (!line) throw diverged(`the recording has only ${recording.turns.length} turns`);
      const names = input.tools.map((tool) => tool.name).join(", ");
      const recordedNames = recording.tools.join(", ");
      if (names !== recordedNames)
        throw diverged(`tools are ${names}, the recording has ${recordedNames}`);
      const live = signatures.next(input.messages);
      if (live !== line.appended)
        throw diverged(`the appended messages are ${live}, the recording has ${line.appended}`);
      signatures.replied(line.reply);
      if (line.error || !line.reply)
        throw new Error(line.error ?? "the recorded turn has no reply");
      return structuredClone(line.reply);
    },
  };
}
