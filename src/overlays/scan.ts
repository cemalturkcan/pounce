import type { Frame } from "playwright-core";
import { z } from "zod";

const overlayKindSchema = z.enum([
  "reject",
  "necessary",
  "close",
  "cancel",
  "accept_all",
  "accept",
  "none",
]);

export type OverlayKind = z.infer<typeof overlayKindSchema>;
export type ConsentChoice = "accept" | "reject";

const overlayCandidateSchema = z.object({
  marker: z.string().optional(),
  overlay: z.string(),
  kind: overlayKindSchema,
  name: z.string(),
  label: z.string(),
  container: z.string(),
  consent: z.boolean(),
  modal: z.boolean(),
});

const overlayCandidatesSchema = z.array(overlayCandidateSchema);

export type OverlayCandidate = z.infer<typeof overlayCandidateSchema>;

const PATTERNS = {
  reject: [
    "reject",
    "decline",
    "deny",
    "refuse",
    "disagree",
    "do not accept",
    "don't accept",
    "do not consent",
    "reddet",
    "kabul etme",
    "onaylama",
    "izin verme",
    "ablehnen",
    "nicht zustimmen",
    "nicht einverstanden",
    "verweigern",
    "refuser",
    "je refuse",
    "continuer sans accepter",
    "non, merci de",
    "rechazar",
    "denegar",
    "no acepto",
    "no aceptar",
  ],
  necessary: [
    "only necessary",
    "necessary only",
    "only essential",
    "essential only",
    "necessary cookies only",
    "strictly necessary",
    "only required",
    "required only",
    "sadece gerekli",
    "yalnızca gerekli",
    "yalnizca gerekli",
    "sadece zorunlu",
    "yalnızca zorunlu",
    "zorunlu çerez",
    "nur notwendige",
    "nur erforderliche",
    "nur essenzielle",
    "nur essentielle",
    "nur technisch notwendige",
    "uniquement nécessaire",
    "seulement nécessaire",
    "uniquement les cookies nécessaires",
    "essentiels uniquement",
    "strictement nécessaires",
    "solo necesarias",
    "sólo necesarias",
    "solo las necesarias",
    "solo esenciales",
    "únicamente necesarias",
    "estrictamente necesarias",
  ],
  close: [
    "^(x|×|✕|✖|╳)$",
    "^close$",
    "^close (dialog|modal|banner|popup|pop-up|window|this)",
    "^dismiss",
    "^no,? thanks",
    "^not now$",
    "^maybe later$",
    "^skip$",
    "^kapat$",
    "^hayır,? teşekkürler",
    "^şimdi değil$",
    "^daha sonra$",
    "^schließen$",
    "^schliessen$",
    "^nein,? danke",
    "^später$",
    "^nicht jetzt$",
    "^fermer$",
    "^non,? merci$",
    "^plus tard$",
    "^pas maintenant$",
    "^cerrar$",
    "^no,? gracias",
    "^ahora no$",
    "^más tarde$",
  ],
  cancel: ["^cancel$", "^iptal$", "^vazgeç$", "^abbrechen$", "^annuler$", "^cancelar$"],
  accept_all: [
    "accept all",
    "accept cookies",
    "accept all cookies",
    "allow all",
    "agree to all",
    "agree and close",
    "^agree$",
    "^i agree$",
    "tümünü kabul",
    "hepsini kabul",
    "tüm çerezleri kabul",
    "kabul et$",
    "alle akzeptieren",
    "alle cookies akzeptieren",
    "alle zulassen",
    "alle erlauben",
    "tout accepter",
    "accepter tout",
    "accepter et fermer",
    "aceptar todo",
    "aceptar todas",
    "aceptar cookies",
  ],
  accept: [
    "accept",
    "agree",
    "allow all",
    "allow cookies",
    "^allow$",
    "^ok$",
    "^okay$",
    "got it",
    "i understand",
    "^continue$",
    "kabul",
    "^onayla$",
    "^tamam$",
    "anladım",
    "izin ver",
    "akzeptieren",
    "zustimmen",
    "einverstanden",
    "alle erlauben",
    "verstanden",
    "accepter",
    "j'accepte",
    "d'accord",
    "tout autoriser",
    "compris",
    "aceptar",
    "acepto",
    "de acuerdo",
    "permitir",
    "entendido",
  ],
} satisfies Record<Exclude<OverlayKind, "none">, string[]>;

const COMMIT_WORDS = [
  "order",
  "pay",
  "payment",
  "purchase",
  "buy",
  "checkout",
  "submit",
  "delete",
  "remove",
  "subscribe",
  "confirm",
  "send",
  "book",
  "transfer",
  "sipariş",
  "öde",
  "ödeme",
  "satın",
  "sil",
  "gönder",
  "abone",
  "rezervasyon",
  "bestell",
  "kaufen",
  "bezahl",
  "zahlung",
  "löschen",
  "absenden",
  "buchen",
  "commander",
  "payer",
  "acheter",
  "supprimer",
  "envoyer",
  "réserver",
  "pedido",
  "pagar",
  "comprar",
  "eliminar",
  "enviar",
  "reservar",
];

const CONSENT_MARKER =
  "cookie|consent|gdpr|cmp|onetrust|didomi|usercentrics|cookiebot|privacy|cerez|çerez|kvkk|datenschutz|trustarc|sp_message|quantcast|truste";
const CONSENT_TEXT = "cookie|cookies|çerez|çerezler|cerez|consent";

