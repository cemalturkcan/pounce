import { randomUUID } from "node:crypto";
import { type BrowserContext, type CDPSession, devices, type Page } from "playwright-core";
import { z } from "zod";
import { withDeadline } from "../shared/async.ts";
import { ToolError } from "../shared/errors.ts";
import { DRAW_WAIT_MS } from "./manager.ts";
import type { ProfileSettings } from "./profile-settings.ts";

declare global {
  interface Navigator {
    userAgentData?: { getHighEntropyValues(hints: string[]): Promise<object> };
  }
}

const NETWORK_PRESETS = {
  slow3g: {
    latency: 2000,
    downloadThroughput: (500 * 1000 * 0.8) / 8,
    uploadThroughput: (500 * 1000 * 0.8) / 8,
    connectionType: "cellular3g" as const,
  },
  fast3g: {
    latency: 562.5,
    downloadThroughput: (1.6 * 1000 * 1000 * 0.9) / 8,
    uploadThroughput: (750 * 1000 * 0.9) / 8,
    connectionType: "cellular3g" as const,
  },
};

const screenSchema = z.object({
  screen: z.object({ width: z.number(), height: z.number() }).optional(),
});

const DEVICES = Object.entries(devices).map(([name, descriptor]) => ({
  name,
  userAgent: descriptor.userAgent,
  viewport: descriptor.viewport,
  deviceScaleFactor: descriptor.deviceScaleFactor,
  isMobile: descriptor.isMobile,
  hasTouch: descriptor.hasTouch,
  screen: screenSchema.safeParse(descriptor).data?.screen,
}));

type Device = (typeof DEVICES)[number];

const EXAMPLE_DEVICES =
  '"iPhone 15", "iPhone 15 Pro Max", "Pixel 8", "Galaxy S24", "iPad (gen 11)", "iPad Pro 11" or "Desktop Chrome"';

const HIDE_CLIENT_HINTS = "delete Navigator.prototype.userAgentData;";

type Size = { width: number; height: number };

type EmulateInput = {
  device?: Device | "";
  viewport?: Size & { mobile?: boolean; scale?: number };
  colorScheme?: "light" | "dark" | "none";
  reducedMotion?: "reduce" | "no-preference" | "none";
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  timezone?: string;
  locale?: string;
  offline?: boolean;
  network?: keyof typeof NETWORK_PRESETS | "none";
  userAgent?: string;
};

const brandSchema = z.object({ brand: z.string(), version: z.string() });

type Brand = z.infer<typeof brandSchema>;

const hintsSchema = z.object({
  brands: z.array(brandSchema).optional(),
  fullVersionList: z.array(brandSchema).optional(),
  uaFullVersion: z.string().optional(),
  platform: z.string().optional(),
  platformVersion: z.string().optional(),
  architecture: z.string().optional(),
  model: z.string().optional(),
  mobile: z.boolean().optional(),
  bitness: z.string().optional(),
  wow64: z.boolean().optional(),
});

type UserAgentMetadata = {
  brands: Brand[];
  fullVersionList?: Brand[];
  fullVersion?: string;
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness?: string;
  wow64?: boolean;
};

type Identity = { userAgent: string; platform?: string; metadata?: UserAgentMetadata };

type RealUserAgent = { userAgent: string; metadata: UserAgentMetadata; observed: boolean };

const realAgents = new WeakMap<BrowserContext, RealUserAgent>();

export function resolveDevice(name: string): Device {
  const wanted = name.trim().toLowerCase();
  const exact = DEVICES.find((device) => device.name.toLowerCase() === wanted);
  if (exact) return exact;
  const portrait = DEVICES.filter((device) => !device.name.endsWith(" landscape"));
  const close = portrait
    .filter((device) => device.name.toLowerCase().includes(wanted))
    .map((device) => `"${device.name}"`);
  throw new ToolError(
    `There is no device named "${name}".`,
    close.length
      ? `Devices with that in their name: ${close.join(", ")}.`
      : `Use a name such as ${EXAMPLE_DEVICES}; add " landscape" for the landscape version. All names: ${portrait.map((device) => `"${device.name}"`).join(", ")}.`,
  );
}

