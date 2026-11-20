import type { Frame, Page } from "playwright-core";

export type OverlayKind = "reject" | "necessary" | "close" | "cancel" | "accept_all" | "accept" | "none";
export type ConsentChoice = "accept" | "reject";

export type OverlayCandidate = {
  marker?: string;
  overlay: string;
  kind: OverlayKind;
  name: string;
  label: string;
  container: string;
  consent: boolean;
  modal: boolean;
};

export type OverlayClick = OverlayCandidate & { frame: string; clicked: boolean; skipped?: boolean; error?: string; closedBy?: string; tried?: string[] };

const PATTERNS: Record<Exclude<OverlayKind, "none">, string[]> = {
  reject: [
    "reject", "decline", "deny", "refuse", "disagree", "do not accept", "don't accept", "do not consent",
    "reddet", "kabul etme", "onaylama", "izin verme",
    "ablehnen", "nicht zustimmen", "nicht einverstanden", "verweigern",
    "refuser", "je refuse", "continuer sans accepter", "non, merci de",
    "rechazar", "denegar", "no acepto", "no aceptar",
  ],
  necessary: [
    "only necessary", "necessary only", "only essential", "essential only", "necessary cookies only", "strictly necessary", "only required", "required only",
    "sadece gerekli", "yalnızca gerekli", "yalnizca gerekli", "sadece zorunlu", "yalnızca zorunlu", "zorunlu çerez",
    "nur notwendige", "nur erforderliche", "nur essenzielle", "nur essentielle", "nur technisch notwendige",
    "uniquement nécessaire", "seulement nécessaire", "uniquement les cookies nécessaires", "essentiels uniquement", "strictement nécessaires",
    "solo necesarias", "sólo necesarias", "solo las necesarias", "solo esenciales", "únicamente necesarias", "estrictamente necesarias",
  ],
  close: [
    "^(x|×|✕|✖|╳)$", "^close$", "^close (dialog|modal|banner|popup|pop-up|window|this)", "^dismiss", "^no,? thanks", "^not now$", "^maybe later$", "^skip$",
    "^kapat$", "^hayır,? teşekkürler", "^şimdi değil$", "^daha sonra$",
    "^schließen$", "^schliessen$", "^nein,? danke", "^später$", "^nicht jetzt$",
    "^fermer$", "^non,? merci$", "^plus tard$", "^pas maintenant$",
    "^cerrar$", "^no,? gracias", "^ahora no$", "^más tarde$",
  ],
  cancel: ["^cancel$", "^iptal$", "^vazgeç$", "^abbrechen$", "^annuler$", "^cancelar$"],
  accept_all: [
    "accept all", "accept cookies", "accept all cookies", "allow all", "agree to all", "agree and close", "^agree$", "^i agree$",
    "tümünü kabul", "hepsini kabul", "tüm çerezleri kabul", "kabul et$",
    "alle akzeptieren", "alle cookies akzeptieren", "alle zulassen", "alle erlauben",
    "tout accepter", "accepter tout", "accepter et fermer",
    "aceptar todo", "aceptar todas", "aceptar cookies",
  ],
  accept: [
    "accept", "agree", "allow all", "allow cookies", "^allow$", "^ok$", "^okay$", "got it", "i understand", "^continue$",
    "kabul", "^onayla$", "^tamam$", "anladım", "izin ver",
    "akzeptieren", "zustimmen", "einverstanden", "alle erlauben", "verstanden",
    "accepter", "j'accepte", "d'accord", "tout autoriser", "compris",
    "aceptar", "acepto", "de acuerdo", "permitir", "entendido",
  ],
};

const COMMIT_WORDS = [
  "order", "pay", "payment", "purchase", "buy", "checkout", "submit", "delete", "remove", "subscribe", "confirm", "send", "book", "transfer",
  "sipariş", "öde", "ödeme", "satın", "sil", "gönder", "abone", "rezervasyon",
  "bestell", "kaufen", "bezahl", "zahlung", "löschen", "absenden", "buchen",
  "commander", "payer", "acheter", "supprimer", "envoyer", "réserver",
  "pedido", "pagar", "comprar", "eliminar", "enviar", "reservar",
];

