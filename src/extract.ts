import type { Page } from "playwright-core";

export type ExtractedTable = {
  caption: string;
  rows: string[][];
};

export type Structured = {
  jsonld: unknown[];
  meta: Record<string, string>;
  tables: ExtractedTable[];
};

const TABLE_LIMIT = 30;
const ROW_LIMIT = 2000;

function extractStructured(limits: { tables: number; rows: number }) {
  const jsonld: unknown[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const parsed = JSON.parse(script.textContent ?? "") as unknown;
      const graph = parsed && typeof parsed === "object" && "@graph" in parsed ? (parsed as { "@graph": unknown })["@graph"] : parsed;
      jsonld.push(...(Array.isArray(graph) ? graph : [graph]));
    } catch {
      continue;
    }
  }

  const meta: Record<string, string> = {};
  const put = (key: string, value: string | null | undefined) => {
    if (value && !(key in meta)) meta[key] = value.trim().slice(0, 500);
  };
  put("title", document.title);
  put("canonical", document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href);
  put("lang", document.documentElement.lang);
  for (const tag of document.querySelectorAll<HTMLMetaElement>("meta[property], meta[name]")) {
    const key = tag.getAttribute("property") ?? tag.getAttribute("name") ?? "";
    if (/^(og:|twitter:|product:|article:|description$|keywords$|author$)/i.test(key)) put(key, tag.content);
  }

  const tables = [...document.querySelectorAll<HTMLTableElement>("table")]
    .filter((table) => table.rows.length > 1)
    .slice(0, limits.tables)
    .map((table) => ({
      caption: (table.caption?.innerText ?? table.getAttribute("aria-label") ?? "").trim().slice(0, 200),
      rows: [...table.rows].slice(0, limits.rows).map((row) => [...row.cells].map((cell) => cell.innerText.replace(/\s+/g, " ").trim())),
    }));

  return { jsonld, meta, tables };
}

export function extractPage(page: Page): Promise<Structured> {
  return page.evaluate(extractStructured, { tables: TABLE_LIMIT, rows: ROW_LIMIT });
}

export function toCsv(rows: string[][]) {
  return rows.map((row) => row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(",")).join("\n");
}

function typesOf(node: Record<string, unknown>) {
  const type = node["@type"];
  return Array.isArray(type) ? type.map(String) : type === undefined ? [] : [String(type)];
}

function firstOffer(value: unknown): Record<string, unknown> | undefined {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>) : undefined;
}

export function summarizeStructured(data: Structured) {
  const nodes = data.jsonld.filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === "object");
  const product = nodes.find((node) => typesOf(node).some((type) => /product/i.test(type)));
  const parts: string[] = [];

  if (product) {
    const offer = firstOffer(product.offers);
    const price = offer?.price ?? offer?.lowPrice;
    const currency = offer?.priceCurrency;
    const availability = typeof offer?.availability === "string" ? offer.availability.split("/").pop() : undefined;
    if (typeof product.name === "string") parts.push(`product ${JSON.stringify(product.name.slice(0, 80))}`);
    if (price !== undefined) parts.push(`price ${String(price)}${currency ? ` ${String(currency)}` : ""}`);
    if (availability) parts.push(availability);
  } else {
    const types = [...new Set(nodes.flatMap(typesOf))].slice(0, 5);
    if (types.length) parts.push(`json-ld ${types.join(", ")}`);
    const metaPrice = data.meta["product:price:amount"] ?? data.meta["og:price:amount"];
    if (metaPrice) parts.push(`price ${metaPrice} ${data.meta["product:price:currency"] ?? data.meta["og:price:currency"] ?? ""}`.trim());
  }
  if (data.tables.length) parts.push(`${data.tables.length} tables`);
  return parts.join(" · ");
}
