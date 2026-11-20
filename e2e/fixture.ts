import http from "node:http";
import type { AddressInfo } from "node:net";

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
<iframe title="Consent frame" srcdoc="<div id=&quot;consent&quot; style=&quot;position:fixed;top:0&quot;>Cookies? <button onclick=&quot;parent.document.getElementById('frame-state').textContent='frame accepted'&quot;>Alle akzeptieren</button> <button onclick=&quot;parent.document.getElementById('frame-state').textContent='frame rejected'; this.parentElement.remove()&quot;>Alle ablehnen</button></div>"></iframe>
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

const PIXEL = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export type Fixture = {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
};

export async function startFixture(): Promise<Fixture> {
  let hits = 0;
  const pages: Record<string, string> = { "/counter": COUNTER, "/frames": FRAMES, "/checkout": CHECKOUT, "/media": MEDIA, "/sse": SSE, "/hang": HANG };
  const server = http.createServer((request, response) => {
    const pathname = (request.url ?? "/").split("?")[0] ?? "/";
    if (pages[pathname]) {
      response.writeHead(200, { "content-type": "text/html" }).end(pages[pathname]);
    } else if (pathname === "/pixel.png") {
      response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(PIXEL);
    } else if (pathname === "/api/hit") {
      if (request.method === "POST") hits += 1;
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ hits }));
    } else if (pathname === "/events") {
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
      response.write("data: streamed hello\n\n");
    } else if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html" }).end(HOME);
    } else if (pathname === "/article") {
      response.writeHead(200, { "content-type": "text/html" }).end(ARTICLE);
    } else if (pathname === "/doc") {
      response.writeHead(200, { "content-type": "text/html" }).end(DOC);
    } else if (pathname === "/consent") {
      response.writeHead(200, { "content-type": "text/html" }).end(CONSENT);
    } else if (pathname === "/api/data") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ message: "loaded from api" }));
    } else if (pathname === "/api/items") {
      const page = Number(new URL(request.url ?? "/", "http://x").searchParams.get("page") ?? "1");
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ page, items: page <= 3 ? [`item-${page}-a`, `item-${page}-b`] : [], cookie: request.headers.cookie ?? "" }));
    } else if (pathname === "/api/echo") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(request.headers));
    } else if (pathname === "/download") {
      response.writeHead(200, { "content-type": "text/csv", "content-disposition": "attachment; filename=report.csv" }).end("a,b\n1,2\n");
    } else {
      response.writeHead(404, { "content-type": "text/html" }).end("<title>Missing</title><h1>Not found</h1>");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