const CONSENT_MARKER = "cookie|consent|gdpr|cmp|onetrust|didomi|usercentrics|cookiebot|privacy|cerez|çerez|kvkk|datenschutz|trustarc|sp_message|quantcast|truste";
const CONSENT_TEXT = "cookie|cookies|çerez|çerezler|cerez|consent";

const CONTAINER_SELECTOR = [
  "[id*=cookie i]", "[class*=cookie i]", "[id*=consent i]", "[class*=consent i]", "[id*=gdpr i]", "[class*=gdpr i]",
  "[id*=cmp i]", "[class*=cmp-]", "[id*=onetrust i]", "[id*=didomi i]", "[id*=usercentrics i]", "#CybotCookiebotDialog",
  "[id*=privacy i]", "[class*=privacy i]", "[id*=kvkk i]", "[class*=kvkk i]", "[id*=cerez i]", "[class*=cerez i]",
  "[id*=newsletter i]", "[class*=newsletter i]", "[class*=modal i]", "[class*=popup i]",
  "[class*=overlay i]", "[role=dialog]", "[role=alertdialog]", "[aria-modal=true]", "dialog[open]",
].join(", ");

function findCandidates(input: {
  patterns: Record<string, string[]>;
  commitWords: string[];
  consentMarker: string;
  consentText: string;
  selector: string;
  wholeFrame: boolean;
  seed: string;
  consentOrder: string[];
  consentOnly: boolean;
}) {
  const consentOrder = input.consentOrder;
  const genericOrder = ["close", "cancel"];
  const compile = (kinds: string[]) => kinds.map((kind) => ({ kind, regexes: (input.patterns[kind] ?? []).map((source) => new RegExp(source, "iu")) }));
  const consentMatchers = compile(consentOrder);
  const genericMatchers = compile(genericOrder);
  const commit = new RegExp(`(^|[^\\p{L}])(${input.commitWords.join("|")})`, "iu");
  const consentMarker = new RegExp(input.consentMarker, "i");
  const modalMarker = /modal|popup|pop-up|lightbox/i;
  const consentText = new RegExp(`(^|[^\\p{L}])(${input.consentText})([^\\p{L}]|$)`, "iu");
  const visible = (element: Element) => {
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;
    const style = getComputedStyle(element);
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05;
  };
  const floating = (element: Element) => {
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return true;
    }
    return false;
  };
  const isConsent = (element: Element) =>
    input.wholeFrame || consentMarker.test(`${element.id} ${element.getAttribute("class") ?? ""}`) || consentText.test((element as HTMLElement).innerText ?? "");
  const strong = (element: Element) =>
    consentMarker.test(`${element.id} ${element.getAttribute("class") ?? ""}`) || element.matches("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]");

  const containers = input.wholeFrame && document.body
    ? [document.body]
    : [...document.querySelectorAll(input.selector)].filter(
        (element) => element !== document.body && element !== document.documentElement && visible(element) && (strong(element) || floating(element)),
      );
  const outer = containers.filter((element) => !containers.some((other) => other !== element && other.contains(element)));

  const results: { marker?: string; overlay: string; kind: string; name: string; label: string; container: string; consent: boolean; modal: boolean }[] = [];
  const control = "button, [role=button], a, input[type=button], input[type=submit], [aria-label], [title]";
  const clickable = (element: Element) => element.matches(`${control}, [onclick], [tabindex]`) || getComputedStyle(element).cursor === "pointer";
  outer.forEach((container, containerIndex) => {
    const consent = isConsent(container);
    if (input.consentOnly && !consent) return;
    const modal = !consent && (container.matches("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]") || modalMarker.test(`${container.id} ${container.getAttribute("class") ?? ""}`));
    const matchers = consent ? consentMatchers : genericMatchers;
    let best: { element: Element; rank: number; name: string; label: string } | undefined;
    for (const element of container.querySelectorAll("*")) {
      const isControl = element.matches(control);
      if (!isControl && element.children.length > 0 && !element.matches("[onclick], [tabindex]")) continue;
      if (!visible(element)) continue;
      const label = (element.getAttribute("aria-label") || (element as HTMLElement).innerText || (element as HTMLInputElement).value || element.getAttribute("title") || "")
        .replace(/\s+/g, " ")
        .trim();
      const name = label.toLowerCase();
      if (!name || name.length > 60) continue;
      const rank = matchers.findIndex((matcher) => matcher.regexes.some((regex) => regex.test(name)));
      if (rank === -1 || (best && best.rank <= rank)) continue;
      const kind = matchers[rank]?.kind ?? "";
      if (kind.startsWith("accept") && commit.test(name)) continue;
      if (!isControl && !clickable(element) && kind !== "close" && kind !== "cancel") continue;
      best = { element, rank, name, label };
    }
    if (!best && !modal) return;
    const marker = `${input.seed}-${containerIndex}`;
    container.setAttribute("data-web-agent-overlay", marker);
    best?.element.setAttribute("data-web-agent-dismiss", marker);
    const className = (container.getAttribute("class") ?? "").trim().split(/\s+/)[0];
    const label = container.id ? `#${container.id}` : container.getAttribute("role") ? `[role=${container.getAttribute("role")}]` : className ? `.${className}` : container.tagName.toLowerCase();
    results.push({
      ...(best ? { marker } : {}),
      overlay: marker,
      kind: best ? (matchers[best.rank]?.kind ?? "close") : "none",
      name: best?.name ?? "",
      label: best?.label ?? "",
      container: label,
      consent,
      modal,
    });
  });
  return results;
}

