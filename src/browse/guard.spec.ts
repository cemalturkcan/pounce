import { expect, test } from "bun:test";
import {
  classifyClick,
  classifyNavigation,
  classifyPress,
  classifySearch,
  classifySelect,
  sameSiteWithLocalPort,
  type TargetDescription,
  type Verdict,
} from "./guard.ts";

const policy = { startUrl: "https://shop.example.com/pricing", sites: ["docs.partner.io"] };

const element = (over: Partial<TargetDescription> = {}): TargetDescription => ({
  tag: "button",
  type: "",
  role: "button",
  name: "",
  placeholder: "",
  download: false,
  submit: false,
  editable: false,
  ...over,
});
const form = (over: Partial<NonNullable<TargetDescription["form"]>> = {}) => ({
  method: "",
  action: "",
  password: false,
  email: false,
  tel: false,
  card: false,
  ...over,
});
const allowed = (verdict: Verdict) => expect(verdict.allow).toBe(true);
const blocked = (verdict: Verdict, reason?: RegExp) => {
  expect(verdict.allow).toBe(false);
  if (reason) expect(verdict.allow ? "" : verdict.reason).toMatch(reason);
};

test("19: submit buttons, typeless buttons in a form and submit inputs are refused", () => {
  blocked(
    classifyClick(element({ type: "submit", submit: true, name: "Go", form: form() }), policy),
    /submit/,
  );
  blocked(
    classifyClick(element({ name: "Continue", submit: true, form: form() }), policy),
    /submit/,
  );
  blocked(
    classifyClick(
      element({ tag: "input", type: "submit", submit: true, name: "Next", form: form() }),
      policy,
    ),
    /submit/,
  );
  blocked(
    classifyClick(
      element({ type: "button", name: "Show password", form: form({ password: true }) }),
      policy,
    ),
    /password|payment/,
  );
});

test("20: toggles, tabs and expanders outside forms are allowed", () => {
  allowed(classifyClick(element({ role: "switch", name: "Yearly" }), policy));
  allowed(classifyClick(element({ tag: "div", role: "tab", name: "Specifications" }), policy));
  allowed(classifyClick(element({ name: "Show more", type: "button" }), policy));
  allowed(classifyClick(element({ tag: "summary", role: "", name: "Shipping details" }), policy));
});

test("21: risky names are refused in five languages, near misses are allowed", () => {
  for (const name of [
    "Sepete ekle",
    "In den Warenkorb",
    "Buy now",
    "Sign in",
    "SATIN AL",
    "Se connecter",
    "Iniciar sesión",
    "GİRİŞ YAP",
    "Delete account",
    "Download the report",
  ]) {
    blocked(classifyClick(element({ name }), policy), new RegExp(name.split(" ")[0] ?? "", "i"));
  }
  allowed(classifyClick(element({ name: "Pricing" }), policy));
  allowed(classifyClick(element({ name: "Delivery info" }), policy));
  allowed(
    classifyClick(
      element({
        tag: "a",
        role: "link",
        name: "Order of events",
        href: "https://shop.example.com/history#events",
      }),
      policy,
    ),
  );
  blocked(
    classifyClick(
      element({
        tag: "a",
        role: "link",
        name: "Order now",
        href: "https://shop.example.com/checkout",
      }),
      policy,
    ),
  );
  allowed(classifyClick(element({ name: "Bookmarks" }), policy));
});

test("22: downloads, file links and non-web links are refused", () => {
  blocked(
    classifyClick(
      element({
        tag: "a",
        role: "link",
        name: "Report",
        href: "https://shop.example.com/r",
        download: true,
      }),
      policy,
    ),
    /download/,
  );
  blocked(
    classifyClick(
      element({
        tag: "a",
        role: "link",
        name: "Specs",
        href: "https://shop.example.com/files/specs.pdf",
      }),
      policy,
    ),
    /file/,
  );
  blocked(
    classifyClick(
      element({
        tag: "a",
        role: "link",
        name: "Archive",
        href: "https://shop.example.com/a.zip?x=1",
      }),
      policy,
    ),
    /file/,
  );
  for (const href of ["mailto:sales@example.com", "tel:+491234", "javascript:void(0)"])
    blocked(classifyClick(element({ tag: "a", role: "link", name: "Contact", href }), policy));
  blocked(
    classifyClick(
      element({ tag: "a", role: "link", name: "Partner", href: "https://other.org/" }),
      policy,
    ),
    /other\.org/,
  );
});

