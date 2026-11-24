import { styleText } from "node:util";

export type Choice<T extends string> = { value: T; label: string; hint?: string };

export type Key =
  | { name: "up" | "down" | "enter" | "space" | "backspace" | "cancel" | "tab" }
  | { name: "char"; char: string };

export class PromptCancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

export type Prompts = {
  select<T extends string>(question: string, choices: Choice<T>[], initial: T): Promise<T>;
  pickMany<T extends string>(question: string, choices: Choice<T>[], initial: T[]): Promise<T[]>;
  confirm(question: string, initial: boolean): Promise<boolean>;
  secret(question: string): Promise<string>;
  text(question: string, initial: string): Promise<string>;
};

function escapeLength(text: string) {
  const second = text[1];
  if (second !== "[" && second !== "O") return Math.min(text.length, 2);
  let end = 2;
  while (end < text.length && /[0-9;]/.test(text[end] ?? "")) end += 1;
  return Math.min(text.length, end + 1);
}

export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let rest = chunk;
  while (rest.length) {
    const sequences: [string, Key][] = [
      ["\u001b[A", { name: "up" }],
      ["\u001b[B", { name: "down" }],
      ["\u001bOA", { name: "up" }],
      ["\u001bOB", { name: "down" }],
      ["\r\n", { name: "enter" }],
      ["\r", { name: "enter" }],
      ["\n", { name: "enter" }],
      [" ", { name: "space" }],
      ["\t", { name: "tab" }],
      ["\u007f", { name: "backspace" }],
      ["\b", { name: "backspace" }],
      ["\u0003", { name: "cancel" }],
      ["\u0004", { name: "cancel" }],
    ];
    const match = sequences.find(([sequence]) => rest.startsWith(sequence));
    if (match) {
      keys.push(match[1]);
      rest = rest.slice(match[0].length);
    } else if (rest.startsWith("\u001b")) {
      const escape = escapeLength(rest);
      rest = rest.slice(escape);
    } else {
      const char = [...rest][0] ?? "";
      if (char >= " ") keys.push({ name: "char", char });
      rest = rest.slice(char.length);
    }
  }
  return keys;
}

export type PickerState<T extends string> = {
  choices: Choice<T>[];
  query: string;
  cursor: number;
  selected: T[];
  done: boolean;
  cancelled: boolean;
};

function fuzzy(query: string, text: string) {
  let position = 0;
  for (const char of text.toLowerCase()) if (query[position] === char) position += 1;
  return position === query.length;
}

export function visibleChoices<T extends string>(state: PickerState<T>) {
  const query = state.query.trim().toLowerCase();
  return query
    ? state.choices.filter((choice) => fuzzy(query, choice.label) || fuzzy(query, choice.value))
    : state.choices;
}

export function pickerStart<T extends string>(choices: Choice<T>[], initial: T[]): PickerState<T> {
  return { choices, query: "", cursor: 0, selected: [...initial], done: false, cancelled: false };
}

export function pickerKey<T extends string>(state: PickerState<T>, key: Key): PickerState<T> {
  const visible = visibleChoices(state);
  const clamp = (cursor: number) => Math.max(0, Math.min(cursor, Math.max(visible.length - 1, 0)));
  if (key.name === "cancel") return { ...state, cancelled: true };
  if (key.name === "enter") return { ...state, done: true };
  if (key.name === "up") return { ...state, cursor: clamp(state.cursor - 1) };
  if (key.name === "down") return { ...state, cursor: clamp(state.cursor + 1) };
  if (key.name === "space" || key.name === "tab") {
    const focused = visible[state.cursor];
    if (!focused) return state;
    const selected = state.selected.includes(focused.value)
      ? state.selected.filter((value) => value !== focused.value)
      : [...state.selected, focused.value];
    return { ...state, selected };
  }
  if (key.name === "backspace") return { ...state, query: state.query.slice(0, -1), cursor: 0 };
  if (key.name !== "char") return state;
  const query = state.query + key.char;
  return { ...state, query, cursor: 0 };
}

export function pickerOrder<T extends string>(state: PickerState<T>) {
  return state.choices
    .map((choice) => choice.value)
    .filter((value) => state.selected.includes(value));
}

function renderPicker<T extends string>(question: string, state: PickerState<T>) {
  const visible = visibleChoices(state);
  const rows = visible.map((choice, index) => {
    const box = state.selected.includes(choice.value)
      ? styleText("green", "◼")
      : styleText("dim", "◻");
    const label = choice.hint ? `${choice.label} ${styleText("dim", choice.hint)}` : choice.label;
    return index === state.cursor
      ? `${styleText("cyan", "❯")} ${box} ${label}`
      : `  ${box} ${styleText("dim", label)}`;
  });
  return [
    `${styleText("cyan", "?")} ${question}`,
    `  ${styleText("dim", "Search:")} ${state.query}`,
    ...(visible.length ? rows : [`  ${styleText("yellow", "No matches")}`]),
    `  ${styleText("dim", "↑/↓ move • Space select • Enter confirm • type to search")}`,
  ];
}

