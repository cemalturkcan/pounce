export function restoreTimeZone(previous: string | undefined) {
  if (previous === undefined) delete process.env.TZ;
  else process.env.TZ = previous;
}

export async function inTimeZone<T>(zone: string, run: () => T | Promise<T>) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    return await run();
  } finally {
    restoreTimeZone(previous);
  }
}