const CONTAINER_SELECTOR = [
  "[id*=cookie i]",
  "[class*=cookie i]",
  "[id*=consent i]",
  "[class*=consent i]",
  "[id*=gdpr i]",
  "[class*=gdpr i]",
  "[id*=cmp i]",
  "[class*=cmp-]",
  "[id*=onetrust i]",
  "[id*=didomi i]",
  "[id*=usercentrics i]",
  "#CybotCookiebotDialog",
  "[id*=privacy i]",
  "[class*=privacy i]",
  "[id*=kvkk i]",
  "[class*=kvkk i]",
  "[id*=cerez i]",
  "[class*=cerez i]",
  "[id*=newsletter i]",
  "[class*=newsletter i]",
  "[class*=modal i]",
  "[class*=popup i]",
  "[class*=overlay i]",
  "[role=dialog]",
  "[role=alertdialog]",
  "[aria-modal=true]",
  "dialog[open]",
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
  const genericOrder = ["close", "cancel"];
  const compile = (kinds: string[]) =>
    kinds.map((kind) => ({
      kind,
      regexes: (input.patterns[kind] ?? []).map((source) => new RegExp(source, "iu")),
    }));
  const consentMatchers = compile(input.consentOrder);
  const genericMatchers = compile(genericOrder);
  const commit = new RegExp(`(^|[^\\p{L}])(${input.commitWords.join("|")})`, "iu");
  const consentMarker = new RegExp(input.consentMarker, "i");
  const modalMarker = /modal|popup|pop-up|lightbox/i;
  const consentText = new RegExp(`(^|[^\\p{L}])(${input.consentText})([^\\p{L}]|$)`, "iu");
  const dom = {
    visible(element: Element) {
      const box = element.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) return false;
      const style = getComputedStyle(element);
      return (
        style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0.05
      );
    },
    floating(element: Element) {
      for (
        let node: Element | null = element;
        node && node !== document.body;
        node = node.parentElement
      ) {
        const position = getComputedStyle(node).position;
        if (position === "fixed" || position === "sticky") return true;
      }
      return false;
    },
    text(element: Element) {
      return element instanceof HTMLElement ? element.innerText : "";
    },
    value(element: Element) {
      return element instanceof HTMLInputElement ||
        element instanceof HTMLButtonElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLOptionElement
        ? element.value
        : "";
    },
  };
  const isConsent = (element: Element) =>
    input.wholeFrame ||
    consentMarker.test(`${element.id} ${element.getAttribute("class") ?? ""}`) ||
    consentText.test(dom.text(element));
  const strong = (element: Element) =>
    consentMarker.test(`${element.id} ${element.getAttribute("class") ?? ""}`) ||
    element.matches("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]");

  const containers =
    input.wholeFrame && document.body
      ? [document.body]
      : [...document.querySelectorAll(input.selector)].filter(
          (element) =>
            element !== document.body &&
            element !== document.documentElement &&
            dom.visible(element) &&
            (strong(element) || dom.floating(element)),
        );
  const outer = containers.filter(
    (element) => !containers.some((other) => other !== element && other.contains(element)),
  );

  const results: {
    marker?: string;
    overlay: string;
    kind: string;
    name: string;
    label: string;
    container: string;
    consent: boolean;
    modal: boolean;
  }[] = [];
  const control =
    "button, [role=button], a, input[type=button], input[type=submit], [aria-label], [title]";
  const clickable = (element: Element) =>
    element.matches(`${control}, [onclick], [tabindex]`) ||
    getComputedStyle(element).cursor === "pointer";
  outer.forEach((container, containerIndex) => {
    const consent = isConsent(container);
    if (input.consentOnly && !consent) return;
    const modal =
      !consent &&
      (container.matches("[role=dialog], [role=alertdialog], [aria-modal=true], dialog[open]") ||
        modalMarker.test(`${container.id} ${container.getAttribute("class") ?? ""}`));
    const matchers = consent ? consentMatchers : genericMatchers;
    let best: { element: Element; rank: number; name: string; label: string } | undefined;
    for (const element of container.querySelectorAll("*")) {
      const isControl = element.matches(control);
      if (!isControl && element.children.length > 0 && !element.matches("[onclick], [tabindex]"))
        continue;
      if (!dom.visible(element)) continue;
      const label = (
        element.getAttribute("aria-label") ||
        dom.text(element) ||
        dom.value(element) ||
        element.getAttribute("title") ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      const name = label.toLowerCase();
      if (!name || name.length > 60) continue;
      const rank = matchers.findIndex((matcher) =>
        matcher.regexes.some((regex) => regex.test(name)),
      );
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
    const label = container.id
      ? `#${container.id}`
      : container.getAttribute("role")
        ? `[role=${container.getAttribute("role")}]`
        : className
          ? `.${className}`
          : container.tagName.toLowerCase();
    const found = {
      overlay: marker,
      kind: best ? (matchers[best.rank]?.kind ?? "close") : "none",
      name: best?.name ?? "",
      label: best?.label ?? "",
      container: label,
      consent,
      modal,
    };
    results.push(best ? { marker, ...found } : found);
  });
  return results;
}

function consentOrder(choice: ConsentChoice) {
  return choice === "accept"
    ? ["accept_all", "accept", "close", "cancel"]
    : ["reject", "necessary", "close", "cancel", "accept_all", "accept"];
}

type ScanOptions = {
  wholeFrame: boolean;
  seed: string;
  choice: ConsentChoice;
  consentOnly: boolean;
};

export async function scanFrame(frame: Frame, options: ScanOptions) {
  const found = await frame
    .evaluate(findCandidates, {
      patterns: PATTERNS,
      commitWords: COMMIT_WORDS,
      consentMarker: CONSENT_MARKER,
      consentText: CONSENT_TEXT,
      selector: CONTAINER_SELECTOR,
      wholeFrame: options.wholeFrame,
      seed: options.seed,
      consentOrder: consentOrder(options.choice),
      consentOnly: options.consentOnly,
    })
    .catch(() => []);
  return overlayCandidatesSchema.parse(found);
}