function frameLabel(page: Page, frame: Frame) {
  return frame === page.mainFrame() ? "main frame" : `frame ${frame.url().slice(0, 80) || frame.name()}`;
}

const MODAL_GONE_MS = 1500;

function modalGone(frame: Frame, overlay: string) {
  return frame
    .locator(`[data-web-agent-overlay="${overlay}"]`)
    .waitFor({ state: "hidden", timeout: MODAL_GONE_MS })
    .then(() => true)
    .catch(() => false);
}

function backdropPoint(overlay: string) {
  const container = document.querySelector(`[data-web-agent-overlay="${overlay}"]`);
  if (!container) return undefined;
  const width = window.innerWidth;
  const height = window.innerHeight;
  const covers = (element: Element) => {
    const box = element.getBoundingClientRect();
    return box.width * box.height >= 0.9 * width * height;
  };
  const fixed = (element: Element) => {
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      if (getComputedStyle(node).position === "fixed") return true;
    }
    return false;
  };
  const dialog = covers(container)
    ? [...container.querySelectorAll("*")].filter((element) => !covers(element)).sort((left, right) => {
        const area = (element: Element) => element.getBoundingClientRect().width * element.getBoundingClientRect().height;
        return area(right) - area(left);
      })[0]
    : container;
  const box = dialog?.getBoundingClientRect();
  if (!box) return undefined;
  const points = [
    [8, 8],
    [width - 8, 8],
    [8, height - 8],
    [width - 8, height - 8],
  ];
  for (const [x = 0, y = 0] of points) {
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) continue;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit === document.body || hit === document.documentElement || dialog?.contains(hit)) continue;
    if (hit.closest("a, button, input, select, textarea, label, [role=button], [role=link]")) continue;
    let backdrop: Element | null = hit;
    while (backdrop && backdrop !== document.body && !(covers(backdrop) && fixed(backdrop))) backdrop = backdrop.parentElement;
    if (backdrop && backdrop !== document.body) return { x, y };
  }
  return undefined;
}

