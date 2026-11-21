import { describe, expect, test } from "bun:test";
import { decodeStructured, summarizeStructured } from "./extract.ts";

const empty = { jsonld: [], meta: {}, tables: [] };

describe("summarizeStructured", () => {
  test("describes a product with its first offer", () => {
    const summary = summarizeStructured({
      ...empty,
      jsonld: [
        {
          "@type": ["Thing", "Product"],
          name: "Trail Runner 3",
          offers: [
            { price: 129.9, priceCurrency: "EUR", availability: "https://schema.org/InStock" },
          ],
        },
      ],
    });
    expect(summary).toBe('product "Trail Runner 3" · price 129.9 EUR · InStock');
  });

  test("falls back to the low price of an aggregate offer", () => {
    const summary = summarizeStructured({
      ...empty,
      jsonld: [{ "@type": "Product", offers: { lowPrice: "19", priceCurrency: "USD" } }],
    });
    expect(summary).toBe("price 19 USD");
  });

  test("ignores a non-string name and availability", () => {
    const summary = summarizeStructured({
      ...empty,
      jsonld: [{ "@type": "Product", name: 7, offers: { price: 5, availability: 1 } }],
    });
    expect(summary).toBe("price 5");
  });

  test("lists distinct json-ld types and the meta price when there is no product", () => {
    const summary = summarizeStructured({
      jsonld: [{ "@type": "WebSite" }, { "@type": "Organization" }, "text", null, [1]],
      meta: { "og:price:amount": "42", "og:price:currency": "TRY" },
      tables: [{ caption: "", rows: [["a"], ["b"]] }],
    });
    expect(summary).toBe("json-ld WebSite, Organization · price 42 TRY · 1 tables");
  });
});

describe("decodeStructured", () => {
  test("turns a non-finite number in a JSON-LD document into null and keeps the document", () => {
    const decoded = decodeStructured({
      jsonld: [{ "@type": "Product", weight: Number.POSITIVE_INFINITY }, { "@type": "WebSite" }],
      meta: {},
      tables: [],
    });
    expect(decoded.jsonld).toStrictEqual([
      { "@type": "Product", weight: null },
      { "@type": "WebSite" },
    ]);
  });
});