type Terminal = {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

function keyLoop<S>(
  terminal: Terminal,
  start: S,
  step: (state: S, key: Key) => S,
  render: (state: S) => string[],
  finished: (state: S) => boolean,
) {
  const { input, output } = terminal;
  return new Promise<S>((resolve) => {
    let state = start;
    let drawn = 0;
    const draw = (lines: string[]) => {
      if (drawn) output.write(`\u001b[${drawn}A\r\u001b[0J`);
      output.write(`${lines.join("\n")}\n`);
      drawn = lines.length;
    };
    const onData = (chunk: Buffer) => {
      for (const key of parseKeys(chunk.toString("utf8"))) {
        state = step(state, key);
        if (finished(state)) {
          input.off("data", onData);
          input.setRawMode(false);
          input.pause();
          draw(render(state));
          resolve(state);
          return;
        }
      }
      draw(render(state));
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
    draw(render(state));
  });
}

function answered(question: string, answer: string) {
  return [`${styleText("green", "✔")} ${question} ${styleText("dim", answer)}`];
}

export function terminalPrompts(
  terminal: Terminal = { input: process.stdin, output: process.stdout },
): Prompts {
  return {
    async select(question, choices, initial) {
      const start = Math.max(
        0,
        choices.findIndex((choice) => choice.value === initial),
      );
      type State = { cursor: number; done: boolean; cancelled: boolean };
      const final = await keyLoop<State>(
        terminal,
        { cursor: start, done: false, cancelled: false },
        (state, key) => {
          if (key.name === "cancel") return { ...state, cancelled: true };
          if (key.name === "enter") return { ...state, done: true };
          if (key.name === "up") return { ...state, cursor: Math.max(0, state.cursor - 1) };
          if (key.name === "down")
            return { ...state, cursor: Math.min(choices.length - 1, state.cursor + 1) };
          return state;
        },
        (state) =>
          state.done
            ? answered(question, choices[state.cursor]?.label ?? "")
            : [
                `${styleText("cyan", "?")} ${question}`,
                ...choices.map((choice, index) => {
                  const label = choice.hint
                    ? `${choice.label} ${styleText("dim", choice.hint)}`
                    : choice.label;
                  return index === state.cursor
                    ? `${styleText("cyan", "❯")} ${label}`
                    : `  ${styleText("dim", label)}`;
                }),
              ],
        (state) => state.done || state.cancelled,
      );
      if (final.cancelled) throw new PromptCancelled();
      const chosen = choices[final.cursor];
      if (!chosen) throw new PromptCancelled();
      return chosen.value;
    },
    async pickMany(question, choices, initial) {
      const final = await keyLoop(
        terminal,
        pickerStart(choices, initial),
        pickerKey,
        (state) =>
          state.done
            ? answered(
                question,
                choices
                  .filter((choice) => state.selected.includes(choice.value))
                  .map((choice) => choice.label)
                  .join(", ") || "none",
              )
            : renderPicker(question, state),
        (state) => state.done || state.cancelled,
      );
      if (final.cancelled) throw new PromptCancelled();
      return pickerOrder(final);
    },
    async confirm(question, initial) {
      type State = { value: boolean; done: boolean; cancelled: boolean };
      const hint = initial ? "(Y/n)" : "(y/N)";
      const final = await keyLoop<State>(
        terminal,
        { value: initial, done: false, cancelled: false },
        (state, key) => {
          if (key.name === "cancel") return { ...state, cancelled: true };
          if (key.name === "enter") return { ...state, done: true };
          if (key.name === "char" && /[yY]/.test(key.char))
            return { value: true, done: true, cancelled: false };
          if (key.name === "char" && /[nN]/.test(key.char))
            return { value: false, done: true, cancelled: false };
          return state;
        },
        (state) =>
          state.done
            ? answered(question, state.value ? "yes" : "no")
            : [`${styleText("cyan", "?")} ${question} ${styleText("dim", hint)}`],
        (state) => state.done || state.cancelled,
      );
      if (final.cancelled) throw new PromptCancelled();
      return final.value;
    },
    async secret(question) {
      type State = { value: string; done: boolean; cancelled: boolean };
      const final = await keyLoop<State>(
        terminal,
        { value: "", done: false, cancelled: false },
        (state, key) => {
          if (key.name === "cancel") return { ...state, cancelled: true };
          if (key.name === "enter") return { ...state, done: state.value.length > 0 };
          if (key.name === "backspace") return { ...state, value: state.value.slice(0, -1) };
          if (key.name === "char") return { ...state, value: state.value + key.char };
          if (key.name === "space") return { ...state, value: `${state.value} ` };
          return state;
        },
        (state) =>
          state.done
            ? answered(question, "(hidden)")
            : [
                `${styleText("cyan", "?")} ${question} ${styleText("dim", "•".repeat(Math.min(state.value.length, 40)))}`,
              ],
        (state) => state.done || state.cancelled,
      );
      if (final.cancelled) throw new PromptCancelled();
      return final.value.trim();
    },
    async text(question, initial) {
      type State = { value: string; done: boolean; cancelled: boolean };
      const final = await keyLoop<State>(
        terminal,
        { value: initial, done: false, cancelled: false },
        (state, key) => {
          if (key.name === "cancel") return { ...state, cancelled: true };
          if (key.name === "enter") return { ...state, done: state.value.trim().length > 0 };
          if (key.name === "backspace") return { ...state, value: state.value.slice(0, -1) };
          if (key.name === "char") return { ...state, value: state.value + key.char };
          if (key.name === "space") return { ...state, value: `${state.value} ` };
          return state;
        },
        (state) =>
          state.done
            ? answered(question, state.value)
            : [`${styleText("cyan", "?")} ${question} ${state.value}`],
        (state) => state.done || state.cancelled,
      );
      if (final.cancelled) throw new PromptCancelled();
      return final.value.trim();
    },
  };
}
