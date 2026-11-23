import { expect, test } from "bun:test";
import { describeError } from "../shared/errors.ts";
import { deviceIdentity, identityFor, resolveDevice, synthesizeMetadata } from "./emulate.ts";

function refusal(name: string) {
  try {
    resolveDevice(name);
  } catch (error) {
    return describeError(error);
  }
  return "accepted";
}

const REAL = synthesizeMetadata(
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/158.0.1.2 Safari/537.36",
  "Chrome/158.0.1.2",
);

test("synthesized client hints keep three brands", () => {
  expect(REAL.brands.length).toBe(3);
  expect(REAL.platform).toBe("Linux");
  expect(REAL.brands).toContainEqual({ brand: "Google Chrome", version: "158" });
});

test("a device name matches regardless of case", () => {
  expect(resolveDevice("iphone 15").name).toBe("iPhone 15");
});

test("an ambiguous device name lists the devices it could mean", () => {
  expect(refusal("iPad")).toMatch(/"iPad Mini"/);
});

test("an unknown device name suggests real names", () => {
  expect(refusal("Nokia 3310")).toMatch(/"iPhone 15"/);
});

test("an unknown device name lists every valid device name", () => {
  expect(refusal("Nokia 3310")).toMatch(
    /"Galaxy Tab S9"[\s\S]*"Moto G4"|"Moto G4"[\s\S]*"Galaxy Tab S9"/,
  );
});

test("an iPhone sends no client hints", () => {
  expect(deviceIdentity(resolveDevice("iPhone 15"), REAL).metadata).toBeUndefined();
});

test("an iPhone claims the Safari version that ships with its iOS version", () => {
  expect(deviceIdentity(resolveDevice("iPhone 15"), REAL).userAgent).toMatch(
    /OS 17_5 .*Version\/17\.5 Mobile/,
  );
});

test("an iPhone reports iPhone as its platform", () => {
  expect(deviceIdentity(resolveDevice("iPhone 15"), REAL).platform).toBe("iPhone");
});

test("an Android phone sends the reduced user agent of the running Chrome version", () => {
  expect(deviceIdentity(resolveDevice("Pixel 8"), REAL).userAgent).toBe(
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36",
  );
});

test("an Android phone names its model and Android version in client hints", () => {
  const metadata = deviceIdentity(resolveDevice("Pixel 8"), REAL).metadata;
  expect({
    platform: metadata?.platform,
    platformVersion: metadata?.platformVersion,
    model: metadata?.model,
    mobile: metadata?.mobile,
  }).toEqual({ platform: "Android", platformVersion: "14.0.0", model: "Pixel 8", mobile: true });
});

test("an Android phone keeps the browser's own brands", () => {
  expect(deviceIdentity(resolveDevice("Pixel 8"), REAL).metadata?.brands).toEqual(REAL.brands);
});

test("an Android tablet reports itself as not mobile", () => {
  expect(deviceIdentity(resolveDevice("Galaxy Tab S9"), REAL).metadata?.mobile).toBe(false);
});

test("a Windows Chrome user agent gets Windows client hints", () => {
  const identity = identityFor(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    REAL,
  );
  expect([identity.platform, identity.metadata?.platform]).toEqual(["Win32", "Windows"]);
});

test("a user agent of another Chrome version claims that version in its brands", () => {
  const identity = identityFor(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
    REAL,
  );
  expect(identity.metadata?.brands).toContainEqual({ brand: "Google Chrome", version: "150" });
});

test("an Edge user agent claims the Microsoft Edge brand", () => {
  const identity = identityFor(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36 Edg/158.0.0.0",
    REAL,
  );
  expect(identity.metadata?.brands.map((brand) => brand.brand)).toContain("Microsoft Edge");
});

test("a user agent that is not Chromium sends no client hints", () => {
  expect(identityFor("FixtureAgent/2.0", REAL).metadata).toBeUndefined();
});
