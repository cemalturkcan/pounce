import { expect, test } from "bun:test";
import { isLocalNetworkHost, ProfileSettings } from "./profile-settings.ts";

test("loopback and private hosts count as local network", () => {
  for (const host of [
    "localhost",
    "app.localhost",
    "127.0.0.1",
    "127.8.0.2",
    "[::1]",
    "10.1.2.3",
    "172.20.0.5",
    "192.168.1.1",
    "169.254.1.1",
    "fd12:3456::1",
  ]) {
    expect(isLocalNetworkHost(host)).toBe(true);
  }
});

test("public hosts and look-alikes do not count as local network", () => {
  for (const host of [
    "example.com",
    "8.8.8.8",
    "172.32.0.1",
    "192.169.1.1",
    "localhost.example.com",
    "127.0.0.1.nip.io",
  ]) {
    expect(isLocalNetworkHost(host)).toBe(false);
  }
});

function recordingContext() {
  let granted = new Map<string, Set<string>>();
  const context = {
    grantPermissions: async (names: string[], options?: { origin?: string }) => {
      const origin = options?.origin ?? "*";
      const merged = granted.get(origin) ?? new Set<string>();
      for (const name of names) merged.add(name);
      granted.set(origin, merged);
    },
    clearPermissions: async () => {
      granted = new Map();
    },
  };
  return {
    context,
    granted: (origin: string) => [...(granted.get(origin) ?? [])].toSorted(),
  };
}

test("releasing a held grant keeps the grants made with site grant", async () => {
  const settings = new ProfileSettings();
  const { context, granted } = recordingContext();
  const holder = "tab-a";
  await settings.grant(context, "https://maps.example", ["notifications"]);
  await settings.hold(context, holder, "https://maps.example", ["geolocation"]);
  await settings.release(context, holder);
  expect(granted("https://maps.example")).toEqual(["notifications"]);
});

test("releasing a held grant removes it", async () => {
  const settings = new ProfileSettings();
  const { context, granted } = recordingContext();
  const holder = "tab-a";
  await settings.hold(context, holder, "https://maps.example", ["geolocation"]);
  await settings.release(context, holder);
  expect(granted("https://maps.example")).toEqual([]);
});

test("releasing one holder keeps another holder's grant", async () => {
  const settings = new ProfileSettings();
  const { context, granted } = recordingContext();
  const first = "tab-a";
  await settings.hold(context, first, "https://maps.example", ["geolocation"]);
  await settings.hold(context, "tab-b", "https://other.example", ["geolocation"]);
  await settings.release(context, first);
  expect(granted("https://other.example")).toEqual(["geolocation"]);
});

test("clearing the grants made with site grant keeps a held grant", async () => {
  const settings = new ProfileSettings();
  const { context, granted } = recordingContext();
  await settings.hold(context, "tab-a", "https://maps.example", ["geolocation"]);
  await settings.grant(context, "https://maps.example", ["notifications"]);
  await settings.clearGrants(context);
  expect(granted("https://maps.example")).toEqual(["geolocation"]);
});
