import { zstdCompressSync } from "node:zlib";

export const edgeAuth = { username: "", password: "" };

const EDGE_HTML = (title: string, body: string) =>
  `<!doctype html>\n<html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

type EdgePage = { status?: number; html: string };

const EDGE_PAGES = new Map<string, EdgePage>(
  Object.entries({
    "/challenge/start": {
      html: EDGE_HTML(
        "Challenge Start",
        `<a id="to-recaptcha" href="/challenge/recaptcha">Continue</a><button id="inject-hcaptcha" onclick="document.body.insertAdjacentHTML('beforeend', '<div class=&quot;h-captcha&quot;><iframe title=&quot;Widget containing checkbox for hCaptcha security challenge&quot; src=&quot;/captcha/v1/abc/static/hcaptcha.html#frame=checkbox&quot; width=&quot;300&quot; height=&quot;80&quot;></iframe></div>')">Load widget</button>`,
      ),
    },
    "/challenge/recaptcha": {
      html: EDGE_HTML(
        "Login",
        `<form><input name="user"><iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture&amp;size=normal" width="304" height="78"></iframe></form>`,
      ),
    },
    "/challenge/recaptcha-invisible": {
      html: EDGE_HTML(
        "Shop",
        `<p>Shop</p><div class="grecaptcha-badge"><iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture&amp;size=invisible" width="256" height="60"></iframe></div>`,
      ),
    },
    "/challenge/hcaptcha": {
      html: EDGE_HTML(
        "Signup",
        `<div class="h-captcha" data-sitekey="fixture"><iframe title="Widget containing checkbox for hCaptcha security challenge" src="/captcha/v1/abc/static/hcaptcha.html#frame=checkbox" width="300" height="80"></iframe></div>`,
      ),
    },
    "/challenge/turnstile": {
      html: EDGE_HTML(
        "Contact",
        `<div class="cf-turnstile" data-sitekey="fixture"><iframe title="Widget containing a Cloudflare security challenge" src="/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal" width="300" height="65"></iframe><input type="hidden" name="cf-turnstile-response"></div>`,
      ),
    },
    "/challenge/cloudflare": {
      status: 403,
      html: EDGE_HTML(
        "Just a moment...",
        `<div class="main-wrapper"><h1>127.0.0.1</h1><p id="challenge-body-text">Verify you are human by completing the action below.</p><div id="challenge-stage"></div><form id="challenge-form" action="/challenge/cloudflare" method="POST"></form></div>`,
      ),
    },
    "/challenge/blocked": {
      status: 429,
      html: EDGE_HTML(
        "Too Many Requests",
        `<h1>Too many requests</h1><p>You have been rate limited. Try again later.</p>`,
      ),
    },
    "/challenge/plain-error": {
      status: 403,
      html: EDGE_HTML(
        "Members",
        `<h1>Members area</h1><p>Your plan does not include this report.</p>`,
      ),
    },
    "/unsaved": {
      html: EDGE_HTML(
        "Unsaved Draft",
        `<textarea id="draft"></textarea><a id="leave" href="/">Leave</a><script>addEventListener("beforeunload", (event) => { event.preventDefault(); event.returnValue = ""; });</script>`,
      ),
    },
    "/passkey": {
      html: EDGE_HTML(
        "Passkey",
        `<button id="passkey" onclick="navigator.credentials.get({ publicKey: { challenge: new Uint8Array(32), timeout: 20000, userVerification: 'preferred' } }).catch(() => undefined)">Sign in with a passkey</button><button id="conditional" onclick="navigator.credentials.get({ mediation: 'conditional', publicKey: { challenge: new Uint8Array(32) } }).catch(() => undefined)">Autofill</button><button id="plain" onclick="document.title = 'clicked'">Plain</button>`,
      ),
    },
    "/popups": {
      html: EDGE_HTML(
        "Popup Opener",
        `<p id="opener-state">waiting</p><button id="open-popup" onclick="window.open('/popup-child', 'oauth', 'width=420,height=420')">Sign in with provider</button>`,
      ),
    },
    "/popup-child": {
      html: EDGE_HTML(
        "Provider",
        `<button id="finish" onclick="window.opener && (window.opener.document.getElementById('opener-state').textContent = 'signed in'); window.close()">Allow</button>`,
      ),
    },
    "/popup-onload": {
      html: EDGE_HTML(
        "Popup On Load",
        `<p>promo</p><script>window.open("/popup-child", "promo");</script>`,
      ),
    },
    "/app/account": {
      html: EDGE_HTML(
        "Account",
        `<h1>Your account</h1><a id="to-private" href="/app/private">Private report</a><a id="to-login" href="/login">Switch account</a>`,
      ),
    },
    "/app/inline": {
      html: EDGE_HTML(
        "Account",
        `<h1>Oturum aç</h1><form><input name="email"><input type="password" name="password"><button>Giriş yap</button></form>`,
      ),
    },
    "/login": {
      html: EDGE_HTML(
        "Sign in",
        `<h1>Sign in</h1><form><input name="email"><input type="password" name="password"><button>Sign in</button></form>`,
      ),
    },
    "/label-toggle": {
      html: EDGE_HTML(
        "Billing",
        `<div style="position:relative;display:inline-block"><input type="checkbox" id="yearly" style="position:absolute;inset:0;margin:0;opacity:0.01"><label for="yearly" style="position:relative;z-index:1;display:block;padding:8px">Billed yearly</label></div>`,
      ),
    },
    "/widgets": {
      html: EDGE_HTML(
        "Widgets",
        `<p id="fruit-state">none</p>
<div id="fruit" role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="fruit-list" aria-label="Fruit" tabindex="0" onclick="const list = document.getElementById('fruit-list'); list.hidden = !list.hidden; this.setAttribute('aria-expanded', String(!list.hidden))">Choose fruit</div>
<ul id="fruit-list" role="listbox" hidden>${["Apple", "Banana", "Cherry"].map((name) => `<li role="option" onclick="document.getElementById('fruit-state').textContent = '${name}'; document.getElementById('fruit').textContent = '${name}'; this.parentElement.hidden = true">${name}</li>`).join("")}</ul>
<label>Date <input id="date" readonly placeholder="Pick a date" onclick="document.getElementById('calendar').hidden = false"></label>
<div id="calendar" role="dialog" aria-label="Calendar" hidden><table role="grid"><tr>${[19, 20, 21].map((day) => `<td><button onclick="document.getElementById('date').value = '2026-11-${day}'; document.getElementById('calendar').hidden = true">${day}</button></td>`).join("")}</tr></table></div>
<div id="editor" contenteditable="true" role="textbox" aria-label="Editor" aria-multiline="true" style="min-height:40px;border:1px solid"></div>
<iframe title="Rich editor" srcdoc="<body contenteditable=&quot;true&quot; style=&quot;min-height:40px&quot;></body>"></iframe>`,
      ),
    },
    "/consent/en": {
      html: EDGE_HTML(
        "Consent EN",
        `<p id="consent-state">pending</p><div id="cookie-notice" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:16px">We use cookies to improve the site. <button onclick="document.getElementById('consent-state').textContent = 'rejected'; this.parentElement.remove()">Reject all</button> <button onclick="document.getElementById('consent-state').textContent = 'accepted'; this.parentElement.remove()">Accept all</button></div>`,
      ),
    },
    "/consent/tr": {
      html: EDGE_HTML(
        "Consent TR",
        `<p id="consent-state">pending</p><div class="cerez-bar" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:16px">Sitemizde çerezler kullanılmaktadır. <button onclick="document.getElementById('consent-state').textContent = 'rejected'; this.parentElement.remove()">Reddet</button> <button onclick="document.getElementById('consent-state').textContent = 'accepted'; this.parentElement.remove()">Tümünü kabul et</button></div>`,
      ),
    },
    "/consent/frame": {
      html: EDGE_HTML(
        "Consent Frame",
        `<p id="consent-state">pending</p><iframe title="Privacy" src="/consent/cmp-frame" style="position:fixed;bottom:0;width:100%;height:120px;border:0"></iframe>`,
      ),
    },
    "/consent/cmp-frame": {
      html: EDGE_HTML(
        "CMP",
        `<div id="cmp-box">We and our partners use cookies. <button onclick="parent.document.getElementById('consent-state').textContent = 'rejected'">Manage options</button> <button onclick="parent.document.getElementById('consent-state').textContent = 'accepted'; this.parentElement.remove()">Agree</button></div>`,
      ),
    },
    "/consent/delayed": {
      html: EDGE_HTML(
        "Consent Delayed",
        `<p id="consent-state">pending</p><script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", '<div id="consent-banner" style="position:fixed;bottom:0;left:0;right:0;background:#eee;padding:16px">This site uses cookies. <button onclick="document.getElementById(\\'consent-state\\').textContent = \\'accepted\\'; this.parentElement.remove()">OK</button></div>'), 800);</script>`,
      ),
    },
    "/notice": {
      html: EDGE_HTML(
        "Notification Message",
        `<div id="flash" class="flash notice" data-alert>Action successful <a href="#" class="close" aria-label="Close message">×</a></div><h3>Notification Message</h3>
<script>document.querySelector(".close").addEventListener("click", (event) => { event.preventDefault(); const box = document.getElementById("flash"); const started = performance.now(); const step = () => { const done = (performance.now() - started) / 400; if (done >= 1) { box.remove(); return; } box.style.opacity = String(1 - done); setTimeout(step, 13); }; step(); });</script>`,
      ),
    },
    "/hover-menu": {
      html: EDGE_HTML(
        "Hover Menu",
        `<style>#submenu{display:none}#menu:hover #submenu{display:block}</style><nav id="menu"><span id="menu-label">Products</span><ul id="submenu"><li><a href="#lamps">Lamps</a></li><li><a href="#desks">Desks</a></li><li><a href="#chairs">Chairs</a></li></ul></nav>`,
      ),
    },
    "/modal/text-close": {
      html: EDGE_HTML(
        "Entry Ad",
        `<style>#modal{position:fixed;inset:0}#modal .underlay{position:absolute;inset:0;background:rgba(0,0,0,.5);cursor:pointer}#modal .modal{position:absolute;inset:0;margin:auto;width:400px;height:240px;background:#f0f1f2}</style><p id="modal-state">open</p>
<div id="modal"><div class="underlay"></div><div class="modal"><div class="modal-title"><h3>This is a modal window</h3></div><div class="modal-body"><p>It is used to ask for your e-mail address.</p></div><div class="modal-footer"><p>Close</p></div></div></div>
<script>const dismissed = () => { document.getElementById("modal").style.display = "none"; document.getElementById("modal-state").textContent = "closed by footer"; }; document.querySelector(".modal-footer").addEventListener("click", dismissed);</script>`,
      ),
    },
    "/modal/escape": {
      html: EDGE_HTML(
        "Escape Modal",
        `<p id="modal-state">open</p><div id="promo" role="dialog" aria-modal="true" style="position:fixed;top:20%;left:20%;background:#fff;padding:20px">Get 10% off your first order <button onclick="document.getElementById('modal-state').textContent = 'SUBSCRIBED'">Subscribe</button></div>
<script>addEventListener("keydown", (event) => { if (event.key !== "Escape") return; document.getElementById("promo").remove(); document.getElementById("modal-state").textContent = "closed by escape"; });</script>`,
      ),
    },
    "/modal/backdrop": {
      html: EDGE_HTML(
        "Backdrop Modal",
        `<p id="modal-state">open</p><div id="shade" style="position:fixed;inset:0;background:rgba(0,0,0,.5)" onclick="this.remove(); document.getElementById('modal-state').textContent = 'closed by backdrop'"><div class="popup-box" style="position:absolute;top:30%;left:30%;width:300px;height:150px;background:#fff" onclick="event.stopPropagation()">Special offer <button onclick="document.getElementById('modal-state').textContent = 'BOUGHT'">Buy now</button></div></div>`,
      ),
    },
    "/modal/stuck": {
      html: EDGE_HTML(
        "Stuck Modal",
        `<p id="modal-state">open</p><div role="dialog" aria-modal="true" style="position:fixed;inset:20%;background:#fff;padding:20px">Confirm your order? <button onclick="document.getElementById('modal-state').textContent = 'ORDER PLACED'">Confirm order</button></div>`,
      ),
    },
    "/text": {
      html: EDGE_HTML(
        "Text",
        `<p id="sample">Çağrı İstanbul’da ığdır şöförü 👩🏽‍💻 🏳️‍🌈 שלום עולם مرحبا</p><label>Note <input id="note"></label><label>Body <textarea id="body"></textarea></label><button aria-label="Gönder 👍">Gönder 👍</button>`,
      ),
    },
  } satisfies Record<string, EdgePage>),
);

