export function writeStderr(text: string) {
  try {
    process.stderr.write(`${text}\n`);
  } catch {
    return;
  }
}