async function readHints(page: Page) {
  const hints = await page
    .evaluate(async () => {
      const data = navigator.userAgentData;
      if (!data) return undefined;
      return data.getHighEntropyValues([
        "architecture",
        "bitness",
        "brands",
        "fullVersionList",
        "mobile",
        "model",
        "platform",
        "platformVersion",
        "wow64",
        "uaFullVersion",
      ]);
    })
    .catch(() => undefined);
  const decoded = hintsSchema.safeParse(hints);
  return decoded.success ? decoded.data : undefined;
}

const versionTriple = (version: string) =>
  [...version.split(/[._]/), "0", "0"].slice(0, 3).join(".");

function systemOf(userAgent: string) {
  const android = /Android ([\d.]+)/.exec(userAgent);
  const apple = /OS ([\d_]+) like Mac OS X/.exec(userAgent);
  const mac = /Mac OS X ([\d_]+)/.exec(userAgent);
  if (/Windows/.test(userAgent))
    return { platform: "Windows", navigator: "Win32", version: "10.0.0", desktop: true };
  if (/iPhone/.test(userAgent))
    return { platform: "iOS", navigator: "iPhone", version: versionTriple(apple?.[1] ?? "") };
  if (/iPad/.test(userAgent))
    return { platform: "iOS", navigator: "iPad", version: versionTriple(apple?.[1] ?? "") };
  if (android)
    return {
      platform: "Android",
      navigator: "Linux armv8l",
      version: versionTriple(android[1] ?? ""),
    };
  if (/CrOS/.test(userAgent))
    return { platform: "Chrome OS", navigator: "Linux x86_64", version: "", desktop: true };
  if (mac)
    return {
      platform: "macOS",
      navigator: "MacIntel",
      version: versionTriple(mac[1] ?? ""),
      desktop: true,
    };
  if (/Linux/.test(userAgent))
    return { platform: "Linux", navigator: "Linux x86_64", version: "", desktop: true };
  return { platform: "", navigator: undefined, version: "" };
}

export function synthesizeMetadata(userAgent: string, product: string): UserAgentMetadata {
  const version =
    /Chrome\/([\d.]+)/.exec(product)?.[1] ?? /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? "0.0.0.0";
  const major = version.split(".")[0] ?? "0";
  const brand = /Headless/i.test(product) ? "HeadlessChrome" : "Google Chrome";
  return {
    brands: [
      { brand: "Not_A Brand", version: "99" },
      { brand: "Chromium", version: major },
      { brand, version: major },
    ],
    fullVersionList: [
      { brand: "Not_A Brand", version: "99.0.0.0" },
      { brand: "Chromium", version },
      { brand, version },
    ],
    fullVersion: version,
    platform: systemOf(userAgent).platform || "Linux",
    platformVersion: "",
    architecture: /arm|aarch64/i.test(userAgent) ? "arm" : "x86",
    model: "",
    mobile: /Mobile|Android/.test(userAgent),
  };
}

const isOwnBrand = (brand: Brand) =>
  brand.brand !== "Chromium" && !/Not.?A.?Brand/i.test(brand.brand);

function brandsFor(userAgent: string, version: string, real: UserAgentMetadata) {
  const major = version.split(".")[0] ?? "0";
  const brand = /Edg\//.test(userAgent) ? "Microsoft Edge" : "Google Chrome";
  const rename = (entry: Brand) => (isOwnBrand(entry) ? { ...entry, brand } : entry);
  const sameMajor = real.brands.some(
    (entry) => entry.brand === "Chromium" && entry.version === major,
  );
  const source = sameMajor ? real : synthesizeMetadata(userAgent, `Chrome/${version}`);
  return {
    brands: source.brands.map(rename),
    fullVersionList: source.fullVersionList?.map(rename),
    fullVersion: source.fullVersion,
  };
}

