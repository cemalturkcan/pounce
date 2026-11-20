import type { BrowserContext, CDPSession, Page } from "playwright-core";

export const VIEWPORT_PRESETS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  laptop: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false },
  desktop: { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
} as const;

export const NETWORK_PRESETS = {
  slow3g: { latency: 2000, downloadThroughput: (500 * 1000 * 0.8) / 8, uploadThroughput: (500 * 1000 * 0.8) / 8, connectionType: "cellular3g" as const },
  fast3g: { latency: 562.5, downloadThroughput: (1.6 * 1000 * 1000 * 0.9) / 8, uploadThroughput: (750 * 1000 * 0.9) / 8, connectionType: "cellular3g" as const },
};

export type EmulateInput = {
  viewport?: { preset?: keyof typeof VIEWPORT_PRESETS; width?: number; height?: number; mobile?: boolean; scale?: number };
  colorScheme?: "light" | "dark" | "none";
  reducedMotion?: "reduce" | "no-preference" | "none";
  geolocation?: { latitude: number; longitude: number; accuracy?: number };
  timezone?: string;
  locale?: string;
  offline?: boolean;
  network?: keyof typeof NETWORK_PRESETS | "none";
  userAgent?: string;
};

type Brand = { brand: string; version: string };

export type UserAgentMetadata = {
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

export type RealUserAgent = { userAgent: string; metadata: UserAgentMetadata; observed: boolean };

const realAgents = new WeakMap<BrowserContext, RealUserAgent>();

async function readHints(page: Page) {
  return page
    .evaluate(async () => {
      const data = (navigator as unknown as { userAgentData?: { getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> } }).userAgentData;
      if (!data) return undefined;
      return data.getHighEntropyValues(["architecture", "bitness", "brands", "fullVersionList", "mobile", "model", "platform", "platformVersion", "wow64", "uaFullVersion"]);
    })
    .catch(() => undefined);
}

export function synthesizeMetadata(userAgent: string, product: string): UserAgentMetadata {
  const version = /Chrome\/([\d.]+)/.exec(product)?.[1] ?? /Chrome\/([\d.]+)/.exec(userAgent)?.[1] ?? "0.0.0.0";
  const major = version.split(".")[0] ?? "0";
  const brand = /Headless/i.test(product) ? "HeadlessChrome" : "Google Chrome";
  const platform = /Windows/.test(userAgent) ? "Windows" : /Mac OS X/.test(userAgent) ? "macOS" : /Android/.test(userAgent) ? "Android" : "Linux";
  return {
    brands: [{ brand: "Not_A Brand", version: "99" }, { brand: "Chromium", version: major }, { brand, version: major }],
    fullVersionList: [{ brand: "Not_A Brand", version: "99.0.0.0" }, { brand: "Chromium", version }, { brand, version }],
    fullVersion: version,
    platform,
    platformVersion: "",
    architecture: /arm|aarch64/i.test(userAgent) ? "arm" : "x86",
    model: "",
    mobile: /Mobile|Android/.test(userAgent),
  };
}

export async function realUserAgent(page: Page, session: CDPSession): Promise<RealUserAgent> {
  const context = page.context();
  const cached = realAgents.get(context);
  if (cached?.observed) return cached;
  const version = (await session.send("Browser.getVersion")) as { userAgent: string; product: string };
  const userAgent = (await page.evaluate(() => navigator.userAgent).catch(() => undefined)) ?? version.userAgent;
  const hints = await readHints(page);
  const brands = hints?.brands as Brand[] | undefined;
  const real: RealUserAgent = brands?.length
    ? {
        userAgent,
        observed: true,
        metadata: {
          brands,
          fullVersionList: hints?.fullVersionList as Brand[] | undefined,
          fullVersion: hints?.uaFullVersion as string | undefined,
          platform: String(hints?.platform ?? ""),
          platformVersion: String(hints?.platformVersion ?? ""),
          architecture: String(hints?.architecture ?? ""),
          model: String(hints?.model ?? ""),
          mobile: Boolean(hints?.mobile),
          bitness: hints?.bitness as string | undefined,
          wow64: hints?.wow64 as boolean | undefined,
        },
      }
    : (cached ?? { userAgent, observed: false, metadata: synthesizeMetadata(userAgent, version.product) });
  realAgents.set(context, real);
  return real;
}

type EmulationState = {
  real: RealUserAgent;
  session: CDPSession;
  settings: Map<string, string>;
  media: Map<string, string>;
  offline: boolean;
  network: keyof typeof NETWORK_PRESETS | "none";
  userAgent?: string;
  locale?: string;
  geolocationOrigin?: string;
  viewport?: { width: number; height: number; deviceScaleFactor: number; mobile: boolean };
};

const states = new WeakMap<Page, EmulationState>();

async function stateFor(page: Page) {
  const existing = states.get(page);
  if (existing) return existing;
  const session = await page.context().newCDPSession(page);
  const real = await realUserAgent(page, session);
  const state: EmulationState = { real, session, settings: new Map(), media: new Map(), offline: false, network: "none" };
  states.set(page, state);
  page.once("close", () => states.delete(page));
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
    matchedNetworkConditions: active ? [{ urlPattern: "", ...conditions, offline: state.offline }] : [],
  });
  await state.session.send("Network.overrideNetworkState", { offline: state.offline, ...conditions });
}

