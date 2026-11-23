import { expect, test } from "bun:test";
import {
  changedLines,
  clipByImportance,
  collapseNavigation,
  cutSubtree,
  findInSnapshot,
  interactiveOnly,
  limitDepth,
  scopeSnapshot,
  topLevelRefs,
} from "./snapshot.ts";

const SNAPSHOT = [
  "- generic [ref=e1]:",
  '  - heading "Shop" [level=1] [ref=e2]',
  "  - navigation [ref=e3]:",
  '    - link "Cart" [ref=e4] [cursor=pointer]:',
  "      - /url: /cart",
  "  - main [ref=e5]:",
  '    - textbox "Search" [ref=e6]',
  '    - button "Add to cart" [ref=e7]',
  "    - iframe [ref=e8]:",
  '      - button "Pay" [ref=f1e2]',
].join("\n");

test("interactiveOnly keeps a flat list of actionable elements", () => {
  expect(interactiveOnly(SNAPSHOT)).toBe(
    [
      '- link "Cart" [ref=e4] [cursor=pointer]',
      '- textbox "Search" [ref=e6]',
      '- button "Add to cart" [ref=e7]',
      '- button "Pay" [ref=f1e2]',
    ].join("\n"),
  );
});

const CART = [
  "- main [ref=e2]:",
  '  - heading "Sepet" [level=1] [ref=e3]',
  '  - heading "Sil" [level=2] [ref=e4]',
  "  - table [ref=e5]:",
  "    - rowgroup [ref=e6]:",
  "      - row [ref=e7]:",
  '        - cell "Silikon Kılıf" [ref=e8]',
  '        - cell "249 TL" [ref=e9]',
  "        - cell [ref=e10]:",
  '          - button "Sil" [ref=e11]',
  "      - row [ref=e12]:",
  '        - cell "Ekran Koruyucu" [ref=e13]',
  '        - cell "99 TL" [ref=e14]',
  "        - cell [ref=e15]:",
  '          - button "Sil" [ref=e16]',
  "  - list [ref=e17]:",
  "    - listitem [ref=e18]:",
  "      - text: Silikon Kapak 149 TL",
  '      - link "Detay" [ref=e19] [cursor=pointer]:',
  '        - /url: "#kapak"',
  '  - button "Sepeti sil" [ref=e20]',
  "  - paragraph [ref=e21]: Silinen ürünler burada görünmez.",
  '  - group "Hediye paketi seçenekleri ve bu siparişe eklenecek not alanı için ayarlar" [ref=e22]:',
  '    - checkbox "Paketle" [ref=e23]',
].join("\n");

const findLines = (query: string, options: { regex?: boolean; maxResults?: number } = {}) =>
  findInSnapshot(CART, query, { regex: false, maxResults: 30, ...options }).text.split("\n");

test("findInSnapshot lists the elements named exactly like the query first", () => {
  expect(findLines("Sil").slice(0, 2)).toStrictEqual([
    'button "Sil" [ref=e11] — in row "Silikon Kılıf 249 TL"',
    'button "Sil" [ref=e16] — in row "Ekran Koruyucu 99 TL"',
  ]);
});

test("findInSnapshot lists an actionable element before static text of the same rank", () => {
  expect(findLines("Sil")[2]).toBe('heading "Sil" [level=2] [ref=e4]');
});

test("findInSnapshot lists a whole-word match after the exact ones", () => {
  expect(findLines("Sil")[3]).toBe('button "Sepeti sil" [ref=e20]');
});

test("findInSnapshot lists the elements that only contain the query under their own heading", () => {
  expect(findLines("Sil").slice(4)).toStrictEqual([
    'Also contains "Sil":',
    'cell "Silikon Kılıf" [ref=e8] — in row "Silikon Kılıf 249 TL"',
    'text: Silikon Kapak 149 TL — in listitem "Silikon Kapak 149 TL Detay"',
    "paragraph [ref=e21]: Silinen ürünler burada görünmez.",
  ]);
});