function edgeAuthResponse(request: Request, realm: string, pathname: string) {
  const expected = `Basic ${Buffer.from(`${edgeAuth.username}:${edgeAuth.password}`).toString("base64")}`;
  if (!edgeAuth.password || request.headers.get("authorization") !== expected)
    return new Response(EDGE_HTML("Unauthorized", "<h1>401 Unauthorized</h1>"), {
      status: 401,
      headers: { "www-authenticate": `Basic realm="${realm}"`, "content-type": "text/html" },
    });
  if (pathname.endsWith("/api")) return Response.json({ realm, ok: true });
  return new Response(
    EDGE_HTML(
      "Auth OK",
      `<p id="auth-state">authorized ${realm}</p><p id="api-state">pending</p><script>fetch("api").then((r) => r.json()).then((d) => { document.getElementById("api-state").textContent = "api " + d.realm; }, () => { document.getElementById("api-state").textContent = "api failed"; });</script>`,
    ),
    { headers: { "content-type": "text/html" } },
  );
}

let stalled = 0;

export const stallRequests = () => stalled;

export function edgeCaseResponse(request: Request, url: URL) {
  const { pathname } = url;
  if (pathname === "/zstd") {
    const body = Buffer.from(
      JSON.stringify({
        ok: true,
        items: Array.from({ length: 20 }, (_value, index) => `item-${index}`),
      }),
    );
    if (/zstd/.test(request.headers.get("accept-encoding") ?? ""))
      return new Response(zstdCompressSync(body), {
        headers: { "content-type": "application/json", "content-encoding": "zstd" },
      });
    return new Response(body, { headers: { "content-type": "application/json" } });
  }
  if (pathname === "/stall") {
    stalled += 1;
    return openStream("<!doctype html><title>Stall</title>", { "content-type": "text/html" });
  }
  const realm = /^\/(auth-[a-z])\//.exec(pathname)?.[1];
  if (realm) return edgeAuthResponse(request, realm, pathname);
  if (pathname === "/app/private")
    return new Response(null, {
      status: 302,
      headers: { location: "/login?next=%2Fapp%2Fprivate" },
    });
  const page = EDGE_PAGES.get(pathname);
  if (!page) return undefined;
  return new Response(page.html, {
    status: page.status ?? 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function openStream(first: string, headers: HeadersInit) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(first));
      },
    }),
    { headers },
  );
}