async function applyUserAgent(state: EmulationState) {
  if (!state.userAgent && !state.locale) {
    await state.session.send("Emulation.setUserAgentOverride", { userAgent: "" });
    return;
  }
  await state.session.send("Emulation.setUserAgentOverride", {
    userAgent: state.userAgent ?? state.real.userAgent,
    acceptLanguage: state.locale,
    userAgentMetadata: state.real.metadata,
  });
}

export async function emulate(page: Page, input: EmulateInput) {
  const state = await stateFor(page);
  const { session, settings } = state;

  if (input.viewport) {
    const preset = input.viewport.preset ? VIEWPORT_PRESETS[input.viewport.preset] : undefined;
    const width = input.viewport.width ?? preset?.width ?? 1280;
    const height = input.viewport.height ?? preset?.height ?? 800;
    const mobile = input.viewport.mobile ?? preset?.mobile ?? false;
    const deviceScaleFactor = input.viewport.scale ?? preset?.deviceScaleFactor ?? 1;
    state.viewport = { width, height, deviceScaleFactor, mobile };
    await session.send("Emulation.setDeviceMetricsOverride", state.viewport);
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : undefined });
    settings.set("viewport", `${width}x${height} @${deviceScaleFactor}x${mobile ? " mobile+touch" : ""}`);
  }
  if (input.colorScheme || input.reducedMotion) {
    if (input.colorScheme) state.media.set("prefers-color-scheme", input.colorScheme === "none" ? "" : input.colorScheme);
    if (input.reducedMotion) state.media.set("prefers-reduced-motion", input.reducedMotion === "none" ? "" : input.reducedMotion);
    await session.send("Emulation.setEmulatedMedia", { features: [...state.media].map(([name, value]) => ({ name, value })) });
    for (const [name, value] of state.media) {
      if (value) settings.set(name, value);
      else settings.delete(name);
    }
  }
  if (input.geolocation) {
    const origin = new URL(page.url()).origin;
    if (origin !== "null") {
      await page.context().grantPermissions(["geolocation"], { origin });
      state.geolocationOrigin = origin;
    }
    await session.send("Emulation.setGeolocationOverride", { accuracy: 10, ...input.geolocation });
    settings.set("geolocation", `${input.geolocation.latitude},${input.geolocation.longitude}${origin !== "null" ? ` (permission granted to ${origin})` : ""}`);
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
  return settings;
}

export async function resetEmulation(page: Page) {
  const state = states.get(page);
  if (!state) return [];
  states.delete(page);
  const cleared = [...state.settings.keys()];
  if (state.userAgent || state.locale) await state.session.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => undefined);
  await state.session.detach().catch(() => undefined);
  if (state.geolocationOrigin) await page.context().clearPermissions().catch(() => undefined);
  return cleared;
}

export async function reapplyEmulatedViewport(page: Page) {
  const state = states.get(page);
  if (!state?.viewport) return false;
  await state.session.send("Emulation.setDeviceMetricsOverride", { ...state.viewport, width: state.viewport.width + 1 });
  await state.session.send("Emulation.setDeviceMetricsOverride", state.viewport);
  return true;
}

export function describeEmulation(settings: Map<string, string>) {
  if (settings.size === 0) return "No emulation is active on this tab.";
  return `Active emulation: ${[...settings].map(([name, value]) => `${name} ${value}`).join("; ")}.`;
}
