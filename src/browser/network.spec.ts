import { expect, test } from "bun:test";
import { urlPattern } from "./network.ts";

const beaconUrl = (size: number) => {
  const pairs: string[] = [];
  for (let index = 0; pairs.join("&").length < size; index += 1) pairs.push(`k${index}=v${index}`);
  return `http://127.0.0.1:8000/collect?${pairs.join("&")}`;
};

const elapsed = (pattern: string, url: string) => {
  const matcher = urlPattern(pattern);
  const started = performance.now();
  matcher.test(url);
  return performance.now() - started;
};

test("a pattern with several * finishes on a 2 KB URL within 50 ms", () => {
  expect(elapsed("*=*&*=*.json", beaconUrl(2_000))).toBeLessThan(50);
});

test("a pattern with several * finishes on a 20 KB URL within 50 ms", () => {
  expect(elapsed("*=*&*=*.json", beaconUrl(20_000))).toBeLessThan(50);
});

test("a leading * finishes on a 20 KB URL within 50 ms", () => {
  expect(elapsed("*.png", beaconUrl(20_000))).toBeLessThan(50);
});

test("a pattern without * matches a URL that contains it", () => {
  expect(urlPattern("api/items").test("https://shop.test/api/items?page=2")).toBe(true);
});

test("a pattern matches regardless of case", () => {
  expect(urlPattern("*/API/*.JSON").test("https://shop.test/api/items.json")).toBe(true);
});

test("the pieces around * must appear in order", () => {
  expect(urlPattern("*.json*/api/*").test("https://shop.test/api/items.json")).toBe(false);
});

test("the pieces around * may sit anywhere in the URL", () => {
  expect(urlPattern("api*second-").test("https://shop.test/api/data?second-call=1")).toBe(true);
});

test("a piece that is missing from the URL does not match", () => {
  expect(urlPattern("*.css").test("https://shop.test/style.png")).toBe(false);
});

test("a * matches no characters", () => {
  expect(urlPattern("items*.json").test("https://shop.test/items.json")).toBe(true);
});

test("a run of * stands for one *", () => {
  expect(urlPattern("**/api/**").test("https://shop.test/api/x")).toBe(true);
});

test("characters that are special in regular expressions match themselves", () => {
  expect(urlPattern("a.b?c").test("https://shop.test/aXb?c")).toBe(false);
});
