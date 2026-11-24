export const SAFE_WORD = /^[A-Za-z0-9_./:@%+=,-]+$/;

export function quotedWords(value: string) {
  return [...value.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map(([, quoted, bare]) =>
    quoted === undefined ? (bare ?? "") : quoted.replaceAll(/\\(.)/g, "$1"),
  );
}
