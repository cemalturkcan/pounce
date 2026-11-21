import type { Locator, Page } from "playwright-core";
import { isLocalHost, normalizeUrl } from "../page/collect.ts";
import { pageBound } from "../page/bound.ts";

type FormDescription = {
  method: string;
  action: string;
  password: boolean;
  email: boolean;
  tel: boolean;
  card: boolean;
};

export type TargetDescription = {
  tag: string;
  type: string;
  role: string;
  name: string;
  placeholder: string;
  href?: string;
  download: boolean;
  form?: FormDescription;
  submit: boolean;
  editable: boolean;
};

export type GuardPolicy = { startUrl: string; sites: string[] };

export type Verdict = { allow: true } | { allow: false; reason: string };

const ALLOW: Verdict = { allow: true };
const refuse = (reason: string): Verdict => ({ allow: false, reason });

const RISKY_NAMES = [
  "buy",
  "order",
  "checkout",
  "pay",
  "purchase",
  "add to cart",
  "add to basket",
  "add to bag",
  "subscribe",
  "upgrade",
  "sign in",
  "log in",
  "sign up",
  "register",
  "create account",
  "delete",
  "remove",
  "cancel subscription",
  "unsubscribe",
  "confirm",
  "submit",
  "send",
  "post",
  "publish",
  "book",
  "reserve",
  "donate",
  "apply",
  "install",
  "download",
  "upload",
  "accept invitation",
  "satın al",
  "sepete ekle",
  "sipariş",
  "öde",
  "ödeme",
  "abone ol",
  "giriş yap",
  "kayıt ol",
  "üye ol",
  "sil",
  "kaldır",
  "onayla",
  "gönder",
  "kaufen",
  "bestellen",
  "in den warenkorb",
  "bezahlen",
  "anmelden",
  "registrieren",
  "löschen",
  "absenden",
  "acheter",
  "commander",
  "payer",
  "se connecter",
  "s'inscrire",
  "supprimer",
  "envoyer",
  "comprar",
  "pagar",
  "pedido",
  "iniciar sesión",
  "registrarse",
  "eliminar",
  "enviar",
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const RISKY = new RegExp(
  `(?<![\\p{L}\\p{N}])(${RISKY_NAMES.map((name) => escape(name).replace(/ /g, "\\s+").replace(/'/g, "['’]")).join("|")})(?![\\p{L}\\p{N}])`,
  "u",
);
const BLOCKED_PATH =
  /\/(checkout|cart|basket|payment|pay|order|orders|account|settings|login|signin|sign-in|signup|register|logout|admin)(\/|$|\?)/i;
const FILE_EXTENSION =
  /\.(pdf|zip|exe|dmg|csv|xlsx?|docx?|pptx?|rar|7z|tar|gz|tgz|bz2|msi|pkg|deb|rpm|apk|iso|bin|img|jar)$/i;
const SEARCH_WORDS = /(?<![\p{L}\p{N}])(search|ara|such|recherch|busca)/iu;
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac", "edu"]);
const PRESS_KEYS = new Set([
  "Escape",
  "Tab",
  "Shift+Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Space",
  " ",
]);

function riskyWord(name: string) {
  const match = RISKY.exec(name.toLowerCase()) ?? RISKY.exec(name.toLocaleLowerCase("tr"));
  return match?.[1];
}

function isIpHost(host: string) {
  return /^\[?[0-9a-f:]+\]?$/i.test(host) && host.includes(":")
    ? true
    : /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function registrable(host: string) {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  const last = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  const keep = labels.length >= 3 && SECOND_LEVEL.has(second) && last.length === 2 ? 3 : 2;
  return labels.slice(-keep).join(".");
}

function parse(url: string) {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

export function sameSiteWithLocalPort(left: string, right: string) {
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return false;
  if (
    isLocalHost(a.hostname) ||
    isLocalHost(b.hostname) ||
    isIpHost(a.hostname) ||
    isIpHost(b.hostname)
  )
    return a.host === b.host;
  return registrable(a.hostname) === registrable(b.hostname);
}

function allowedSite(url: URL, sites: string[]) {
  const host = url.hostname.toLowerCase();
  return sites.some((site) => {
    const wanted = (parse(normalizeUrl(site))?.hostname ?? site).toLowerCase();
    return host === wanted || host.endsWith(`.${wanted}`);
  });
}

export function offLimits(url: string, policy: GuardPolicy): string | undefined {
  const parsed = parse(url);
  if (!parsed || !/^https?:$/.test(parsed.protocol)) return `${url} is not a web page`;
  if (!sameSiteWithLocalPort(parsed.href, policy.startUrl) && !allowedSite(parsed, policy.sites))
    return `${parsed.host} is outside this site and the allowed sites`;
  if (BLOCKED_PATH.test(`${parsed.pathname}${parsed.search}`))
    return `${parsed.pathname} is a checkout, cart, account or sign-in path`;
  return undefined;
}

export function classifyNavigation(url: string, policy: GuardPolicy): Verdict {
  const trimmed = url.trim();
  if (trimmed === "back" || trimmed === "reload") return ALLOW;
  const why = offLimits(normalizeUrl(trimmed), policy);
  return why ? refuse(`navigation to ${trimmed} is off-limits: ${why}`) : ALLOW;
}

function sensitiveForm(form: FormDescription | undefined) {
  return form && (form.password || form.card);
}

function isButton(target: TargetDescription) {
  return (
    target.tag === "button" ||
    target.role === "button" ||
    (target.tag === "input" && ["button", "submit", "image", "reset"].includes(target.type))
  );
}

export function classifyClick(target: TargetDescription, policy: GuardPolicy): Verdict {
  const label = target.name ? ` "${target.name}"` : "";
  if (target.submit) return refuse(`the control${label} would submit a form`);
  if (sensitiveForm(target.form))
    return refuse(`the control${label} is in a form with password or payment fields`);
  if (target.download) return refuse(`the link${label} starts a download`);
  let linkPathBlocked = false;
  if (target.href !== undefined) {
    const href = parse(target.href);
    if (!href || /^(mailto|tel|javascript|data|blob|file|sms):/i.test(target.href))
      return refuse(
        `the link${label} goes to ${target.href.slice(0, 80)}, which is not a web page of this site`,
      );
    if (FILE_EXTENSION.test(href.pathname))
      return refuse(
        `the link${label} points to a file (${href.pathname.split("/").at(-1)}), which would download it`,
      );
    const why = offLimits(href.href, policy);
    if (why) {
      linkPathBlocked = BLOCKED_PATH.test(`${href.pathname}${href.search}`);
      if (!linkPathBlocked) return refuse(`the link${label} leads to ${href.host}: ${why}`);
    }
  }
  const risky = isButton(target) || linkPathBlocked ? riskyWord(target.name) : undefined;
  if (risky)
    return refuse(`the control${label} looks like it acts in the user's name ("${risky}")`);
  if (linkPathBlocked)
    return refuse(`the link${label} leads to a checkout, cart, account or sign-in path`);
  return ALLOW;
}

export function classifyPress(
  key: string,
  focused: TargetDescription | undefined,
  policy: GuardPolicy,
): Verdict {
  const trimmed = key.trim() || key;
  if (PRESS_KEYS.has(trimmed)) return ALLOW;
  if (trimmed !== "Enter")
    return refuse(
      `the key ${key} is not allowed; only Escape, Tab, Shift+Tab, the arrow keys, PageUp, PageDown, Home, End, Space and Enter outside forms are`,
    );
  if (!focused) return ALLOW;
  if (focused.form || focused.tag === "input" || focused.tag === "textarea" || focused.editable)
    return refuse("Enter in a form or a text field could submit it");
  return classifyClick(focused, policy);
}

function formAllowsLooking(form: FormDescription | undefined) {
  if (!form) return true;
  return (
    (form.method === "" || form.method === "get") && !form.password && !form.email && !form.card
  );
}

export function classifySearch(target: TargetDescription): Verdict {
  const textual = target.tag === "input" && ["", "text", "search"].includes(target.type);
  const searchy =
    target.type === "search" ||
    target.role === "searchbox" ||
    ((textual || target.role === "combobox") &&
      SEARCH_WORDS.test(`${target.name} ${target.placeholder}`));
  if (!searchy)
    return refuse("search only types into a search box; this field does not look like one");
  if (!formAllowsLooking(target.form))
    return refuse(
      "the search box is in a form that posts data or asks for sign-in or payment details",
    );
  return ALLOW;
}

export function classifySelect(target: TargetDescription): Verdict {
  const choice =
    target.tag === "select" ||
    (target.tag === "input" && (target.type === "radio" || target.type === "checkbox"));
  if (!choice) return refuse("select_option only sets a select, radio button or checkbox");
  if (!formAllowsLooking(target.form))
    return refuse(
      "the control is in a form that posts data or asks for sign-in or payment details",
    );
  return ALLOW;
}

function describeElement(start: Element | null): TargetDescription | undefined {
  const element =
    start?.closest(
      "button, a[href], input, select, textarea, summary, [role=button], [role=link], [role=switch], [role=tab], [role=checkbox], [role=radio], [role=menuitem], [role=option], [role=combobox], [role=searchbox]",
    ) ?? start;
  if (!element) return undefined;
  const tag = element.tagName.toLowerCase();
  const type = (element.getAttribute("type") ?? "").toLowerCase();
  const implicit = new Map([
    ["a", element.hasAttribute("href") ? "link" : ""],
    ["button", "button"],
    ["select", "combobox"],
    ["textarea", "textbox"],
    ["summary", ""],
  ]);
  const inputRoles = new Map([
    ["search", "searchbox"],
    ["checkbox", "checkbox"],
    ["radio", "radio"],
    ["submit", "button"],
    ["button", "button"],
    ["image", "button"],
    ["reset", "button"],
  ]);
  const role =
    element.getAttribute("role") ??
    (tag === "input" ? (inputRoles.get(type) ?? "textbox") : (implicit.get(tag) ?? ""));
  const inputField =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? element
      : undefined;
  const associated =
    inputField ??
    (element instanceof HTMLButtonElement || element instanceof HTMLOutputElement
      ? element
      : undefined);
  const labelable =
    associated ??
    (element instanceof HTMLMeterElement || element instanceof HTMLProgressElement
      ? element
      : undefined);
  const html = element instanceof HTMLElement ? element : undefined;
  const svgAnchor = element instanceof SVGAElement ? element : undefined;
  const labelled = element.getAttribute("aria-labelledby");
  const labelText = labelled
    ? labelled
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ")
    : "";
  const labels = labelable?.labels
    ? [...labelable.labels].map((label) => label.textContent ?? "").join(" ")
    : "";
  const name = (
    element.getAttribute("aria-label") ||
    labelText ||
    html?.innerText ||
    svgAnchor?.textContent ||
    labels ||
    inputField?.value ||
    element.getAttribute("title") ||
    element.getAttribute("alt") ||
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
  const anchor = element.closest("a[href]");
  const form = associated?.form ?? element.closest("form");
  const fields = form
    ? [...form.querySelectorAll("input, select, textarea")].map((field) => ({
        type: field.getAttribute("type"),
        autocomplete: (field.getAttribute("autocomplete") ?? "").toLowerCase(),
        naming: `${field.getAttribute("name") ?? ""} ${field.id}`.toLowerCase(),
      }))
    : [];
  const submit =
    (tag === "button" && (type === "" || type === "submit") && form !== null) ||
    (tag === "input" && (type === "submit" || type === "image"));
  const description: TargetDescription = {
    tag,
    type,
    role,
    name,
    placeholder: (element.getAttribute("placeholder") ?? "").slice(0, 200),
    download: anchor?.hasAttribute("download") ?? false,
    submit,
    editable: html?.isContentEditable ?? false,
  };
  if (anchor instanceof HTMLAnchorElement) description.href = anchor.href;
  if (anchor instanceof SVGAElement)
    description.href = new URL(anchor.href.baseVal, document.baseURI).href;
  if (form)
    description.form = {
      method: (form.getAttribute("method") ?? "").toLowerCase(),
      action: form.action,
      password: fields.some((field) => field.type === "password"),
      email: fields.some((field) => field.type === "email" || field.autocomplete.includes("email")),
      tel: fields.some((field) => field.type === "tel" || field.autocomplete.includes("tel")),
      card: fields.some(
        (field) =>
          field.autocomplete.startsWith("cc-") || /card|cc-?num|cvc|cvv|iban/.test(field.naming),
      ),
    };
  return description;
}

export async function describeTarget(locator: Locator): Promise<TargetDescription> {
  const described = await pageBound(locator.evaluate(describeElement), "Checking the target");
  if (!described) throw new Error("the target has no element to check");
  return described;
}

export async function describeFocused(page: Page): Promise<TargetDescription | undefined> {
  const focused = page.locator("*:focus").first();
  if ((await pageBound(focused.count(), "Checking the focused element")) === 0) return undefined;
  return describeTarget(focused);
}