test("findInSnapshot names a list item by its text when it has no name", () => {
  expect(findLines("Detay")).toStrictEqual([
    'link "Detay" [ref=e19] [cursor=pointer] — in listitem "Silikon Kapak 149 TL Detay"',
  ]);
});

test("findInSnapshot shows the element a matching URL belongs to and says the URL matched", () => {
  expect(findLines("#kapak")).toStrictEqual([
    'Also contains "#kapak":',
    'link "Detay" [ref=e19] [cursor=pointer] (url matches) — in listitem "Silikon Kapak 149 TL Detay"',
  ]);
});

test("findInSnapshot says a field matched by its value", () => {
  const form = ["- form [ref=e2]:", '  - textbox "Adres" [ref=e3]: İstanbul'].join("\n");
  expect(findInSnapshot(form, "istanbul", { regex: false, maxResults: 30 }).text).toBe(
    'Also contains "istanbul":\ntextbox "Adres" [ref=e3]: İstanbul (value matches) — in form',
  );
});

test("findInSnapshot names the row of a match by the text of the row's links", () => {
  const rows = [
    "- row [ref=e4]:",
    "  - cell [ref=e5]:",
    '    - link "Kılıf A" [ref=e6] [cursor=pointer]:',
    "      - /url: /a",
    "  - cell [ref=e7]:",
    '    - button "Sil" [ref=e8]',
  ].join("\n");
  expect(findInSnapshot(rows, "Sil", { regex: false, maxResults: 30 }).text).toBe(
    'button "Sil" [ref=e8] — in row "Kılıf A"',
  );
});

test("findInSnapshot shortens a long context name", () => {
  expect(findLines("Paketle")).toStrictEqual([
    'checkbox "Paketle" [ref=e23] — in group "Hediye paketi seçenekleri ve bu siparişe eklenecek not alan…"',
  ]);
});

test("findInSnapshot folds Turkish dotted and dotless i", () => {
  expect(findLines("SİL")[0]).toBe('button "Sil" [ref=e11] — in row "Silikon Kılıf 249 TL"');
});

test("findInSnapshot ranks a name that differs only in diacritics as exact", () => {
  expect(findLines("silinen urunler burada gorunmez.")).toStrictEqual([
    "paragraph [ref=e21]: Silinen ürünler burada görünmez.",
  ]);
});

test("findInSnapshot matches a query without diacritics against text with them", () => {
  expect(findLines("urunler bura")).toStrictEqual([
    'Also contains "urunler bura":',
    "paragraph [ref=e21]: Silinen ürünler burada görünmez.",
  ]);
});

test("findInSnapshot counts every match and shows at most max_results", () => {
  const found = findInSnapshot(CART, "Sil", { regex: false, maxResults: 1 });
  expect([found.matches, found.shown]).toStrictEqual([7, 1]);
});

test("findInSnapshot with regex lists its matches in page order without ranking", () => {
  expect(findLines('"s[iı]l"', { regex: true })).toStrictEqual([
    'heading "Sil" [level=2] [ref=e4]',
    'button "Sil" [ref=e11] — in row "Silikon Kılıf 249 TL"',
    'button "Sil" [ref=e16] — in row "Ekran Koruyucu 99 TL"',
  ]);
});

test("scoped snapshot helpers cut a subtree and keep its refs", () => {
  expect(cutSubtree(SNAPSHOT, "e5")).toBe(
    [
      "- main [ref=e5]:",
      '  - textbox "Search" [ref=e6]',
      '  - button "Add to cart" [ref=e7]',
      "  - iframe [ref=e8]:",
      '    - button "Pay" [ref=f1e2]',
    ].join("\n"),
  );
  expect(cutSubtree(SNAPSHOT, "e4")).toBe(
    ['- link "Cart" [ref=e4] [cursor=pointer]:', "  - /url: /cart"].join("\n"),
  );
  expect(cutSubtree(SNAPSHOT, "e99")).toBe(undefined);
  expect(limitDepth(cutSubtree(SNAPSHOT, "e5") ?? "", 1)).toBe("- main [ref=e5]:");
  expect(
    topLevelRefs(
      ['  - textbox "A" [ref=e3]', "    - text: x", '  - button "B" [ref=e9]'].join("\n"),
    ),
  ).toStrictEqual(["e3", "e9"]);
});

