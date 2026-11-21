import { browseRouteResponse } from "./fixture-browse.ts";
import { CONTENT_ROUTES, framedPage, PIXEL } from "./fixture-content.ts";
import { edgeCaseResponse, openStream } from "./fixture-edge.ts";

const HOME = `<!doctype html>
<html><head><title>Fixture Home</title>
<meta property="og:title" content="Fixture OG Title">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Fixture Lamp","offers":{"@type":"Offer","price":"49.90","priceCurrency":"EUR","availability":"https://schema.org/InStock"}}</script>
</head><body>
<script>window.appState = { ready: true }; console.log("boot log"); console.error("boot error");</script>
<nav><a href="/article">Read the article</a></nav>
<main>
<h1>Fixture</h1>
<p id="status">idle</p>
<button id="change" onclick="document.getElementById('status').textContent = 'changed'">Change status</button>
<button id="noop">Do nothing</button>
<button id="alert" onclick="alert('Careful now')">Show alert</button>
<button id="load" onclick="fetch('/api/data').then(r => r.json()).then(d => document.getElementById('status').textContent = d.message)">Load data</button>
<button id="echo" onclick="fetch('/api/echo').then(r => r.text()).then(t => document.getElementById('echo-out').textContent = t)">Echo headers</button>
<pre id="echo-out"></pre>
<form onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'submitted'">
<label>Email <input id="email" type="email"></label>
<label>Password <input id="password" type="password"></label>
<label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
<label><input id="terms" type="checkbox"> Accept terms</label>
<label>Avatar <input id="avatar" type="file"></label>
<button type="submit">Sign up</button>
</form>
<form id="signup2" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'form2 ' + new FormData(event.target).get('name')">
<label>Name <input name="name" id="name2" required></label>
<label>Age <input name="age" id="age2" type="number" min="18"></label>
<button id="submit2" type="submit">Register</button>
</form>
<table><caption>Prices</caption><tr><th>Item</th><th>Price</th></tr><tr><td>Lamp, large</td><td>49.90</td></tr><tr><td>Bulb</td><td>3.10</td></tr></table>
<button id="later" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Verified by human'; document.body.append(p); }, 1500)">Start verification</button>
<a id="download" href="/download" download="report.csv">Download report</a>
<a id="popup" href="/article" target="_blank">Open in new tab</a>
<iframe title="Embedded" srcdoc="<button onclick=&quot;parent.document.getElementById('status').textContent='framed'&quot;>Frame button</button>"></iframe>
</main>
</body></html>`;

const ARTICLE = `<!doctype html>
<html><head><title>Fixture Article</title></head><body>
<nav>Navigation chrome that should be skipped</nav>
<article><h1>Long Article</h1>${Array.from({ length: 400 }, (_value, index) => `<p>Paragraph ${index} of the article body with enough words to matter.</p>`).join("")}</article>
<footer>Footer chrome</footer>
</body></html>`;

const DOC = `<!doctype html>
<html><head><title>Fixture Doc</title></head><body>
<nav><a href="/">Doc navigation chrome</a></nav>
<main>
<h1>Doc Title</h1>
<p>Intro with <a href="/article">the article link</a> and <strong>bold words</strong>.</p>
<h2>Steps</h2>
<ul><li>First step<ul><li>Nested detail</li></ul></li><li>Second step</li></ul>
<ol><li>One</li><li>Two</li></ol>
<pre><code class="language-js">const answer = 42;
console.log(answer);</code></pre>
<table><tr><th>Name</th><th>Qty</th></tr><tr><td>Bolt</td><td>7</td></tr><tr><td>Nut | small</td><td>9</td></tr></table>
<div style="display:none">Hidden secret text</div>
<aside>Sidebar chrome</aside>
<p id="idb-status">idb pending</p>
</main>
<footer>Doc footer chrome</footer>
<script>
localStorage.setItem("auth_token", "tok-" + "x".repeat(40));
localStorage.setItem("prefs", JSON.stringify({ theme: "dark" }));
sessionStorage.setItem("tab_state", "s1");
const open = indexedDB.open("fixture-db", 1);
open.onupgradeneeded = () => open.result.createObjectStore("items", { keyPath: "id" });
open.onsuccess = () => {
  const tx = open.result.transaction("items", "readwrite");
  tx.objectStore("items").put({ id: 1, name: "alpha", tags: ["a", "b"] });
  tx.objectStore("items").put({ id: 2, name: "beta", when: new Date(0) });
  tx.oncomplete = () => { document.getElementById("idb-status").textContent = "idb ready"; };
};
</script>
</body></html>`;

