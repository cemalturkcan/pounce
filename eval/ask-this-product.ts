import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { anthropicAskAdapter } from "../src/ask-anthropic.ts";
import { askPages, type AskAdapter, type AskDocument, loadAdapterModule, modelId, renderAskResults } from "../src/ask.ts";

const EVAL_DIR = import.meta.dirname;

export const QUESTION = "For this product, is there a free plan, what is the cheapest paid plan and one free-plan limit?";

type Product = { name: string; slug: string; paid: string; price: string; limit: string; extra: string };

export const PRODUCTS: Product[] = [
  { name: "Notewise", slug: "notewise-com", paid: "Plus", price: "$4", limit: "up to 50 notes", extra: "Sync across devices" },
  { name: "Tallyboard", slug: "tallyboard-io", paid: "Team", price: "$9", limit: "3 boards", extra: "Custom fields" },
  { name: "Mailcrate", slug: "mailcrate-app", paid: "Starter", price: "$12", limit: "500 emails per month", extra: "Scheduled sends" },
  { name: "Formfold", slug: "formfold-co", paid: "Basic", price: "€6", limit: "100 responses per month", extra: "File uploads" },
  { name: "Pixelpond", slug: "pixelpond-com", paid: "Creator", price: "$8", limit: "2 GB of storage", extra: "Custom domains" },
  { name: "Shiftly", slug: "shiftly-io", paid: "Pro", price: "$3 per user", limit: "10 staff members", extra: "Payroll export" },
  { name: "Quillbase", slug: "quillbase-dev", paid: "Writer", price: "$10", limit: "5 documents", extra: "Version history" },
  { name: "Routewell", slug: "routewell-com", paid: "Fleet", price: "$19", limit: "1 vehicle", extra: "Live tracking" },
  { name: "Snapledger", slug: "snapledger-app", paid: "Solo", price: "£5", limit: "20 receipts per month", extra: "Bank feeds" },
  { name: "Huddlecast", slug: "huddlecast-io", paid: "Studio", price: "$15", limit: "40-minute meetings", extra: "Cloud recording" },
  { name: "Gridnest", slug: "gridnest-com", paid: "Growth", price: "$25", limit: "1,000 rows per table", extra: "Automations" },
  { name: "Tasktern", slug: "tasktern-co", paid: "Personal", price: "$2", limit: "1 project", extra: "Reminders" },
  { name: "Clipvault", slug: "clipvault-io", paid: "Plus", price: "$7", limit: "720p exports", extra: "Brand kit" },
  { name: "Ledgerly", slug: "ledgerly-app", paid: "Essentials", price: "$11", limit: "2 invoices per month", extra: "Recurring invoices" },
  { name: "Surveyo", slug: "surveyo-com", paid: "Advantage", price: "€14", limit: "10 questions per survey", extra: "Logic branching" },
];

export function pricingPage(product: Product, index: number): AskDocument {
  const source = `${String(index + 1).padStart(2, "0")}-${product.slug}-pricing.md`;
  const text = `<!-- URL: https://${product.slug.replace(/-(?=[a-z]+$)/, ".")}/pricing · Status: 200 -->
# ${product.name} pricing

Simple plans for teams of every size. Start for free, upgrade when you grow.

## Free
$0 forever. Everything you need to try ${product.name}.
- ${product.limit}
- Community support
- Basic templates

## ${product.paid}
${product.price} per month, billed yearly.
- Everything in Free
- ${product.extra}
- Email support

## Business
Contact sales for a quote.
- Single sign-on
- Audit log
- Dedicated success manager

## FAQ
**Can I cancel anytime?** Yes, plans can be cancelled at any time from the billing page.
**Do you offer discounts for nonprofits?** Yes, write to us for a nonprofit discount.
`;
  return { source, text };
}

export function scoreReply(answers: string[], notFound: string[], documents: AskDocument[]) {
  return documents.map((document, index) => {
    const product = PRODUCTS[index] as Product;
    const lines = answers.filter((answer) => answer.endsWith(`[${document.source}]`));
    const text = lines.join("\n");
    return {
      source: document.source,
      answered: lines.length > 0,
      notFound: notFound.includes(document.source),
      price: text.includes(product.price),
      limit: text.includes(product.limit),
    };
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      adapter: { type: "string" },
      model: { type: "string", default: "haiku" },
      label: { type: "string", default: "run" },
      out: { type: "string", default: path.join(EVAL_DIR, "results") },
    },
  });
  const adapter: AskAdapter = values.adapter ? await loadAdapterModule(path.resolve(values.adapter)) : anthropicAskAdapter();
  const documents = PRODUCTS.map(pricingPage);
  const model = modelId(values.model ?? "haiku");
  const report = await askPages(adapter, { question: QUESTION, documents, batchChars: 3_000_000, concurrency: 1, model, maxTokens: 16_000 });
  const answers = report.batches.flatMap((batch) => batch.answers);
  const notFound = report.batches.flatMap((batch) => batch.notFound);
  const rows = scoreReply(answers, notFound, documents);
  const answered = rows.filter((row) => row.answered && !row.notFound).length;
  const facts = rows.filter((row) => row.price && row.limit).length;
  await mkdir(values.out ?? "", { recursive: true });
  await writeFile(path.join(values.out ?? "", `${values.label}-ask-this-product.md`), `${renderAskResults(QUESTION, report, adapter.name, model)}\n\n${JSON.stringify(rows, null, 2)}\n`);
  console.log(["| page | answered | NOT FOUND | price | limit |", "|---|---|---|---|---|", ...rows.map((row) => `| ${row.source} | ${row.answered} | ${row.notFound} | ${row.price} | ${row.limit} |`)].join("\n"));
  console.log(`\n${values.label}: ${answered}/${rows.length} pages answered, ${facts}/${rows.length} with the cheapest price and the free-plan limit`);
  if (answered < rows.length) process.exitCode = 1;
}

if (import.meta.main) await main();