test("23: navigation stays on the site, its subdomains and the allowed sites, away from blocked paths", () => {
  allowed(classifyNavigation("back", policy));
  allowed(classifyNavigation("reload", policy));
  allowed(classifyNavigation("https://shop.example.com/specs", policy));
  allowed(classifyNavigation("https://www.example.com/about", policy));
  allowed(classifyNavigation("https://docs.partner.io/x", policy));
  blocked(classifyNavigation("https://evil.test/", policy));
  blocked(classifyNavigation("https://shop.example.com/checkout", policy));
  blocked(classifyNavigation("https://shop.example.com/login?next=/", policy));
  const uk = { startUrl: "https://www.acme.co.uk/", sites: [] };
  allowed(classifyNavigation("https://shop.acme.co.uk/p", uk));
  blocked(classifyNavigation("https://other.co.uk/p", uk));
  const local = { startUrl: "http://127.0.0.1:4000/browse/pricing", sites: [] };
  allowed(classifyNavigation("http://127.0.0.1:4000/browse/product", local));
  blocked(classifyNavigation("http://127.0.0.1:4001/", local));
  blocked(classifyNavigation("http://localhost:4000/", local));
  blocked(classifyNavigation("file:///etc/passwd", local));
  expect(sameSiteWithLocalPort("https://a.example.com.tr/", "https://b.example.com.tr/")).toBe(
    true,
  );
  expect(sameSiteWithLocalPort("https://a.com.tr/", "https://b.com.tr/")).toBe(false);
});

test("browsing from one github.io owner's pages to another's is off-limits", () => {
  blocked(
    classifyNavigation("https://bob.github.io/", {
      startUrl: "https://alice.github.io/",
      sites: [],
    }),
  );
});

test("browsing from www.web.de to mail.web.de stays on the site", () => {
  allowed(
    classifyNavigation("https://mail.web.de/", { startUrl: "https://www.web.de/", sites: [] }),
  );
});

test("24: only navigation keys pass, Enter only outside forms and fields", () => {
  allowed(classifyPress("Escape", undefined, policy));
  allowed(classifyPress("ArrowDown", element({ tag: "div", role: "listbox" }), policy));
  allowed(classifyPress("Shift+Tab", undefined, policy));
  blocked(
    classifyPress(
      "Enter",
      element({ tag: "input", type: "text", role: "textbox", form: form() }),
      policy,
    ),
  );
  blocked(
    classifyPress("Enter", element({ tag: "input", type: "password", role: "textbox" }), policy),
  );
  allowed(classifyPress("Enter", element({ role: "tab", tag: "div", name: "Shipping" }), policy));
  blocked(classifyPress("Enter", element({ name: "Buy now" }), policy));
  blocked(classifyPress("Control+A", undefined, policy));
  blocked(classifyPress("Meta+s", undefined, policy));
  blocked(classifyPress("a", undefined, policy));
});

test("25: search boxes in GET forms pass, POST or password forms do not", () => {
  allowed(
    classifySearch(
      element({ tag: "input", type: "search", role: "searchbox", form: form({ method: "get" }) }),
    ),
  );
  allowed(
    classifySearch(
      element({ tag: "input", type: "text", role: "combobox", placeholder: "Search products" }),
    ),
  );
  allowed(
    classifySearch(element({ tag: "input", type: "text", role: "textbox", name: "Ürün ara" })),
  );
  blocked(
    classifySearch(
      element({ tag: "input", type: "search", role: "searchbox", form: form({ method: "post" }) }),
    ),
  );
  blocked(
    classifySearch(
      element({ tag: "input", type: "search", role: "searchbox", form: form({ password: true }) }),
    ),
  );
  blocked(classifySearch(element({ tag: "input", type: "text", role: "textbox", name: "Email" })));
});

test("select_option takes selects, radios and checkboxes outside sensitive forms only", () => {
  allowed(classifySelect(element({ tag: "select", role: "combobox", name: "Region" })));
  allowed(
    classifySelect(
      element({ tag: "input", type: "radio", role: "radio", form: form({ method: "get" }) }),
    ),
  );
  blocked(
    classifySelect(
      element({ tag: "input", type: "checkbox", role: "checkbox", form: form({ method: "post" }) }),
    ),
  );
  blocked(classifySelect(element({ tag: "input", type: "text", role: "textbox" })));
});
