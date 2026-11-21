import type { AskReport, BatchResult } from "../src/ask/run.ts";

export const reportOf = (batches: Partial<BatchResult>[], mode?: "review"): AskReport => {
  const report: AskReport = {
    batches: batches.map((batch, index) => ({
      index: index + 1,
      sources: [],
      answers: [],
      notFound: [],
      ms: 1,
      ...batch,
    })),
    empty: [],
    clipped: [],
  };
  if (mode) report.mode = mode;
  return report;
};

export const notAbsence = [
  "The pricing page lists the Free plan, which does not include SSO",
  "Acme's site says the Free plan does not include API access",
  "Enterprise pricing is not published; contact sales",
  "Phone support is not listed for the Free plan",
  "The site does not provide phone support",
  "The page does not include VAT in the listed prices",
  "The Acme pricing page lists no setup fee",
  "Acme does not include a setup fee",
  "The Acme Starter plan does not provide priority support",
];

export const absence = [
  "The page does not contain pricing information",
  "The page does not provide a price",
  "The document does not include any pricing details",
  "The screenshot lists no prices",
  "The pricing page contains no pricing information for the Pro plan",
  "The listing does not give any price",
  "The text has no pricing data",
];

export const uncertainOnly = [
  "It is unclear whether the Pro plan (annual) includes SSO",
  "The Acme Pro billing period is unclear",
  "It is not clear from the page whether the $96 price includes VAT",
  "Whether Acme Pro (billed yearly) includes SSO is unclear",
];

export const uncertainWithFact = [
  "Acme Pro costs $16 per month, unclear whether taxes are included",
  "It is unclear whether the Pro plan includes SSO, but it includes SCIM",
  "Acme Pro includes SSO; whether SCIM is included is unclear",
];

export const image = (label: string) => ({
  mediaType: "image/jpeg" as const,
  data: Buffer.from(label).toString("base64"),
  label,
});

export const token = () => Math.random().toString(36).slice(2, 10);