const PAGE = [
  "- generic [ref=e1]:",
  "  - banner [ref=e2]:",
  '    - searchbox "Search" [ref=e3]',
  '  - navigation "Main menu" [ref=e4]:',
  "    - list [ref=e5]:",
  "      - listitem [ref=e6]:",
  '        - link "Home" [ref=e7] [cursor=pointer]:',
  "          - /url: /",
  "      - listitem [ref=e8]:",
  '        - link "Shop" [ref=e9] [cursor=pointer]:',
  "          - /url: /shop",
  "  - main [ref=e10]:",
  '    - heading "Lamps" [level=1] [ref=e11]',
  '    - button "Add to cart" [ref=e12]',
  "  - contentinfo [ref=e13]:",
  '    - link "Imprint" [ref=e14] [cursor=pointer]:',
  "      - /url: /imprint",
].join("\n");

test("scopeSnapshot scopes to the single main landmark", () => {
  expect(scopeSnapshot(PAGE, undefined).text).toBe(
    [
      "- main [ref=e10]:",
      '  - heading "Lamps" [level=1] [ref=e11]',
      '  - button "Add to cart" [ref=e12]',
    ].join("\n"),
  );
});

test("scopeSnapshot says which landmarks and controls it left out", () => {
  expect(scopeSnapshot(PAGE, undefined).note).toBe(
    'Scoped to the main landmark; 3 landmarks and 4 controls outside it are not shown. Pass scope: "full" for the whole page.',
  );
});

test("scopeSnapshot counts text outside main in its note", () => {
  const withText = `${PAGE}\n  - paragraph [ref=e15]: Printed after the footer`;
  expect(scopeSnapshot(withText, undefined).note).toBe(
    'Scoped to the main landmark; 3 landmarks, 4 controls and 1 text line outside it are not shown. Pass scope: "full" for the whole page.',
  );
});

test("scopeSnapshot scopes and names the text when only text is outside main", () => {
  const textOnly = [
    "- main [ref=e1]:",
    '  - button "Go" [ref=e2]',
    "- paragraph [ref=e3]: Footnote",
  ].join("\n");
  expect(scopeSnapshot(textOnly, undefined).note).toBe(
    'Scoped to the main landmark; 1 text line outside it is not shown. Pass scope: "full" for the whole page.',
  );
});

test("scopeSnapshot leaves out the parts it found none of", () => {
  const landmarkAndText = [
    "- main [ref=e1]:",
    '  - button "Go" [ref=e2]',
    "- contentinfo [ref=e3]:",
    "  - paragraph [ref=e4]: Footnote",
  ].join("\n");
  expect(scopeSnapshot(landmarkAndText, undefined).note).toBe(
    'Scoped to the main landmark; 1 landmark and 1 text line outside it are not shown. Pass scope: "full" for the whole page.',
  );
});

test("scopeSnapshot scopes to an open dialog before main", () => {
  expect(scopeSnapshot(PAGE, ["e13"]).text).toBe(
    [
      "- contentinfo [ref=e13]:",
      '  - link "Imprint" [ref=e14] [cursor=pointer]:',
      "    - /url: /imprint",
    ].join("\n"),
  );
});

test("scopeSnapshot names the dialog in its note", () => {
  expect(scopeSnapshot(PAGE, ["e13"]).note).toMatch(
    /^Scoped to the open dialog; 3 landmarks, 4 controls and 1 text line/,
  );
});

test("scopeSnapshot keeps the whole page when there are two main landmarks", () => {
  const twoMains = `${PAGE}\n  - main [ref=e20]:\n    - button "Other" [ref=e21]`;
  expect(scopeSnapshot(twoMains, undefined)).toStrictEqual({ text: twoMains });
});

