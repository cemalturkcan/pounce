import type { Frame, Page } from "playwright-core";

export type OverlayKind = "reject" | "necessary" | "close" | "cancel" | "accept";

export type OverlayCandidate = {
  marker?: string;
  kind: OverlayKind;
  name: string;
  container: string;
  consent: boolean;
};

export type OverlayClick = OverlayCandidate & { frame: string; clicked: boolean; skipped?: boolean; error?: string };

const PATTERNS: Record<OverlayKind, string[]> = {
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
}) {
  const consentOrder = ["reject", "necessary", "close", "cancel", "accept"];
  const genericOrder = ["close", "cancel"];
  const compile = (kinds: string[]) => kinds.map((kind) => ({ kind, regexes: (input.patterns[kind] ?? []).map((source) => new RegExp(source, "iu")) }));
  const consentMatchers = compile(consentOrder);
  const genericMatchers = compile(genericOrder);
  const commit = new RegExp(`(^|[^\\p{L}])(${input.commitWords.join("|")})`, "iu");
  const consentMarker = new RegExp(input.consentMarker, "i");
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

  const results: { marker?: string; kind: string; name: string; container: string; consent: boolean }[] = [];
  outer.forEach((container, containerIndex) => {
    const consent = isConsent(container);
    const matchers = consent ? consentMatchers : genericMatchers;
    const controls = container.querySelectorAll("button, [role=button], a, input[type=button], input[type=submit], [aria-label], [title]");
    let best: { element: Element; rank: number; name: string } | undefined;
    for (const control of controls) {
      if (!visible(control)) continue;
      const name = (control.getAttribute("aria-label") || (control as HTMLElement).innerText || (control as HTMLInputElement).value || control.getAttribute("title") || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!name || name.length > 60) continue;
      const rank = matchers.findIndex((matcher) => matcher.regexes.some((regex) => regex.test(name)));
      if (rank === -1 || (best && best.rank <= rank)) continue;
      if (matchers[rank]?.kind === "accept" && commit.test(name)) continue;
      best = { element: control, rank, name };
    }
    if (!best) return;
    const marker = `${input.seed}-${containerIndex}`;
    best.element.setAttribute("data-web-agent-dismiss", marker);
    const label = container.id ? `#${container.id}` : container.getAttribute("role") ? `[role=${container.getAttribute("role")}]` : container.tagName.toLowerCase();
    results.push({ marker, kind: matchers[best.rank]?.kind ?? "close", name: best.name, container: label, consent });
  });
  return results;
}

function frameLabel(page: Page, frame: Frame) {
  return frame === page.mainFrame() ? "main frame" : `frame ${frame.url().slice(0, 80) || frame.name()}`;
}

export async function dismissOverlays(page: Page, allowAccept: boolean) {
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
      })
      .catch(() => [] as OverlayCandidate[]);
    for (const candidate of found as OverlayCandidate[]) {
      const click: OverlayClick = { ...candidate, frame: frameLabel(page, frame), clicked: false };
      if (candidate.kind === "accept" && !allowAccept) {
        clicks.push({ ...click, skipped: true });
        continue;
      }
      try {
        await frame.locator(`[data-web-agent-dismiss="${candidate.marker}"]`).click({ timeout: 3000 });
        click.clicked = true;
      } catch (error) {
        click.error = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      }
      clicks.push(click);
    }
  }
  return clicks;
}

export function describeOverlayClicks(clicks: OverlayClick[], allowAccept: boolean) {
  if (clicks.length === 0) {
    return allowAccept
      ? "No cookie banner or modal with a reject, close, cancel or accept control was found."
      : "No cookie banner or modal with a reject, close or cancel control was found.";
  }
  return clicks
    .map((click) =>
      click.skipped
        ? `Left "${click.name}" (accept) in ${click.container}, ${click.frame} unclicked: the consent banner offers no reject or close control. Pass allow_accept: true to accept it.`
        : click.clicked
          ? `Clicked "${click.name}" (${click.kind}) in ${click.container}, ${click.frame}.`
          : `Found "${click.name}" (${click.kind}) in ${click.container}, ${click.frame}, but the click failed: ${click.error}`,
    )
    .join("\n");
}
