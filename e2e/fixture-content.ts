export const PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

export function tinyPdf(text: string) {
  const content = `BT /F1 18 Tf 20 100 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

const contentToken = () => Math.random().toString(36).slice(2, 10);

export const CONTENT = {
  pdfText: `Quarterly total ${contentToken()}`,
  json: JSON.stringify({ name: `json-${contentToken()}`, items: [1, 2, 3] }),
  text: `plain notes ${contentToken()}\nsecond line`,
  csv: `name,value\nrow-${contentToken()},7\n`,
  binary: Buffer.from(Array.from({ length: 64 }, (_value, index) => (index * 37) % 256)),
};

type ContentRoute = { type: string; body: () => Buffer<ArrayBuffer> | string };

export const CONTENT_ROUTES = new Map<string, ContentRoute>(
  Object.entries({
    "/files/report.pdf": { type: "application/pdf", body: () => tinyPdf(CONTENT.pdfText) },
    "/files/data.json": { type: "application/json; charset=utf-8", body: () => CONTENT.json },
    "/files/notes.txt": { type: "text/plain; charset=utf-8", body: () => CONTENT.text },
    "/files/table.csv": { type: "text/csv", body: () => CONTENT.csv },
    "/files/pixel.png": { type: "image/png", body: () => PIXEL },
    "/files/blob.bin": { type: "application/octet-stream", body: () => CONTENT.binary },
  } satisfies Record<string, ContentRoute>),
);

export const FEED_TOTAL = 50;

const FEED = `<!doctype html>
<html><head><title>Fixture Feed</title><style>.item { height: 120px; border-bottom: 1px solid #ccc; }</style></head><body>
<main id="feed"></main>
<script>
let shown = 0;
let loading = false;
const more = () => {
  for (let index = 0; index < 10 && shown < ${FEED_TOTAL}; index += 1) {
    shown += 1;
    const item = document.createElement("div");
    item.className = "item";
    item.textContent = "Feed item " + shown;
    document.getElementById("feed").append(item);
  }
};
more();
addEventListener("scroll", () => {
  if (loading || shown >= ${FEED_TOTAL} || innerHeight + scrollY < document.body.scrollHeight - 200) return;
  loading = true;
  setTimeout(() => { more(); loading = false; }, 150);
});
</script>
</body></html>`;

CONTENT_ROUTES.set("/feed", { type: "text/html", body: () => FEED });

export const FRAME_TEXT = {
  outer: `outer text ${contentToken()}`,
  same: `same origin text ${contentToken()}`,
  cross: `cross origin text ${contentToken()}`,
};

CONTENT_ROUTES.set("/frame-same", {
  type: "text/html",
  body: () => `<!doctype html><title>Same</title><p>${FRAME_TEXT.same}</p>`,
});
CONTENT_ROUTES.set("/frame-cross", {
  type: "text/html",
  body: () => `<!doctype html><title>Cross</title><p>${FRAME_TEXT.cross}</p>`,
});

export function framedPage(fixtureUrl: string) {
  const cross = fixtureUrl.replace("127.0.0.1", "localhost");
  return `<!doctype html><html><head><title>Fixture Framed</title></head><body><main><p>${FRAME_TEXT.outer}</p>
<iframe title="Same" src="/frame-same"></iframe>
<iframe title="Cross" src="${cross}/frame-cross"></iframe></main></body></html>`;
}

export const SPA_TEXT = {
  item: `SPA item ${contentToken()}`,
  skeleton: `Loading placeholder ${contentToken()}`,
};

CONTENT_ROUTES.set("/spa", {
  type: "text/html",
  body: () => `<!doctype html><html><head><title>Fixture SPA</title></head><body><main id="app"><div class="skeleton-list">${SPA_TEXT.skeleton}</div></main>
<script>
setTimeout(() => fetch("/api/data").then((response) => response.json()).then(() => {
  const list = document.createElement("ul");
  for (let index = 1; index <= 5; index += 1) {
    const item = document.createElement("li");
    item.textContent = "${SPA_TEXT.item} " + index;
    list.append(item);
  }
  document.getElementById("app").append(list);
  document.querySelector(".skeleton-list").remove();
}), 1500);
</script></body></html>`,
});

CONTENT_ROUTES.set("/ticker", {
  type: "text/html",
  body: () => `<!doctype html><html><head><title>Fixture Ticker</title></head><body><main><p id="tick">0</p></main>
<script>let ticks = 0; setInterval(() => { ticks += 1; document.getElementById("tick").textContent = "tick " + ticks + " ".repeat(ticks % 7); }, 100);</script></body></html>`,
});

export const REVEAL_COLORS = {
  reveal: [0, 170, 0],
  image: [220, 0, 0],
  bar: [255, 136, 0],
  footer: [0, 0, 255],
} as const;

const filler = (from: number, count: number) =>
  Array.from(
    { length: count },
    (_value, index) =>
      `<p style="margin:0;padding:8px 24px;font:16px sans-serif">Line ${from + index} of the reveal page describes the product in plain words.</p>`,
  ).join("");

CONTENT_ROUTES.set("/reveal", {
  type: "text/html",
  body: () => `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Reveal</title>
<style>body{margin:0;background:#fff}.reveal{opacity:0;transform:translateY(40px);transition:opacity .5s,transform .5s}.reveal.shown{opacity:1;transform:none}</style></head><body>
<header style="height:80px;background:#222;color:#fff;font:24px sans-serif;padding:24px">Reveal shop</header>
${filler(1, 30)}
<div class="reveal" style="height:300px;background:rgb(${REVEAL_COLORS.reveal.join(",")})"></div>
${filler(31, 30)}
<img loading="lazy" alt="Swatch" src="/files/swatch.svg" width="600" height="300" style="display:block;margin:0 24px">
${filler(61, 30)}
<p id="count" style="font:32px sans-serif;margin:24px">0+</p><div id="bar" style="height:40px;width:0;background:rgb(${REVEAL_COLORS.bar.join(",")})"></div>
${filler(91, 30)}
<footer style="height:200px;background:rgb(${REVEAL_COLORS.footer.join(",")})"></footer>
<script>
const seen = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    seen.unobserve(entry.target);
    if (entry.target.id === "count") {
      const started = performance.now();
      const step = (now) => {
        const value = Math.min(500, Math.round(((now - started) / 800) * 500));
        entry.target.textContent = value + "+";
        document.getElementById("bar").style.width = (value / 500) * 600 + "px";
        if (value < 500) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    } else entry.target.classList.add("shown");
  }
});
document.querySelectorAll(".reveal, #count").forEach((element) => seen.observe(element));
</script></body></html>`,
});

CONTENT_ROUTES.set("/files/swatch.svg", {
  type: "image/svg+xml",
  body: () =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="rgb(${REVEAL_COLORS.image.join(",")})"/></svg>`,
});

