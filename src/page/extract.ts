import type { Page } from "playwright-core";
import { z } from "zod";
import { parseJson } from "../shared/decode.ts";

const jsonSchema = z.json();

const graphSchema = z.looseObject({ "@graph": jsonSchema });

function flattenGraphs(documents: z.infer<typeof jsonSchema>[]) {
  return documents.flatMap((parsed) => {
    const wrapped = graphSchema.safeParse(parsed);
    const graph = wrapped.success ? wrapped.data["@graph"] : parsed;
    return Array.isArray(graph) ? graph : [graph];
  });
}

function decodeDocuments(documents: unknown[]) {
  return documents.flatMap((document) => {
    const decoded = parseJson(JSON.stringify(document), jsonSchema);
    return decoded.success ? [decoded.data] : [];
  });
}

const tableSchema = z.object({ caption: z.string(), rows: z.array(z.array(z.string())) });

const structuredSchema = z.object({
  jsonld: z.array(z.unknown()).transform(decodeDocuments).transform(flattenGraphs),
  meta: z.record(z.string(), z.string()),
  tables: z.array(tableSchema),
});

type Structured = z.infer<typeof structuredSchema>;

const TABLE_LIMIT = 30;
const ROW_LIMIT = 2000;

function extractStructured(limits: { tables: number; rows: number }) {
  const jsonld: unknown[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      jsonld.push(JSON.parse(script.textContent ?? ""));
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
    if (/^(og:|twitter:|product:|article:|description$|keywords$|author$)/i.test(key))
      put(key, tag.content);
  }

  const tables = [...document.querySelectorAll<HTMLTableElement>("table")]
    .filter((table) => table.rows.length > 1)
    .slice(0, limits.tables)
    .map((table) => ({
      caption: (table.caption?.innerText ?? table.getAttribute("aria-label") ?? "")
        .trim()
        .slice(0, 200),
      rows: [...table.rows]
        .slice(0, limits.rows)
        .map((row) => [...row.cells].map((cell) => cell.innerText.replace(/\s+/g, " ").trim())),
    }));

  return { jsonld, meta, tables };
}

export function decodeStructured(raw: z.input<typeof structuredSchema>): Structured {
  return structuredSchema.parse(raw);
}

export async function extractPage(page: Page): Promise<Structured> {
  return decodeStructured(
    await page.evaluate(extractStructured, { tables: TABLE_LIMIT, rows: ROW_LIMIT }),
  );
}

export function toCsv(rows: string[][]) {
  return rows
    .map((row) =>
      row.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(","),
    )
    .join("\n");
}

const offerSchema = z.looseObject({
  price: jsonSchema.optional(),
  lowPrice: jsonSchema.optional(),
  priceCurrency: jsonSchema.optional(),
  availability: z.string().optional().catch(undefined),
});

const nodeSchema = z.looseObject({
  "@type": jsonSchema.optional(),
  name: z.string().optional().catch(undefined),
  offers: jsonSchema.optional(),
});

type JsonLdNode = z.infer<typeof nodeSchema>;

function typesOf(node: JsonLdNode) {
  const type = node["@type"];
  return Array.isArray(type) ? type.map(String) : type === undefined ? [] : [String(type)];
}

function firstOffer(offers: JsonLdNode["offers"]) {
  const offer = offerSchema.safeParse(Array.isArray(offers) ? offers[0] : offers);
  return offer.success ? offer.data : undefined;
}

export function summarizeStructured(data: Structured) {
  const nodes = data.jsonld.flatMap((value) => {
    const node = nodeSchema.safeParse(value);
    return node.success ? [node.data] : [];
  });
  const product = nodes.find((node) => typesOf(node).some((type) => /product/i.test(type)));
  const parts: string[] = [];

  if (product) {
    const offer = firstOffer(product.offers);
    const price = offer?.price ?? offer?.lowPrice;
    const currency = offer?.priceCurrency;
    const availability = offer?.availability?.split("/").pop();
    if (product.name !== undefined)
      parts.push(`product ${JSON.stringify(product.name.slice(0, 80))}`);
    if (price !== undefined)
      parts.push(`price ${String(price)}${currency ? ` ${String(currency)}` : ""}`);
    if (availability) parts.push(availability);
  } else {
    const types = [...new Set(nodes.flatMap(typesOf))].slice(0, 5);
    if (types.length) parts.push(`json-ld ${types.join(", ")}`);
    const metaPrice = data.meta["product:price:amount"] ?? data.meta["og:price:amount"];
    if (metaPrice)
      parts.push(
        `price ${metaPrice} ${data.meta["product:price:currency"] ?? data.meta["og:price:currency"] ?? ""}`.trim(),
      );
  }
  if (data.tables.length) parts.push(`${data.tables.length} tables`);
  return parts.join(" · ");
}
