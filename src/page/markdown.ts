import type { Frame, Locator, Page } from "playwright-core";

type MarkdownMode = "main" | "page" | "element";

function renderMarkdown(root: Element, mode: MarkdownMode) {
  const SKIP = new Set([
    "SCRIPT",
    "STYLE",
    "NOSCRIPT",
    "TEMPLATE",
    "SVG",
    "CANVAS",
    "IFRAME",
    "OBJECT",
    "NAV",
    "FOOTER",
    "ASIDE",
    "SELECT",
    "BUTTON",
  ]);
  const BLOCK = new Set([
    "P",
    "DIV",
    "SECTION",
    "ARTICLE",
    "MAIN",
    "HEADER",
    "UL",
    "OL",
    "LI",
    "PRE",
    "TABLE",
    "BLOCKQUOTE",
    "FIGURE",
    "FIGCAPTION",
    "DL",
    "DT",
    "DD",
    "HR",
    "FORM",
    "FIELDSET",
    "DETAILS",
    "SUMMARY",
    "ADDRESS",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
  ]);

  let start = root;
  if (mode === "main") {
    const whole = root instanceof HTMLElement ? root.innerText.length : 0;
    const best = [...root.querySelectorAll<HTMLElement>("main, article, [role=main]")].toSorted(
      (a, b) => b.innerText.length - a.innerText.length,
    )[0];
    if (best && best.innerText.length >= whole / 3) start = best;
  }

  const markup = {
    hidden(element: Element) {
      if (element.hasAttribute("hidden") || element.getAttribute("aria-hidden") === "true")
        return true;
      const style = getComputedStyle(element);
      return style.display === "none" || style.visibility === "hidden";
    },
    squash(text: string) {
      return text.replace(/[ \t\r\n]+/g, " ");
    },
    wrap(mark: string, text: string) {
      return text.trim() ? `${mark}${text.trim()}${mark}` : "";
    },
    tidy(text: string) {
      return text
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .trim();
    },
    indent(text: string, prefix: string) {
      return text
        .split("\n")
        .map((line) => (line ? prefix + line : line))
        .join("\n");
    },
  };
  const skip = (element: Element) =>
    element !== start && (SKIP.has(element.tagName.toUpperCase()) || markup.hidden(element));

  const inline = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return markup.squash(node.textContent ?? "");
    if (!(node instanceof Element) || skip(node)) return "";
    const tag = node.tagName.toUpperCase();
    const inner = () => [...node.childNodes].map(inline).join("");
    if (tag === "BR") return "\n";
    if (tag === "IMG") {
      const alt = markup.squash(node.getAttribute("alt") ?? "").trim();
      return alt && node instanceof HTMLImageElement ? `![${alt}](${node.src})` : "";
    }
    if (tag === "A") {
      const text = inner().trim();
      const href = node instanceof HTMLAnchorElement ? node.href : "";
      return text && /^(https?|mailto|tel):/i.test(href) ? `[${text}](${href})` : text;
    }
    if (tag === "CODE" || tag === "KBD" || tag === "SAMP") {
      const code = markup.squash(node.textContent ?? "").trim();
      return code ? `\`${code}\`` : "";
    }
    if (tag === "STRONG" || tag === "B") return markup.wrap("**", inner());
    if (tag === "EM" || tag === "I") return markup.wrap("*", inner());
    if (tag === "INPUT" || tag === "TEXTAREA") return "";
    if (BLOCK.has(tag)) return ` ${inner()} `;
    return inner();
  };

  const cellText = (cell: Element) =>
    markup.tidy(inline(cell)).replace(/\n+/g, " ").replace(/\|/g, "\\|");

  const table = (element: HTMLTableElement) => {
    const rows = [...element.rows]
      .filter((row) => !markup.hidden(row))
      .map((row) => [...row.cells].map(cellText));
    const width = Math.max(0, ...rows.map((row) => row.length));
    if (width === 0) return "";
    const line = (cells: string[]) =>
      `| ${Array.from({ length: width }, (_value, index) => cells[index] ?? "").join(" | ")} |`;
    const [head = [], ...body] = rows;
    const caption = element.caption ? `${markup.tidy(inline(element.caption))}\n\n` : "";
    return `${caption}${[line(head), line(Array(width).fill("---")), ...body.map(line)].join("\n")}`;
  };

  const list = (element: Element, depth: number) => {
    const ordered = element.tagName.toUpperCase() === "OL";
    let number = Number(element.getAttribute("start") ?? "1") || 1;
    const items: string[] = [];
    for (const item of element.children) {
      if (item.tagName.toUpperCase() !== "LI" || skip(item)) continue;
      const parts: string[] = [];
      walk(item, parts, depth + 1);
      const marker = ordered ? `${number++}.` : "-";
      const [first = "", ...rest] = parts;
      const pad = "  ".repeat(depth);
      const nested = rest.map((part) =>
        /^\s*(-|\d+\.) /.test(part) ? part : markup.indent(part, `${pad}  `),
      );
      items.push([`${pad}${marker} ${first}`, ...nested].join("\n"));
    }
    return items.join("\n");
  };

  const block = (element: Element, out: string[], depth: number) => {
    const tag = element.tagName.toUpperCase();
    const heading = /^H([1-6])$/.exec(tag);
    let text = "";
    if (heading)
      text = `${"#".repeat(Number(heading[1]))} ${markup.tidy(inline(element)).replace(/\n+/g, " ")}`;
    else if (tag === "PRE") {
      const language =
        /language-([\w+-]+)/.exec(
          `${element.className} ${element.querySelector("code")?.className ?? ""}`,
        )?.[1] ?? "";
      text = `\`\`\`${language}\n${(element.textContent ?? "").replace(/\n+$/, "")}\n\`\`\``;
    } else if (tag === "UL" || tag === "OL") text = list(element, depth);
    else if (element instanceof HTMLTableElement) text = table(element);
    else if (tag === "HR") text = "---";
    else if (tag === "BLOCKQUOTE") {
      const inner: string[] = [];
      walk(element, inner, depth);
      text = markup.indent(inner.join("\n\n"), "> ");
    } else return walk(element, out, depth);
    if (text.trim()) out.push(text);
  };

  const walk = (element: Element, out: string[], depth: number) => {
    let run = "";
    const flush = () => {
      const text = markup.tidy(run);
      if (text) out.push(text);
      run = "";
    };
    for (const child of element.childNodes) {
      if (child instanceof Element && BLOCK.has(child.tagName.toUpperCase())) {
        if (skip(child)) continue;
        flush();
        block(child, out, depth);
      } else run += inline(child);
    }
    flush();
  };

  const out: string[] = [];
  if (start !== root || mode === "element") block(start, out, 0);
  else walk(start, out, 0);
  return out
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function pageMarkdown(page: Page, scope: "main" | "page") {
  return page.locator("body").evaluate(renderMarkdown, scope);
}

export function elementMarkdown(locator: Locator) {
  return locator.evaluate<string, MarkdownMode>(renderMarkdown, "element");
}

export function frameMarkdown(frame: Frame) {
  return frame
    .locator("body")
    .evaluate<string, MarkdownMode>(renderMarkdown, "page", { timeout: 5000 });
}