CONTENT_ROUTES.set("/console", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Console</title></head><body><p>Console page</p><script>console.log("page log line"); setTimeout(() => { throw new Error("uncaught page error"); }, 0);</script></body></html>`,
});

CONTENT_ROUTES.set("/load-errors", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Load Errors</title></head><body onload="undefined.xyz"><p>Load errors</p><script>console.log("plain page log"); Promise.reject(new Error("rejected on load"));</script></body></html>`,
});

CONTENT_ROUTES.set("/load-errors-leave", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Load Errors Leave</title></head><body onload="undefined.leaving"><p>Leaving</p><script>Promise.reject(new Error("rejected before leaving")); setTimeout(() => { location.href = "/"; }, 300);</script></body></html>`,
});

const LATE_ERRORS = `onload = () => setTimeout(() => { Promise.reject(new Error("late rejection")); Promise.reject(new DOMException("late abort", "AbortError")); undefined.lateUncaught; }, 300);`;

CONTENT_ROUTES.set("/late-errors", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Late Errors</title></head><body><p>Late errors</p><script>${LATE_ERRORS}</script></body></html>`,
});

CONTENT_ROUTES.set("/late-errors-leave", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Late Errors Leave</title></head><body><p>Late errors leave</p><script>${LATE_ERRORS} setTimeout(() => { location.href = "/"; }, 600);</script></body></html>`,
});

CONTENT_ROUTES.set("/errors-then-leave", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Errors Then Leave</title></head><body><p>Errors then leave</p><script>const after = Number(new URLSearchParams(location.search).get("after")); Promise.reject(new Error("leaving rejection " + location.search)); setTimeout(() => { location.replace("/"); }, after);</script><script>undefined.leavingUncaught;</script></body></html>`,
});

CONTENT_ROUTES.set("/leaving-popup-opener", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Leaving Popup Opener</title></head><body><button id="open-leaving" onclick="const params = new URLSearchParams(location.search); window.open('/errors-then-leave?after=' + params.get('after') + '&run=' + params.get('run'))">Open a page that leaves</button></body></html>`,
});

CONTENT_ROUTES.set("/beforeunload-error", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Beforeunload Error</title></head><body><p>Beforeunload error</p><script>addEventListener("beforeunload", () => { undefined.beforeUnloadUncaught; });</script></body></html>`,
});