function androidModel(userAgent: string) {
  const model = /Android [\d.]+; ([^;)]+?)(?: Build\/[^;)]*)?\)/.exec(userAgent)?.[1] ?? "";
  return model === "K" ? "" : model;
}

export function identityFor(
  userAgent: string,
  real: UserAgentMetadata,
  device: { model?: string; platformVersion?: string } = {},
): Identity {
  const system = systemOf(userAgent);
  const version = /Chrome\/([\d.]+)/.exec(userAgent)?.[1];
  if (!version) return { userAgent, platform: system.navigator };
  const desktop = system.desktop === true;
  return {
    userAgent,
    platform: system.navigator,
    metadata: {
      ...brandsFor(userAgent, version, real),
      platform: system.platform,
      platformVersion: device.platformVersion ?? system.version,
      architecture: desktop ? "x86" : "",
      bitness: desktop ? "64" : "",
      model: device.model ?? androidModel(userAgent),
      mobile: /Mobile/.test(userAgent),
      wow64: false,
    },
  };
}

export function deviceIdentity(device: Device, real: UserAgentMetadata): Identity {
  const original = device.userAgent;
  const apple = /OS (\d+)_(\d+)[\d_]* like Mac OS X/.exec(original);
  if (apple)
    return identityFor(
      original.replace(/Version\/[\d.]+/, `Version/${apple[1]}.${apple[2]}`),
      real,
    );
  if (!/Chrome\//.test(original)) return identityFor(original, real);
  const major = real.brands.find((entry) => entry.brand === "Chromium")?.version ?? "0";
  const reduced = original
    .replace(/Chrome\/[\d.]+/, `Chrome/${major}.0.0.0`)
    .replace(/Edg\/[\d.]+/, `Edg/${major}.0.0.0`)
    .replace(/\(Linux; Android [^)]*\)/, "(Linux; Android 10; K)");
  const android = /Android ([\d.]+)/.exec(original)?.[1];
  return identityFor(reduced, real, {
    model: androidModel(original),
    platformVersion: android ? versionTriple(android) : undefined,
  });
}

async function realUserAgent(page: Page, session: CDPSession): Promise<RealUserAgent> {
  const context = page.context();
  const cached = realAgents.get(context);
  if (cached?.observed) return cached;
  const version = await session.send("Browser.getVersion");
  const userAgent =
    (await page.evaluate(() => navigator.userAgent).catch(() => undefined)) ?? version.userAgent;
  const hints = await readHints(page);
  const brands = hints?.brands;
  const real: RealUserAgent = brands?.length
    ? {
        userAgent,
        observed: true,
        metadata: {
          brands,
          fullVersionList: hints?.fullVersionList,
          fullVersion: hints?.uaFullVersion,
          platform: hints?.platform ?? "",
          platformVersion: hints?.platformVersion ?? "",
          architecture: hints?.architecture ?? "",
          model: hints?.model ?? "",
          mobile: hints?.mobile ?? false,
          bitness: hints?.bitness,
          wow64: hints?.wow64,
        },
      }
    : (cached ?? {
        userAgent,
        observed: false,
        metadata: synthesizeMetadata(userAgent, version.product),
      });
  realAgents.set(context, real);
  return real;
}

type Metrics = Size & {
  deviceScaleFactor: number;
  mobile: boolean;
  screenWidth?: number;
  screenHeight?: number;
};

type EmulationState = {
  real: RealUserAgent;
  session: CDPSession;
  settings: Map<string, string>;
  media: Map<string, string>;
  offline: boolean;
  network: keyof typeof NETWORK_PRESETS | "none";
  userAgent?: string;
  locale?: string;
  device?: { name: string; identity: Identity; touch: boolean };
  metrics?: Metrics;
  touch: boolean;
  size?: Size;
  sizeBefore?: Size;
  hidingHints?: string;
  grantHolder: string;
};

