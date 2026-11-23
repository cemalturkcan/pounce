import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { inTimeZone } from "../../tests/timeZone.ts";
import {
  appendSiteNote,
  consoleCaptureSites,
  countNoteLines,
  mainLabel,
  registrableDomain,
  setConsoleCapture,
  siteHost,
} from "./sites.ts";

test("siteHost normalises hosts and URLs into file-safe names", () => {
  expect(siteHost("https://www.Shop.example.com/a?b=1")).toBe("shop.example.com");
  expect(siteHost("shop.example.com")).toBe("shop.example.com");
  expect(siteHost("http://localhost:3000/x")).toBe("localhost");
  expect(() => siteHost("about:blank")).toThrow(/no usable host name|not a host/);
  expect(countNoteLines("# host\n\n- 2026-01-01: a\n- 2026-01-02: b\n")).toBe(2);
});

test("the main label of a host is its registrable name", () => {
  expect(mainLabel("shop.example.com")).toBe("example");
});

test("the main label of a host under a two-part suffix skips the suffix", () => {
  expect(mainLabel("www.bank.co.uk")).toBe("bank");
});

test("the main label of a com.tr host skips com", () => {
  expect(mainLabel("shop.firma.com.tr")).toBe("firma");
});

test("the main label of a single-label host is the host", () => {
  expect(mainLabel("localhost")).toBe("localhost");
});

test("the main label of an IP address is the whole address", () => {
  expect(mainLabel("127.0.0.1")).toBe("127.0.0.1");
});

test("the main label of a two-label host is its first label", () => {
  expect(mainLabel("example.com")).toBe("example");
});

test("the main label of a host whose registrable name is also a common second-level label is that name", () => {
  expect(mainLabel("www.web.de")).toBe("web");
});

test("two subdomains of web.de are one site", () => {
  expect(registrableDomain("www.web.de")).toBe(registrableDomain("mail.web.de"));
});

test("dr.dk and www.dr.dk are one site", () => {
  expect(registrableDomain("www.dr.dk")).toBe(registrableDomain("dr.dk"));
});

test("two domains under co.uk are different sites", () => {
  expect(registrableDomain("example.co.uk")).not.toBe(registrableDomain("other.co.uk"));
});

test("two subdomains of a com.tr domain are one site", () => {
  expect(registrableDomain("shop.example.com.tr")).toBe(registrableDomain("www.example.com.tr"));
});

test("two github.io pages of different owners are different sites", () => {
  expect(registrableDomain("alice.github.io")).not.toBe(registrableDomain("bob.github.io"));
});

test("localhost is its own site", () => {
  expect(registrableDomain("localhost")).toBe("localhost");
});

test("an IPv4 address is its own site", () => {
  expect(registrableDomain("192.168.1.5")).toBe("192.168.1.5");
});

test("an IPv6 address is its own site", () => {
  expect(registrableDomain("[2001:db8::1]")).toBe("[2001:db8::1]");
});

test("a site note is dated with the local date", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "site-notes-"));
  try {
    const file = await inTimeZone("Europe/Istanbul", () =>
      appendSiteNote(dir, "shop.example", "late note", new Date("2026-01-02T23:00:00.000Z")),
    );
    expect(await readFile(file, "utf8")).toContain("- 2026-01-03: late note");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function inSitesDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(tmpdir(), "web-agent-sites-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("a sites folder without settings captures console calls on no site", async () => {
  await inSitesDir(async (dir) => {
    expect(await consoleCaptureSites(path.join(dir, "missing"))).toStrictEqual([]);
  });
});

test("console capture turned on for a host is kept for its registrable domain", async () => {
  await inSitesDir(async (dir) => {
    await setConsoleCapture(dir, "shop.example.co.uk", true);
    expect(await consoleCaptureSites(dir)).toStrictEqual(["example.co.uk"]);
  });
});

test("turning console capture off for a site keeps it on for the others", async () => {
  await inSitesDir(async (dir) => {
    await setConsoleCapture(dir, "example.com", true);
    await setConsoleCapture(dir, "other.example", true);
    await setConsoleCapture(dir, "www.example.com", false);
    expect(await consoleCaptureSites(dir)).toStrictEqual(["other.example"]);
  });
});

test("console capture is written to the settings file of the sites folder", async () => {
  await inSitesDir(async (dir) => {
    await setConsoleCapture(dir, "example.com", true);
    expect(JSON.parse(await readFile(path.join(dir, "settings.json"), "utf8"))).toStrictEqual({
      "example.com": { consoleCapture: true },
    });
  });
});

test("three concurrent console capture changes all succeed", async () => {
  await inSitesDir(async (dir) => {
    const results = await Promise.allSettled(
      ["a.race1.example", "b.race2.example", "c.race3.example"].map((host) =>
        setConsoleCapture(dir, host, true),
      ),
    );
    expect(results.map((result) => result.status)).toStrictEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });
});

test("three concurrent console capture changes are all kept", async () => {
  await inSitesDir(async (dir) => {
    await Promise.allSettled(
      ["a.race1.example", "b.race2.example", "c.race3.example"].map((host) =>
        setConsoleCapture(dir, host, true),
      ),
    );
    expect((await consoleCaptureSites(dir)).toSorted()).toStrictEqual([
      "race1.example",
      "race2.example",
      "race3.example",
    ]);
  });
});