CONTENT_ROUTES.set("/onload-error", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Onload Error</title></head><body onload="undefined.onloadError"><p>Onload error</p></body></html>`,
});

CONTENT_ROUTES.set("/onload-late-error", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Onload Late Error</title></head><body onload="undefined.afterImage"><p>Onload after an image</p><iframe title="slow" src="/files/slow-frame"></iframe></body></html>`,
});

CONTENT_ROUTES.set("/never-loads", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Never Loads</title></head><body><p>Never loads</p><iframe title="pending" src="/api/pending"></iframe></body></html>`,
});

CONTENT_ROUTES.set("/load-error-traps", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Load Error Traps</title><script>
window.trapped = [];
const note = (name) => { window.trapped[window.trapped.length] = name; };
const message = Object.getOwnPropertyDescriptor(ErrorEvent.prototype, "message").get;
Object.defineProperty(ErrorEvent.prototype, "message", { get() { note("ErrorEvent.message"); return message.call(this); } });
const reason = Object.getOwnPropertyDescriptor(PromiseRejectionEvent.prototype, "reason").get;
Object.defineProperty(PromiseRejectionEvent.prototype, "reason", { get() { note("PromiseRejectionEvent.reason"); return reason.call(this); } });
const toIso = Date.prototype.toISOString;
Date.prototype.toISOString = function () { note("toISOString"); return toIso.call(this); };
const slice = String.prototype.slice;
String.prototype.slice = function (...args) { note("slice"); return slice.apply(this, args); };
const push = Array.prototype.push;
Array.prototype.push = function (...args) { note("push"); return push.apply(this, args); };
const exec = RegExp.prototype.exec;
RegExp.prototype.exec = function (...args) { note("exec"); return exec.apply(this, args); };
const stringify = JSON.stringify;
JSON.stringify = (...args) => { note("stringify"); return stringify(...args); };
const watched = new Error("trapped rejection");
Object.defineProperty(watched, "stack", { get() { note("stack"); return "watched stack"; } });
Promise.reject(watched);
setTimeout(() => { undefined.trap; }, 0);
</script></head><body><p>Traps</p></body></html>`,
});

CONTENT_ROUTES.set("/load-error-probe", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Load Error Probe</title><script>
window.probe = { trapHits: [] };
const hit = (name) => { window.probe.trapHits[window.probe.trapHits.length] = name; };
const watched = new Proxy({}, {
  getOwnPropertyDescriptor(target, key) { hit("getOwnPropertyDescriptor " + String(key)); return undefined; },
  get(target, key) { hit("get " + String(key)); return undefined; },
  has(target, key) { hit("has " + String(key)); return false; },
  ownKeys() { hit("ownKeys"); return []; },
  getPrototypeOf() { hit("getPrototypeOf"); return Object.prototype; },
});
Promise.reject(watched);
const late = new Error("formatted later");
Promise.reject(late);
/(clean)/.exec("clean-input");
addEventListener("unhandledrejection", () => {
  window.probe.matched = [RegExp.input, RegExp.lastMatch, RegExp.$1].join(" | ");
});
addEventListener("pagehide", () => sessionStorage.setItem("probe", JSON.stringify(window.probe)));
setTimeout(() => {
  Error.prepareStackTrace = () => "the page's own format";
  window.probe.stack = String(late.stack);
  delete Error.prepareStackTrace;
}, 200);
</script></head><body><p>Probe</p></body></html>`,
});

CONTENT_ROUTES.set("/console-malformed", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Console Malformed</title></head><body><p>Console page</p><script>console.log("line before"); window[Symbol.for("web-agent-mcp.console")]?.push({ level: "log" }); console.log("line after");</script></body></html>`,
});

CONTENT_ROUTES.set("/site-globals", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Site Globals</title></head><body><p id="status">idle</p><button id="change" onclick="document.getElementById('status').textContent = 'changed'">Change status</button><script>window.webAgentConsole = ["site entry"]; window.webAgentMutations = { count: 0 }; console.log("page log line");</script></body></html>`,
});

CONTENT_ROUTES.set("/files/console-source.js", {
  type: "application/javascript",
  body: () =>
    [
      `window.logMore = () => console.log("second entry");`,
      `console.error("located error");`,
      `setTimeout(() => { throw new Error("located throw"); }, 0);`,
      `console.log("first entry");`,
    ].join("\n"),
});

CONTENT_ROUTES.set("/console-cursor", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Console Cursor</title></head><body><p>Console cursor</p><script src="/files/console-source.js"></script></body></html>`,
});

CONTENT_ROUTES.set("/pending-request", {
  type: "text/html",
  body: () =>
    `<!doctype html><html><head><title>Fixture Pending</title></head><body><p>Pending</p><script>fetch("/api/pending");</script></body></html>`,
});
