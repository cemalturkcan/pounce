import { expect, test } from "bun:test";
import { synthesizeMetadata } from "./emulate.ts";

test("synthesized client hints keep three brands", () => {
  const metadata = synthesizeMetadata(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.1.2 Safari/537.36",
    "Chrome/140.0.1.2",
  );
  expect(metadata.brands.length).toBe(3);
  expect(metadata.platform).toBe("Linux");
  expect(metadata.brands).toContainEqual({ brand: "Google Chrome", version: "140" });
});
