import { AsyncLocalStorage } from "node:async_hooks";

export type CallScope = {
  signal: AbortSignal;
  steps: string[];
  acting?: string;
  selectors?: Map<string, string>;
  notes?: string[];
};

const scope = new AsyncLocalStorage<CallScope>();

export function inCallScope<T>(call: CallScope, work: () => T) {
  return scope.run(call, work);
}

export function checkpoint() {
  scope.getStore()?.signal.throwIfAborted();
}

export function recordStep(text: string) {
  scope.getStore()?.steps.push(text);
}

export function recordAction(text: string) {
  const call = scope.getStore();
  if (call) call.acting = text;
}

export function recordedSelectors() {
  return scope.getStore()?.selectors;
}

export function recordSelector(locator: string, selector: string) {
  const call = scope.getStore();
  if (!call) return;
  call.selectors ??= new Map();
  call.selectors.set(locator, selector);
}

export function recordNote(text: string) {
  const call = scope.getStore();
  if (!call) return;
  call.notes ??= [];
  call.notes.push(text);
}
