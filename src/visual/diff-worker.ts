import { parentPort, workerData } from "node:worker_threads";
import { analysisInputSchema, analyzeImages } from "./diff-analysis.ts";

const result = await analyzeImages(analysisInputSchema.parse(workerData));
const transfers = new Set<ArrayBuffer>();
for (const bytes of [
  result.reference.data,
  result.page.data,
  ...result.crops.flatMap((item) => [item.reference.data, item.page.data]),
]) {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  )
    transfers.add(bytes.buffer);
}
parentPort?.postMessage(result, [...transfers]);