const states = new WeakMap<Page, EmulationState>();

const THIS_BROWSER = "this browser";

const loadedAs = new WeakMap<Page, string>();

function presentedAs(state: EmulationState | undefined) {
  if (state?.userAgent) return `user agent ${state.userAgent}`;
  return state?.device?.name ?? THIS_BROWSER;
}

async function watchLoads(page: Page) {
  if (loadedAs.has(page)) return;
  loadedAs.set(page, THIS_BROWSER);
  const watcher = await page.context().newCDPSession(page);
  watcher.on("Page.frameNavigated", ({ frame }) => {
    if (!frame.parentId) loadedAs.set(page, presentedAs(states.get(page)));
  });
  await watcher.send("Page.enable");
}

async function repaint(state: EmulationState) {
  await withDeadline(
    state.session.send("Page.captureScreenshot", {
      format: "jpeg",
      quality: 1,
      clip: { x: 0, y: 0, width: 1, height: 1, scale: 1 },
    }),
    DRAW_WAIT_MS,
  ).catch(() => undefined);
}

function reloadNote(page: Page, state: EmulationState) {
  const now = presentedAs(state);
  const before = loadedAs.get(page) ?? THIS_BROWSER;
  if (now === before || !/^(https?|file):/i.test(page.url())) return undefined;
  return `The page was loaded as ${before} and keeps what it detected then; reload it (navigate with url "reload") so it loads as ${now}.`;
}

export const emulatesOffline = (page: Page) => states.get(page)?.offline === true;

async function stateFor(page: Page, profile: ProfileSettings) {
  const existing = states.get(page);
  if (existing) return existing;
  const session = await page.context().newCDPSession(page);
  const real = await realUserAgent(page, session);
  const state: EmulationState = {
    real,
    session,
    settings: new Map(),
    media: new Map(),
    offline: false,
    network: "none",
    touch: false,
    grantHolder: randomUUID(),
  };
  states.set(page, state);
  await watchLoads(page);
  const context = page.context();
  page.once("close", () => {
    states.delete(page);
    void profile.release(context, state.grantHolder).catch(() => undefined);
  });
  return state;
}

async function applyNetwork(state: EmulationState) {
  const preset = state.network === "none" ? undefined : NETWORK_PRESETS[state.network];
  const conditions = {
    latency: preset?.latency ?? 0,
    downloadThroughput: preset?.downloadThroughput ?? -1,
    uploadThroughput: preset?.uploadThroughput ?? -1,
    connectionType: preset?.connectionType,
  };
  const active = state.offline || preset !== undefined;
  await state.session.send("Network.emulateNetworkConditionsByRule", {
    emulateOfflineServiceWorker: state.offline,
    matchedNetworkConditions: active
      ? [{ urlPattern: "", ...conditions, offline: state.offline }]
      : [],
  });
  await state.session.send("Network.overrideNetworkState", {
    offline: state.offline,
    ...conditions,
  });
}

async function hideClientHints(state: EmulationState, hide: boolean) {
  if (hide && !state.hidingHints) {
    await state.session.send("Page.enable");
    const { identifier } = await state.session.send("Page.addScriptToEvaluateOnNewDocument", {
      source: HIDE_CLIENT_HINTS,
    });
    state.hidingHints = identifier;
  }
  if (!hide && state.hidingHints) {
    await state.session.send("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: state.hidingHints,
    });
    state.hidingHints = undefined;
  }
}

function chosenIdentity(state: EmulationState) {
  if (state.userAgent) return identityFor(state.userAgent, state.real.metadata);
  return state.device?.identity;
}