test("scopeSnapshot keeps the whole page when nothing is outside main", () => {
  const onlyMain = ["- main [ref=e1]:", '  - button "Go" [ref=e2]'].join("\n");
  expect(scopeSnapshot(onlyMain, undefined)).toStrictEqual({ text: onlyMain });
});

test("collapseNavigation turns a link-only navigation into one line", () => {
  expect(collapseNavigation(PAGE).text).toContain(
    '  - navigation "Main menu" [ref=e4] [2 links, collapsed]\n  - main [ref=e10]:',
  );
});

test("collapseNavigation says how to list the links it collapsed", () => {
  expect(collapseNavigation(PAGE).note).toBe(
    "1 link-only navigation menu collapsed; pass a menu's ref as target to list its links.",
  );
});

test("collapseNavigation keeps a navigation that holds a control other than links", () => {
  const withButton = [
    '- navigation "Pages" [ref=e1]:',
    '  - link "Next" [ref=e2] [cursor=pointer]',
    '  - button "Load more" [ref=e3]',
  ].join("\n");
  expect(collapseNavigation(withButton)).toStrictEqual({ text: withButton });
});

const LONG = [
  "- main [ref=e1]:",
  ...Array.from(
    { length: 30 },
    (_value, index) => `  - link "Related article number ${index}" [ref=e${index + 10}]`,
  ),
  '  - heading "Checkout" [level=1] [ref=e2]',
  '  - button "Pay now" [ref=e3]',
  "  - alert [ref=e4]: Card declined",
].join("\n");

test("clipByImportance keeps alerts, headings and controls over links", () => {
  const clipped = clipByImportance(LONG, 200);
  expect(clipped.text).toBe(
    [
      "- main [ref=e1]:",
      '  - link "Related article number 0" [ref=e10]',
      '  - heading "Checkout" [level=1] [ref=e2]',
      '  - button "Pay now" [ref=e3]',
      "  - alert [ref=e4]: Card declined",
    ].join("\n"),
  );
});

test("clipByImportance reports how many lines it kept", () => {
  expect(clipByImportance(LONG, 200)).toMatchObject({ kept: 5, total: 34 });
});

test("clipByImportance leaves text within the budget alone", () => {
  expect(clipByImportance(PAGE, 10_000)).toStrictEqual({ text: PAGE, kept: 17, total: 17 });
});

test("changedLines reports a repeated line that was added", () => {
  const before = ['- cell "1"', '- cell "2"'].join("\n");
  const after = ['- cell "1"', '- cell "2"', '- cell "1"'].join("\n");
  expect(changedLines(before, after)).toStrictEqual(['+ - cell "1"']);
});

test("changedLines reports lines that moved", () => {
  const before = ['- row "A"', '- row "B"', '- row "C"'].join("\n");
  const after = ['- row "C"', '- row "A"', '- row "B"'].join("\n");
  expect(changedLines(before, after)).toStrictEqual(['+ - row "C"', '- - row "C"']);
});

test("changedLines lists changes in page order", () => {
  const before = ['- row "A"', '- row "B"', '- row "C"', '- row "D"'].join("\n");
  const after = ['- row "A"', '- row "X"', '- row "C"', '- row "D"', '- row "Y"'].join("\n");
  expect(changedLines(before, after)).toStrictEqual(['- - row "B"', '+ - row "X"', '+ - row "Y"']);
});

test("changedLines lists the removed lines of one change before its added lines", () => {
  const before = ['- row "A"', '- row "B"', '- row "C"'].join("\n");
  const after = ['- row "A"', '- row "X"', '- row "Y"', '- row "C"'].join("\n");
  expect(changedLines(before, after)).toStrictEqual(['- - row "B"', '+ - row "X"', '+ - row "Y"']);
});

test("changedLines ignores focus and box annotations", () => {
  expect(
    changedLines('- button "Go" [active] [ref=e2]', '- button "Go" [ref=e2] [box=1,2,3,4]'),
  ).toStrictEqual([]);
});