const CONSENT = `<!doctype html>
<html><head><title>Fixture Consent</title></head><body>
<main><h1>Shop</h1><p id="status">none</p>
<button onclick="document.getElementById('status').textContent = 'account closed'">Close account</button></main>
<div id="cookie-banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:20px">
We use cookies.
<button onclick="document.getElementById('status').textContent = 'accepted'; this.parentElement.remove()">Accept all</button>
<button onclick="document.getElementById('status').textContent = 'rejected'; this.parentElement.remove()">Reject all</button>
</div>
<div class="newsletter-modal" role="dialog" aria-modal="true" style="position:fixed;top:30%;left:30%;background:white;padding:20px">
Bültenimize abone olun
<button aria-label="Kapat" onclick="document.getElementById('modal-state').textContent = 'modal closed'; this.parentElement.remove()">×</button>
</div>
<p id="modal-state">modal open</p>
<iframe title="Consent frame" srcdoc="<div id=&quot;consent&quot; style=&quot;position:fixed;top:0&quot;>Cookies? <button onclick=&quot;parent.document.getElementById('frame-state').textContent='frame accepted'; this.parentElement.remove()&quot;>Alle akzeptieren</button> <button onclick=&quot;parent.document.getElementById('frame-state').textContent='frame rejected'; this.parentElement.remove()&quot;>Alle ablehnen</button></div>"></iframe>
<p id="frame-state">frame open</p>
</body></html>`;

const COUNTER = `<!doctype html>
<html><head><title>Fixture Counter</title></head><body>
<button id="count" onclick="window.clicks = (window.clicks || 0) + 1; document.getElementById('count-out').textContent = String(window.clicks)">Count</button>
<p id="count-out">0</p>
</body></html>`;

const FRAMES = `<!doctype html>
<html><head><title>Fixture Frames</title></head><body>
<p id="outer">outer unchanged</p>
<iframe title="Inner" srcdoc="<button id=&quot;inner&quot; onclick=&quot;this.textContent='inner clicked'&quot;>Inner only</button>"></iframe>
</body></html>`;

const CHECKOUT = `<!doctype html>
<html><head><meta charset="utf-8"><title>Fixture Checkout</title></head><body>
<main><h1>Checkout</h1><p id="order-state">pending</p></main>
<div class="order-modal" role="dialog" aria-modal="true" style="position:fixed;top:20%;left:20%;z-index:10;background:white;padding:20px">
Siparişinizi onaylıyor musunuz? Gizlilik politikası ve KVKK metnini okudum.
<button onclick="document.getElementById('order-state').textContent = 'dialog dismissed'; this.parentElement.remove()">Vazgeç</button>
<button onclick="document.getElementById('order-state').textContent = 'ORDER PLACED'">Siparişi Onayla</button>
</div>
<div class="checkout-overlay" style="position:sticky;bottom:0;background:#ddd;padding:10px">
<button onclick="document.getElementById('order-state').textContent = 'PAYMENT STARTED'">Continue to payment</button>
</div>
</body></html>`;

