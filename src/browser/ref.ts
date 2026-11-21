const REF_PATTERN = /^(?:f\d+)?e\d+$/;

export function parseRef(target: string) {
  const cleaned = target
    .trim()
    .replace(/^@/, "")
    .replace(/^\[?ref=([^\]\s]+)\]?$/, "$1");
  return REF_PATTERN.test(cleaned) ? cleaned : undefined;
}