async function applyUserAgent(state: EmulationState) {
  const identity = chosenIdentity(state);
  await hideClientHints(state, identity !== undefined && !identity.metadata);
  if (!identity && !state.locale) {
    await state.session.send("Emulation.setUserAgentOverride", { userAgent: "" });
    return;
  }
  await state.session.send("Emulation.setUserAgentOverride", {
    userAgent: identity?.userAgent ?? state.real.userAgent,
    acceptLanguage: state.locale,
    platform: identity?.platform,
    userAgentMetadata: identity ? identity.metadata : state.real.metadata,
  });
}

async function applyMetrics(state: EmulationState) {
  if (state.metrics) await state.session.send("Emulation.setDeviceMetricsOverride", state.metrics);
  else await state.session.send("Emulation.clearDeviceMetricsOverride");
  await state.session.send("Emulation.setTouchEmulationEnabled", {
    enabled: state.touch,
    maxTouchPoints: state.touch ? 5 : undefined,
  });
}

function describeViewport(state: EmulationState) {
  const { metrics, size } = state;
  if (metrics) {
    const mode = [metrics.mobile ? "mobile" : "", state.touch ? "touch" : ""].filter(Boolean);
    return `${metrics.width}x${metrics.height} @${metrics.deviceScaleFactor}x${mode.length ? ` ${mode.join("+")}` : ""}`;
  }
  return size ? `${size.width}x${size.height}` : undefined;
}

function noteViewport(state: EmulationState) {
  const described = describeViewport(state);
  if (described) state.settings.set("viewport", described);
  else state.settings.delete("viewport");
}

async function windowSize(page: Page): Promise<Size> {
  return (
    page.viewportSize() ??
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }))
  );
}

async function applyDevice(state: EmulationState, device: Device | "") {
  if (device === "") {
    state.device = undefined;
    state.metrics = undefined;
    state.touch = false;
    state.settings.delete("device");
  } else {
    const identity = deviceIdentity(device, state.real.metadata);
    state.device = { name: device.name, identity, touch: device.hasTouch };
    state.metrics = {
      width: device.viewport.width,
      height: device.viewport.height,
      deviceScaleFactor: device.deviceScaleFactor,
      mobile: device.isMobile,
      screenWidth: device.screen?.width,
      screenHeight: device.screen?.height,
    };
    state.touch = device.hasTouch;
    const system = systemOf(identity.userAgent).platform || "browser";
    state.settings.set(
      "device",
      `${device.name} (${system} user agent, ${identity.metadata ? "with matching client hints" : "no client hints"})`,
    );
  }
  await applyMetrics(state);
  await applyUserAgent(state);
  noteViewport(state);
}

async function applyViewport(
  page: Page,
  state: EmulationState,
  viewport: NonNullable<EmulateInput["viewport"]>,
) {
  const mobile = viewport.mobile ?? state.metrics?.mobile ?? false;
  const deviceScaleFactor = viewport.scale ?? state.metrics?.deviceScaleFactor ?? 1;
  const { width, height } = viewport;
  if (state.device || mobile || deviceScaleFactor !== 1) {
    state.metrics = { width, height, deviceScaleFactor, mobile };
    state.touch = state.device?.touch ?? mobile;
    await applyMetrics(state);
  } else {
    if (state.metrics) {
      state.metrics = undefined;
      state.touch = false;
      await applyMetrics(state);
    }
    state.sizeBefore ??= await windowSize(page);
    await page.setViewportSize({ width, height });
    state.size = { width, height };
  }
  noteViewport(state);
}