const MEDIA = `<!doctype html>
<html><head><title>Fixture Media</title></head><body>
<img id="pixel" src="/pixel.png" alt="pixel">
<p id="media-status">-</p>
<button id="media-load" onclick="fetch('/api/data').then(r => r.json()).then(d => document.getElementById('media-status').textContent = d.message)">Load media data</button>
</body></html>`;

const SSE = `<!doctype html>
<html><head><title>Fixture Stream</title></head><body>
<p id="sse-status">waiting</p>
<script>const source = new EventSource("/events"); source.onmessage = (event) => { document.getElementById("sse-status").textContent = event.data; };</script>
</body></html>`;

const HANG = `<!doctype html>
<html><head><title>Fixture Hang</title></head><body><p>about to hang</p>
<script>setTimeout(() => { for (;;) {} }, 300);</script>
</body></html>`;

export type Fixture = {
  url: string;
  hits: () => number;
  requests: (pathname: string) => number;
  close: () => Promise<void>;
};

function htmlResponse(body: string) {
  return new Response(body, { headers: { "content-type": "text/html" } });
}

export async function startFixture(): Promise<Fixture> {
  let hits = 0;
  const requests = new Map<string, number>();
  const pages = new Map<string, string>(
    Object.entries({
      "/": HOME,
      "/article": ARTICLE,
      "/doc": DOC,
      "/consent": CONSENT,
      "/counter": COUNTER,
      "/frames": FRAMES,
      "/checkout": CHECKOUT,
      "/media": MEDIA,
      "/sse": SSE,
      "/hang": HANG,
    } satisfies Record<string, string>),
  );
  const handle = (request: Request) => {
    const url = new URL(request.url);
    const { pathname } = url;
    requests.set(pathname, (requests.get(pathname) ?? 0) + 1);
    const routed = edgeCaseResponse(request, url) ?? browseRouteResponse(request, url);
    if (routed) return routed;
    const content = CONTENT_ROUTES.get(pathname);
    const page = pages.get(pathname);
    if (pathname === "/framed") return htmlResponse(framedPage(url.origin));
    if (content) {
      const headers = new Headers({ "content-type": content.type });
      if (pathname === "/console") headers.set("permissions-policy", "fixture-feature=()");
      return new Response(content.body(), { headers });
    }
    if (page) return htmlResponse(page);
    if (pathname === "/pixel.png")
      return new Response(PIXEL, {
        headers: { "content-type": "image/png", "cache-control": "no-store" },
      });
    if (pathname === "/api/hit") {
      if (request.method === "POST") hits += 1;
      return Response.json({ hits });
    }
    if (pathname === "/events")
      return openStream("data: streamed hello\n\n", {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
    if (pathname === "/api/data") return Response.json({ message: "loaded from api" });
    if (pathname === "/api/items") {
      const pageNumber = Number(url.searchParams.get("page") ?? "1");
      return Response.json({
        page: pageNumber,
        items: pageNumber <= 3 ? [`item-${pageNumber}-a`, `item-${pageNumber}-b`] : [],
        cookie: request.headers.get("cookie") ?? "",
      });
    }
    if (pathname === "/api/echo") return Response.json(Object.fromEntries(request.headers));
    if (pathname === "/download")
      return new Response("a,b\n1,2\n", {
        headers: {
          "content-type": "text/csv",
          "content-disposition": "attachment; filename=report.csv",
        },
      });
    return new Response("<title>Missing</title><h1>Not found</h1>", {
      status: 404,
      headers: { "content-type": "text/html" },
    });
  };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: handle });
  const port = Number(server.url.port);
  const loopbackV6 = listenOnLoopbackV6(handle, port);
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    requests: (pathname) => requests.get(pathname) ?? 0,
    close: async () => {
      await loopbackV6?.stop(true);
      await server.stop(true);
    },
  };
}

function listenOnLoopbackV6(handle: (request: Request) => Response, port: number) {
  try {
    return Bun.serve({ hostname: "::1", port, idleTimeout: 0, fetch: handle });
  } catch {
    return undefined;
  }
}
