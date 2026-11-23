import type { AskImage } from "./adapter.ts";

export type AskDocument = { source: string; text: string; images?: AskImage[]; plain?: boolean };

export type AskMode = "answer" | "review";

export type Escalation = { source: string; hint: string };