export async function emulate(page: Page, input: EmulateInput, profile: ProfileSettings) {
  const state = await stateFor(page, profile);
  const { session, settings } = state;

  if (input.device !== undefined) await applyDevice(state, input.device);
  if (input.viewport) await applyViewport(page, state, input.viewport);
  if (input.colorScheme || input.reducedMotion) {
    if (input.colorScheme)
      state.media.set(
        "prefers-color-scheme",
        input.colorScheme === "none" ? "" : input.colorScheme,
      );
    if (input.reducedMotion)
      state.media.set(
        "prefers-reduced-motion",
        input.reducedMotion === "none" ? "" : input.reducedMotion,
      );
    await session.send("Emulation.setEmulatedMedia", {
      features: [...state.media].map(([name, value]) => ({ name, value })),
    });
    for (const [name, value] of state.media) {
      if (value) settings.set(name, value);
      else settings.delete(name);
    }
  }
  if (input.geolocation) {
    const origin = new URL(page.url()).origin;
    if (origin !== "null")
      await profile.hold(page.context(), state.grantHolder, origin, ["geolocation"]);
    await session.send("Emulation.setGeolocationOverride", { accuracy: 10, ...input.geolocation });
    settings.set(
      "geolocation",
      `${input.geolocation.latitude},${input.geolocation.longitude}${origin !== "null" ? ` (permission granted to ${origin})` : ""}`,
    );
  }
  if (input.timezone !== undefined) {
    await session.send("Emulation.setTimezoneOverride", { timezoneId: input.timezone });
    if (input.timezone) settings.set("timezone", input.timezone);
    else settings.delete("timezone");
  }
  if (input.locale !== undefined || input.userAgent !== undefined) {
    if (input.locale !== undefined) {
      await session.send("Emulation.setLocaleOverride", { locale: input.locale || undefined });
      state.locale = input.locale || undefined;
      if (input.locale) settings.set("locale", input.locale);
      else settings.delete("locale");
    }
    if (input.userAgent !== undefined) {
      state.userAgent = input.userAgent || undefined;
      if (input.userAgent) settings.set("user agent", input.userAgent);
      else settings.delete("user agent");
    }
    await applyUserAgent(state);
  }
  if (input.offline !== undefined || input.network !== undefined) {
    if (input.offline !== undefined) state.offline = input.offline;
    if (input.network !== undefined) state.network = input.network;
    await applyNetwork(state);
    if (state.offline) settings.set("offline", "yes");
    else settings.delete("offline");
    if (state.network !== "none") settings.set("network", state.network);
    else settings.delete("network");
  }
  if (input.device !== undefined || input.viewport || input.colorScheme || input.reducedMotion)
    await repaint(state);
  return { settings, reload: reloadNote(page, state) };
}

export async function resetEmulation(page: Page, profile: ProfileSettings) {
  const state = states.get(page);
  if (!state) return { cleared: [], size: undefined };
  states.delete(page);
  const cleared = [...state.settings.keys()];
  if (state.userAgent || state.locale || state.device)
    await state.session
      .send("Emulation.setUserAgentOverride", { userAgent: "" })
      .catch(() => undefined);
  await hideClientHints(state, false).catch(() => undefined);
  await state.session.detach().catch(() => undefined);
  if (state.sizeBefore) await page.setViewportSize(state.sizeBefore);
  await profile.release(page.context(), state.grantHolder);
  return { cleared, size: state.sizeBefore };
}

export const emulationSession = (page: Page) => states.get(page)?.session;

export function emulatedViewport(page: Page): Size | undefined {
  const metrics = states.get(page)?.metrics;
  return metrics && { width: metrics.width, height: metrics.height };
}

export async function reapplyEmulatedViewport(page: Page) {
  const state = states.get(page);
  if (!state?.metrics) return false;
  await state.session.send("Emulation.setDeviceMetricsOverride", {
    ...state.metrics,
    width: state.metrics.width + 1,
  });
  await state.session.send("Emulation.setDeviceMetricsOverride", state.metrics);
  return true;
}

export function describeEmulation(settings: Map<string, string>) {
  if (settings.size === 0) return "No emulation is active on this tab.";
  return `Active emulation: ${[...settings].map(([name, value]) => `${name} ${value}`).join("; ")}.`;
}
