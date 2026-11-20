import { parentPort, workerData } from "node:worker_threads";
import { type AnalysisInput, analyzeImages } from "./diff-analysis.ts";

const input = workerData as AnalysisInput;
const asBuffer = (bytes: Uint8Array) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const result = await analyzeImages({ ...input, reference: asBuffer(input.reference), page: asBuffer(input.page) });
const transfers = new Set<ArrayBuffer>();
for (const bytes of [result.reference.data, result.page.data, ...result.crops.flatMap((item) => [item.reference.data, item.page.data])]) {
  if (bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) transfers.add(bytes.buffer);
}
parentPort?.postMessage(result, [...transfers]);
