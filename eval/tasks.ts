export type Family = "tabs and navigation" | "reading" | "forms and sign-in" | "bulk pages" | "visual checks" | "network and data" | "scripts" | "debugging";

export type Task = {
  id: string;
  family: Family;
  prompt: (base: string, context: { reference: string; failedRequest: string }) => string;
  expect: string[];
  prelude?: string[];
  forbidden?: string[];
  expectArgs?: Record<string, unknown>;
};

export const SETUP_TOOLS = ["ToolSearch", "tabs_list", "tab_open", "navigate", "site_notes"];

const OFF_BROWSER = ["WebFetch", "WebSearch", "Bash"];

export const TASKS: Task[] = [
  {
    id: "phone-dark",
    family: "tabs and navigation",
    prompt: (base) => `How does ${base}/doc look on a phone with dark mode turned on? Have a look and describe it briefly.`,
    expect: ["emulate"],
    forbidden: OFF_BROWSER,
  },
  {
    id: "read-steps",
    family: "reading",
    prompt: (base) => `What are the steps listed on ${base}/doc? Just list them.`,
    expect: ["read_text"],
    forbidden: [...OFF_BROWSER, "screenshot"],
  },
  {
    id: "product-price",
    family: "reading",
    prompt: (base) => `What product is sold on ${base}/ and what are its price and availability?`,
    expect: ["extract"],
    forbidden: OFF_BROWSER,
  },
  {
    id: "press-load",
    family: "reading",
    prompt: (base) => `On ${base}/ there is a "Load data" button. Press it and tell me what the status line says afterwards.`,
    expect: ["find", "snapshot", "click"],
    forbidden: [...OFF_BROWSER, "evaluate", "run_script"],
  },
  {
    id: "signup-form",
    family: "forms and sign-in",
    prompt: (base) => `Sign me up on ${base}/ with the email eval@example.com, password Hunter2!x, the Pro plan, terms accepted, and submit it.`,
    expect: ["fill_form"],
    prelude: ["snapshot", "find", "dismiss_overlays"],
    forbidden: [...OFF_BROWSER, "evaluate", "run_script"],
  },
  {
    id: "captcha",
    family: "forms and sign-in",
    prompt: (base) => `Open ${base}/challenge/hcaptcha and get past the human verification on it so we can continue.`,
    expect: ["handoff"],
    prelude: ["snapshot", "find", "screenshot", "read_text"],
    forbidden: [...OFF_BROWSER, "click", "evaluate", "run_script"],
  },
  {
    id: "consent-banner",
    family: "forms and sign-in",
    prompt: (base) => `${base}/consent has a cookie banner and a pop-up covering it. Clear them out of the way so the shop page is usable.`,
    expect: ["dismiss_overlays"],
    prelude: ["snapshot", "find", "screenshot"],
    forbidden: [...OFF_BROWSER, "evaluate", "run_script"],
  },
  {
    id: "many-pages-facts",
    family: "bulk pages",
    prompt: (base) =>
      `Which of these pages mention "Paragraph 7"? ${["/article", "/doc", "/", "/text", "/feed", "/counter", "/frames", "/media"].map((route) => `${base}${route}`).join(" ")}`,
    expect: ["collect_pages", "ask_pages"],
    forbidden: [...OFF_BROWSER, "read_text", "snapshot"],
  },
  {
    id: "staging-layout",
    family: "visual checks",
    prompt: (base) =>
      `Go through these staging pages and tell me which ones have broken layouts or visual glitches: ${["/", "/doc", "/article", "/consent", "/checkout", "/media", "/feed", "/widgets"].map((route) => `${base}${route}`).join(" ")}`,
    expect: ["ask_pages"],
    expectArgs: { mode: "review" },
    forbidden: [...OFF_BROWSER, "screenshot"],
  },
  {
    id: "figma-match",
    family: "visual checks",
    prompt: (base, files) => `This is the Figma export of the doc page: ${files.reference}. Does ${base}/doc match the design?`,
    expect: ["compare_design"],
    forbidden: [...OFF_BROWSER, "screenshot"],
  },
  {
    id: "catalog-api",
    family: "network and data",
    prompt: (base) => `The catalog at ${base}/catalog fills its table from an API. Find that API and get the items from all of its pages.`,
    expect: ["network_requests"],
    prelude: ["snapshot", "read_text", "wait_for"],
    forbidden: OFF_BROWSER,
  },
  {
    id: "local-storage",
    family: "network and data",
    prompt: (base) => `What does ${base}/doc keep in the browser's local storage? Is there an auth token in there?`,
    expect: ["storage"],
    forbidden: [...OFF_BROWSER, "evaluate", "run_script"],
  },
  {
    id: "api-call",
    family: "network and data",
    prompt: (base) => `Call ${base}/api/data with my browser session and show me the JSON it returns.`,
    expect: ["request"],
    forbidden: [...OFF_BROWSER, "evaluate", "run_script"],
  },
  {
    id: "count-clicks",
    family: "scripts",
    prompt: (base) => `On ${base}/counter, press the Count button 25 times and tell me the number it shows at the end.`,
    expect: ["run_script"],
    prelude: ["snapshot", "find"],
    forbidden: OFF_BROWSER,
  },
  {
    id: "app-state",
    family: "scripts",
    prompt: (base) => `What is in the page's window.appState object on ${base}/ ?`,
    expect: ["evaluate"],
    forbidden: [...OFF_BROWSER, "run_script"],
  },
  {
    id: "failed-call",
    family: "debugging",
    prompt: (_base, context) => `A browser tool call failed a minute ago and the error ended with [req ${context.failedRequest}]. What went wrong?`,
    expect: ["server_log"],
    forbidden: OFF_BROWSER,
  },
];