async function closeModal(page: Page, frame: Frame, click: OverlayClick) {
  const tried: string[] = [];
  if (click.marker) {
    tried.push(`clicking "${click.label}"`);
    if (click.clicked && (await modalGone(frame, click.overlay))) {
      click.closedBy = `clicking "${click.label}" (${click.kind})`;
      return;
    }
  }
  tried.push("Escape");
  await page.keyboard.press("Escape").catch(() => undefined);
  if (await modalGone(frame, click.overlay)) {
    click.closedBy = "pressing Escape";
    return;
  }
  const point = frame === page.mainFrame() ? await frame.evaluate(backdropPoint, click.overlay).catch(() => undefined) : undefined;
  if (point) {
    tried.push("a click outside it");
    await page.mouse.click(point.x, point.y).catch(() => undefined);
    if (await modalGone(frame, click.overlay)) {
      click.closedBy = "a click outside it";
      return;
    }
  }
  click.tried = tried;
}

export type DismissOptions = { consent?: ConsentChoice; allowAccept?: boolean; consentOnly?: boolean };

function consentOrder(choice: ConsentChoice) {
  return choice === "accept" ? ["accept_all", "accept", "close", "cancel"] : ["reject", "necessary", "close", "cancel", "accept_all", "accept"];
}

export async function dismissOverlays(page: Page, options: DismissOptions = {}) {
  const choice = options.consent ?? "accept";
  const allowAccept = options.allowAccept ?? true;
  const clicks: OverlayClick[] = [];
  const seed = Date.now().toString(36);
  for (const [index, frame] of page.frames().entries()) {
    if (frame.isDetached()) continue;
    const wholeFrame = frame !== page.mainFrame() && /consent|cmp|cookie|privacy|sp_message|sourcepoint|trustarc|didomi|onetrust/i.test(`${frame.url()} ${frame.name()}`);
    const found = await frame
      .evaluate(findCandidates, {
        patterns: PATTERNS,
        commitWords: COMMIT_WORDS,
        consentMarker: CONSENT_MARKER,
        consentText: CONSENT_TEXT,
        selector: CONTAINER_SELECTOR,
        wholeFrame,
        seed: `${seed}-${index}`,
        consentOrder: consentOrder(choice),
        consentOnly: options.consentOnly ?? false,
      })
      .catch(() => [] as OverlayCandidate[]);
    for (const candidate of found as OverlayCandidate[]) {
      const kind: OverlayKind = candidate.kind === "accept_all" ? "accept" : candidate.kind;
      const click: OverlayClick = { ...candidate, kind, frame: frameLabel(page, frame), clicked: false };
      if (kind === "accept" && choice === "reject" && !allowAccept) {
        clicks.push({ ...click, skipped: true });
        continue;
      }
      if (candidate.marker) {
        try {
          await frame.locator(`[data-web-agent-dismiss="${candidate.marker}"]`).click({ timeout: 3000 });
          click.clicked = true;
        } catch (error) {
          click.error = (error instanceof Error ? error.message : String(error)).split("\n")[0];
        }
      }
      if (candidate.modal) await closeModal(page, frame, click);
      clicks.push(click);
    }
  }
  return clicks;
}

function describeModal(click: OverlayClick) {
  const where = `Modal ${click.container} in ${click.frame}`;
  if (click.closedBy) return `${where}: closed by ${click.closedBy}.`;
  const failed = click.error ? ` The click on "${click.label}" failed: ${click.error}` : "";
  return `${where}: found, but no close control worked (tried ${(click.tried ?? []).join(", ")}).${failed}`;
}

export function describeOverlayClicks(clicks: OverlayClick[]) {
  if (clicks.length === 0) return "No cookie banner or modal was found.";
  return clicks
    .map((click) =>
      click.modal
        ? describeModal(click)
        : click.skipped
          ? `Left "${click.label}" (accept) in ${click.container}, ${click.frame} unclicked: the consent banner offers no reject or close control. Pass allow_accept: true to accept it.`
          : click.clicked
            ? `Clicked "${click.label}" (${click.kind}) in ${click.container}, ${click.frame}.`
            : `Found "${click.label}" (${click.kind}) in ${click.container}, ${click.frame}, but the click failed: ${click.error}`,
    )
    .join("\n");
}
