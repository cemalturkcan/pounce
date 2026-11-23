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
    "/challenge/recaptcha-late": {
      html: EDGE_HTML(
        "Login",
        `<form><input name="user"><div class="g-recaptcha" data-sitekey="fixture"></div></form><script>setTimeout(() => { document.querySelector(".g-recaptcha").innerHTML = '<iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture&amp;size=normal" width="304" height="78"></iframe><textarea name="g-recaptcha-response" style="display:none"></textarea>'; }, 1500);</script>`,
      ),
    },
    "/challenge/recaptcha-hidden": {
      html: EDGE_HTML(
        "Shop",
        `<p id="status">Shop</p><button id="buy" onclick="document.getElementById('status').textContent = 'Added'">Buy</button><a id="to-details" href="#details">Details</a><button id="sort" onclick="history.replaceState(null, '', '?sort=price')">Sort</button><div style="display:none"><div class="g-recaptcha" data-sitekey="fixture"></div></div>`,
      ),
    },
    "/challenge/recaptcha-route": {
      html: EDGE_HTML(
        "Shop",
        `<p>Shop</p><div style="display:none"><div class="g-recaptcha" data-sitekey="fixture"></div></div><button id="to-login" onclick="toLogin()">Sign in</button><script>function toLogin() { history.pushState(null, "", "/challenge/recaptcha-route/login"); document.body.innerHTML = '<form><input name="user"><div class="g-recaptcha" data-sitekey="fixture"></div></form>'; setTimeout(() => { document.querySelector(".g-recaptcha").innerHTML = '<iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture&amp;size=normal" width="304" height="78"></iframe>'; }, 1500); }</script>`,
      ),
    },
    "/challenge/recaptcha-badge-hidden": {
      html: EDGE_HTML(
        "Contact",
        `<style>.grecaptcha-badge { visibility: hidden }</style><form><input name="user"><button class="g-recaptcha" data-sitekey="fixture" data-callback="send">Send</button></form><div class="grecaptcha-badge"><iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture&amp;size=invisible" width="256" height="60"></iframe></div>`,
      ),
    },
    "/challenge/recaptcha-modal": {
      html: EDGE_HTML(
        "Shop",
        `<p>Shop</p><div id="login" style="display:none"><div class="g-recaptcha" data-sitekey="fixture"><iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture&amp;size=normal" width="304" height="78"></iframe></div></div>`,
      ),
    },
    "/challenge/recaptcha-solve": {
      html: EDGE_HTML(
        "Login",
        `<form><input name="user"><div class="g-recaptcha" data-sitekey="fixture"><iframe title="reCAPTCHA" src="/recaptcha/api2/anchor?k=fixture&amp;size=normal" width="304" height="78"></iframe><textarea name="g-recaptcha-response" style="display:none"></textarea></div></form><button id="solve" onclick="document.querySelector('[name=g-recaptcha-response]').value = 'fixture-token'">Solve</button>`,
      ),
    },
    "/challenge/recaptcha-checkbox": {
      html: EDGE_HTML(
        "Login",
        `<form><input name="user"><div class="g-recaptcha" data-sitekey="fixture"><iframe title="reCAPTCHA" src="/recaptcha/enterprise/anchor?k=fixture&amp;size=normal" width="304" height="78"></iframe><textarea name="g-recaptcha-response" style="display:none"></textarea></div></form>`,
      ),
    },
    "/recaptcha/enterprise/anchor": {
      html: EDGE_HTML(
        "reCAPTCHA",
        `<label><input type="checkbox" onclick="setTimeout(() => { parent.document.querySelector('[name=g-recaptcha-response]').value = 'fixture-token'; }, 800)"> I'm not a robot</label>`,
      ),
    },
    "/challenge/turnstile-shadow": {
      html: EDGE_HTML(
        "Contact",
        `<div id="widget"></div><input type="hidden" name="cf-turnstile-response" value=""><script>const host = document.getElementById("widget"); host.attachShadow({ mode: "closed" }).innerHTML = '<iframe title="Widget containing a Cloudflare security challenge" src="/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal" width="300" height="65"></iframe>';</script>`,
      ),
    },
    "/challenge/turnstile-shadow-solved": {
      html: EDGE_HTML(
        "Contact",
        `<div id="widget"></div><input type="hidden" name="cf-turnstile-response" value="fixture-token"><script>const host = document.getElementById("widget"); host.attachShadow({ mode: "closed" }).innerHTML = '<iframe title="Widget containing a Cloudflare security challenge" src="/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal" width="300" height="65"></iframe>';</script>`,
      ),
    },
    "/challenge/turnstile-late": {
      html: EDGE_HTML(
        "Contact",
        `<form><div id="cf-turnstile" class="cf-turnstile" data-sitekey="fixture" style="width:300px;height:65px"></div><button type="submit">Send</button></form><script>addEventListener("load", () => setTimeout(() => { const wrapper = document.createElement("div"); const host = document.createElement("div"); wrapper.append(host); wrapper.insertAdjacentHTML("beforeend", '<input type="hidden" name="cf-turnstile-response">'); document.querySelector(".cf-turnstile").append(wrapper); const root = host.attachShadow({ mode: "closed" }); root.innerHTML = '<iframe src="/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal" style="border:none;overflow:hidden;width:0px;height:0px;position:absolute;visibility:hidden"></iframe>'; setTimeout(() => { root.querySelector("iframe").style.cssText = "border:none;overflow:hidden;width:300px;height:65px"; }, 700); }, 300));</script>`,
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
    "/challenge/cloudflare-wait": {
      status: 403,
      html: EDGE_HTML(
        "Just a moment...",
        `<div id="challenge-running"><p>Checking your browser before accessing the site.</p></div><script>setTimeout(() => location.replace("/challenge/cleared"), 2000);</script>`,
      ),
    },
    "/challenge/cloudflare-stuck": {
      status: 503,
      html: EDGE_HTML(
        "Just a moment...",
        `<div id="challenge-running"><p>Checking your browser before accessing the site.</p></div>`,
      ),
    },
    "/challenge/cloudflare-translated": {
      status: 503,
      html: EDGE_HTML(
        "Bir dakika lütfen...",
        `<div class="main-wrapper"><h1>127.0.0.1</h1><p>Bağlantınızın güvenliği kontrol ediliyor.</p></div><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=1"></script><script>setTimeout(() => location.replace("/challenge/cleared"), 2000);</script>`,
      ),
    },
    "/challenge/cleared": {
      html: EDGE_HTML("Shop Home", `<h1>Welcome back</h1>`),
    },
    "/challenge/perimeterx": {
      status: 403,
      html: EDGE_HTML(
        "Access to this page has been denied",
        `<h1>Before we continue...</h1><p>Press &amp; Hold to confirm you are a human (and not a bot).</p><div id="px-captcha" style="width:300px;height:60px"></div>`,
      ),
    },
    "/challenge/perimeterx-old": {
      html: EDGE_HTML(
        "Access to this page has been denied.",
        `<h1>Please verify you are a human</h1><div id="px-captcha"></div><p>Access to this page has been denied because we believe you are using automation tools to browse the website.</p><p>This may happen as a result of the following:</p><ul><li>Javascript is disabled or blocked by an extension (ad blockers for example)</li><li>Your browser does not support cookies</li></ul><p>Please make sure that Javascript and cookies are enabled on your browser and that you are not blocking them from loading.</p><p>Reference ID: #1a2b3c4d</p><script src="/PXabc123/init.js"></script>`,
      ),
    },
    "/challenge/datadome": {
      status: 403,
      html: EDGE_HTML(
        "shop.example",
        `<div id="ddv1-captcha-container" style="height:400px"></div>`,
      ),
    },
    "/challenge/akamai": {
      status: 403,
      html: EDGE_HTML(
        "Access Denied",
        `<h1>Access Denied</h1>You don't have permission to access "http&#58;&#47;&#47;shop&#46;example&#47;" on this server.<p>Reference&#32;&#35;18&#46;6b2d1402&#46;1700000000&#46;1a2b3c</p>`,
      ),
    },
    "/challenge/imperva": {
      html: EDGE_HTML(
        "Shop",
        `<p>Request unsuccessful. Incapsula incident ID: 0-123456789</p><script src="/_Incapsula_Resource?SWJIYLWA=fixture"></script>`,
      ),
    },
    "/challenge/aws-waf": {
      status: 405,
      html: EDGE_HTML(
        "Human Verification",
        `<div id="captcha-container"><awswaf-captcha style="display:block;width:320px;height:200px"></awswaf-captcha></div>`,
      ),
    },
    "/challenge/verify": {
      html: EDGE_HTML("One more step", `<h1>Please verify you are a human</h1>`),
    },
    "/challenge/bot-article": {
      html: EDGE_HTML(
        "Bot detection 101",
        `<h1>Bot detection explained</h1><p>How sites tell bots from people.</p>`,
      ),
    },
    "/challenge/please-wait": {
      html: EDGE_HTML("Please wait", `<div id="app">Loading your dashboard</div>`),
    },
    "/challenge/forbidden": {
      status: 403,
      html: EDGE_HTML(
        "403 Forbidden",
        `<h1>Forbidden</h1><p>You don't have access to this repository.</p>`,
      ),
    },
    "/challenge/plain-error": {
      status: 403,
      html: EDGE_HTML(
        "Members",
        `<h1>Members area</h1><p>Your plan does not include this report.</p>`,
      ),
    },
    "/page-globals": {
      html: EDGE_HTML(
        "Page Globals",
        `<button id="rerender">Rerender me</button><p class="item">one</p><script>window.n = 1; window.rerender = function () { return "rerendered"; };</script>`,
      ),
    },
    "/frame-hash": {
      html: EDGE_HTML(
        "Frame Hash",
        `<p>outer</p><iframe title="Inner" src="/frame-hash/inner"></iframe>`,
      ),
    },
    "/frame-hash/inner": {
      html: EDGE_HTML("Frame Hash Inner", `<a id="ihash" href="#x">ihash</a><p id="x">x</p>`),
    },
    "/slow-style": {
      html: `<!doctype html>\n<html><head><meta charset="utf-8"><title>Slow Style</title><link rel="stylesheet" href="/files/slow-style.css"></head><body style="margin:0"></body></html>`,
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
        `<p id="opener-state">waiting</p><button id="open-popup" onclick="window.open('/popup-child', 'oauth', 'width=420,height=420')">Sign in with provider</button><button id="open-tab" onclick="window.open('/popup-child')">Open the provider in a tab</button><button id="open-slow" onclick="window.open('/popup-slow')">Open a slow page in a tab</button><button id="open-closing" onclick="window.open('/popup-closing', '_blank', 'width=420,height=420')">Open a closing popup</button><button id="open-closing-soon" onclick="window.open('/popup-closing-soon', '_blank', 'width=420,height=420')">Open a popup that closes soon</button><button id="open-closing-hover" onclick="window.open('/popup-closing-hover', '_blank', 'width=420,height=420')">Open a popup that closes on hover</button>`,
      ),
    },
    "/popup-child": {
      html: EDGE_HTML(
        "Provider",
        `<button id="finish" onclick="window.opener && (window.opener.document.getElementById('opener-state').textContent = 'signed in'); window.close()">Allow</button>`,
      ),
    },
    "/popup-closing": {
      html: EDGE_HTML(
        "Closing Popup",
        `<button id="close-on-press" onmousedown="window.close()">Close on press</button><input id="close-on-key" onkeydown="window.close()"><input id="close-on-check" type="checkbox" onclick="window.close()"><input id="close-on-input" oninput="window.close()"><div id="close-on-wheel" onwheel="window.close()" style="height:120px;overflow:auto"><div style="height:600px">Close on wheel</div></div>`,
      ),
    },
    "/popup-closing-hover": {
      html: EDGE_HTML(
        "Closing Hover Popup",
        `<button id="close-on-hover" onmouseover="window.close()">Close on hover</button>`,
      ),
    },
    "/popup-closing-soon": {
      html: EDGE_HTML(
        "Closing Soon Popup",
        `<button id="far" style="position:fixed;right:16px;bottom:16px">Far away</button><script>addEventListener("mousemove", () => setTimeout(() => window.close(), 50), { once: true });</script>`,
      ),
    },
    "/popup-busy-opener": {
      html: EDGE_HTML(
        "Busy Popup Opener",
        `<button id="open-busy" onclick="window.open('/popup-busy')">Open a busy page in a tab</button>`,
      ),
    },
    "/popup-busy": {
      html: EDGE_HTML(
        "Busy Popup",
        `<p>busy</p><script>const until = Date.now() + 1500; while (Date.now() < until);</script>`,
      ),
    },
    "/popup-onload": {
      html: EDGE_HTML(
        "Popup On Load",
        `<p>promo</p><script>window.open("/popup-child", "promo");</script>`,
      ),
    },
    "/popup-self-close": {
      html: EDGE_HTML(
        "Popup That Closes",
        `<p>promo</p><script>let left = 40; const timer = setInterval(() => { window.open("/popup-gone", "_blank")?.close(); left -= 1; if (left === 0) clearInterval(timer); }, 25);</script>`,
      ),
    },
    "/popup-gone": {
      html: EDGE_HTML("Gone", `<script>window.close();</script>`),
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
    "/label-switch": {
      html: EDGE_HTML(
        "Billing",
        `<label for="basic-toggle" class="switch" style="position:relative;display:inline-block;width:40px;height:20px"><input type="checkbox" id="basic-toggle" style="position:absolute;left:20px;top:10px;width:1px;height:1px;margin:0;opacity:0.01"><div class="thumb" style="position:absolute;inset:0;z-index:1;background:#888"></div></label><span>Billed yearly</span>`,
      ),
    },
    "/label-overlay": {
      html: EDGE_HTML(
        "Sign in",
        `<label id="remember"><input type="checkbox" id="remember-me"> Remember me</label><div id="loading" style="position:fixed;inset:0;background:rgba(0,0,0,0.2)"></div>`,
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
    "/snapshot/landmarks": {
      html: EDGE_HTML(
        "Landmarks",
        `<header><label>Search <input type="search"></label></header>
<nav aria-label="Site">${Array.from({ length: 30 }, (_value, index) => `<a href="/section-${index}">Section ${index}</a>`).join(" ")}</nav>
<main><h1>Lamps</h1><nav aria-label="Breadcrumb"><a href="/">Home</a> <a href="/lamps">Lamps</a></nav><p id="cart">empty</p><button onclick="document.getElementById('cart').textContent = 'one lamp'">Add to cart</button>
${Array.from({ length: 60 }, (_value, index) => `<p><a href="/related-${index}">Related lamp ${index}</a></p>`).join("")}<button>Checkout</button></main>
<footer><a href="/imprint">Imprint</a></footer>`,
      ),
    },
    "/snapshot/dialog": {
      html: EDGE_HTML(
        "Dialog",
        `<main><h1>Account</h1><button>Delete account</button></main><dialog id="confirm"><p>Leave without saving?</p><button>Stay</button></dialog><script>document.getElementById("confirm").showModal();</script>`,
      ),
    },
    "/dialogs": {
      html: EDGE_HTML(
        "Dialogs",
        `<p id="state">idle</p>
<button id="alert" onclick="alert('Careful now'); say('alert closed')">Alert</button>
<button id="confirm" onclick="say(confirm('Delete the draft?') ? 'deleted' : 'kept')">Confirm</button>
<button id="prompt" onclick="say('name: ' + prompt('Your name?', 'guest'))">Prompt</button>
<button id="later" onclick="setTimeout(() => { alert('Saved later'); say('later closed'); }, 50)">Later</button>
<button id="later-confirm" onclick="setTimeout(() => say(confirm('Delete the draft?') ? 'deleted' : 'kept'), 1500)">Confirm later</button>
<button id="chain" onclick="alert('First notice'); alert('Second notice'); say('chain closed')">Chain</button>
<button id="hover-alert" onmouseenter="alert('Hovered')">Hover alert</button>
<input id="key-alert" aria-label="Key alert" onkeydown="alert('Key ' + event.key)">
<input id="input-alert" aria-label="Input alert" oninput="alert('Typed')">
<select id="select-alert" aria-label="Select alert" onchange="alert('Picked')"><option>One</option><option>Two</option></select>
<input id="plain-field" aria-label="Plain field">
<button id="submit-alert" onclick="alert('Submitted')">Submit alert</button>
<script>function say(text) { document.getElementById("state").textContent = text; }</script>`,
      ),
    },
    "/dialogs/form": {
      html: EDGE_HTML(
        "Sign up",
        `<form id="signup" onsubmit="event.preventDefault(); submits += 1; document.getElementById('submits').textContent = submits + ' submits'">
<input id="name" aria-label="Name">
<input id="email" aria-label="Email" oninput="if (!warned) { warned = true; alert('Check the email'); }">
<input id="city" aria-label="City">
<button id="send">Send</button>
</form>
<p id="submits">0 submits</p>
<script>let submits = 0; let warned = false;</script>`,
      ),
    },
    "/dialogs/on-load": {
      html: EDGE_HTML(
        "Welcome",
        `<p>Before</p><script>alert("Welcome back")</script><p id="after">After the alert</p>`,
      ),
    },
    "/snapshot/rerender": {
      html: EDGE_HTML(
        "Rerender",
        `<p id="state">idle</p><div id="app"></div>
<script>
const app = document.getElementById("app");
const say = (text) => { document.getElementById("state").textContent = text; };
const view = (withSave) => '<h1>Editor</h1>' + (withSave ? '<button data-action="save">Save</button>' : '') + '<button data-action="render">Re-render</button><button data-action="drop">Remove save</button>';
const render = (withSave = true) => { app.innerHTML = view(withSave); };
app.addEventListener("click", (event) => {
  const action = event.target.dataset.action;
  if (action === "save") say("saved");
  if (action === "render") render();
  if (action === "drop") render(false);
});
render();
</script>`,
      ),
    },
    "/snapshot/cart": {
      html: EDGE_HTML(
        "Cart",
        `<main><h1>Sepet</h1><p id="state">full</p>
<table><tbody>
<tr><td>Silikon Kılıf</td><td>249 TL</td><td><button onclick="say('removed Silikon Kılıf')">Sil</button></td></tr>
<tr><td>Ekran Koruyucu</td><td>99 TL</td><td><button onclick="say('removed Ekran Koruyucu')">Sil</button></td></tr>
</tbody></table>
<ul><li>Silikon Kapak 149 TL <a href="#kapak">Detay</a></li></ul>
<button onclick="say('emptied')">Sepeti sil</button>
<p>Silinen ürünler burada görünmez.</p></main>
<script>function say(text) { document.getElementById("state").textContent = text; }</script>`,
      ),
    },
    "/snapshot/cart-twins": {
      html: EDGE_HTML(
        "Cart twins",
        `<main><p id="state">full</p>
<table><tbody>
<tr><td>Kılıf</td><td>100 TL</td><td><button onclick="say('first')">Sil</button></td></tr>
<tr><td>Kılıf</td><td>100 TL</td><td><button onclick="say('second')">Sil</button></td></tr>
</tbody></table></main>
<script>function say(text) { document.getElementById("state").textContent = text; }</script>`,
      ),
    },
    "/snapshot/cart-rows": {
      html: EDGE_HTML(
        "Cart rows",
        `<main><h1>Sepet</h1><p id="state"></p><table><tbody id="rows"></tbody></table></main>
<script>
const params = new URLSearchParams(location.search);
const rows = (params.get("rows") ?? "").split(",").filter(Boolean).map((row) => row.split(":"));
const body = document.getElementById("rows");
for (const [id, text] of rows) {
  const row = body.insertRow();
  const label = row.insertCell();
  if (text && params.has("links")) label.innerHTML = '<a href="#' + id + '">' + text + "</a>";
  else if (text) label.textContent = text;
  const button = document.createElement("button");
  button.textContent = "Sil";
  button.onclick = () => {
    params.set("rows", rows.filter(([other]) => other !== id).map((each) => each.join(":")).join(","));
    location.search = params.toString();
  };
  row.insertCell().append(button);
}
document.getElementById("state").textContent = "rows: " + (rows.map(([id]) => id).join(",") || "none");
</script>`,
      ),
    },
    "/snapshot/frames": {
      html: EDGE_HTML(
        "Frames",
        `<p id="state">none</p><div id="frames"></div>
<script>
for (const name of (new URLSearchParams(location.search).get("frames") ?? "").split(",").filter(Boolean)) {
  const frame = document.createElement("iframe");
  frame.name = name;
  frame.src = "/snapshot/frame-button?name=" + name;
  document.getElementById("frames").append(frame);
}
</script>`,
      ),
    },
    "/snapshot/frame-button": {
      html: EDGE_HTML(
        "Frame button",
        `<button onclick="parent.document.getElementById('state').textContent = 'paid in ' + new URLSearchParams(location.search).get('name')">Pay</button>`,
      ),
    },
    "/snapshot/list": {
      html: EDGE_HTML(
        "List",
        `<ul id="list"><li><a href="/fruit">Apple</a></li></ul><button onclick="document.getElementById('list').insertAdjacentHTML('beforeend', '<li><a href=&quot;/fruit&quot;>Apple</a></li>')">Add apple</button>`,
      ),
    },
    "/snapshot/order": {
      html: EDGE_HTML(
        "Order",
        `<main><h1 id="title"></h1><p id="state">open</p><div id="actions"></div><a href="#" id="next">Sonraki sipariş</a></main>
<script>
const params = new URLSearchParams(location.search);
let order = params.get("id") ?? "A";
const say = (text) => { document.getElementById("state").textContent = text; };
const actions = document.getElementById("actions");
const render = () => {
  document.getElementById("title").textContent = "Sipariş " + order;
  if (actions.firstChild && !params.has("render")) return;
  actions.innerHTML = "<button>İptal et</button>";
  actions.firstChild.onclick = () => say("cancelled " + order);
};
document.getElementById("next").onclick = (event) => {
  event.preventDefault();
  order = "B";
  params.set("id", order);
  history.pushState(null, "", "?" + params);
  render();
};
render();
</script>`,
      ),
    },
    "/snapshot/rows": {
      html: EDGE_HTML(
        "Rows",
        `<main><p id="state">none</p><ul id="rows"></ul></main>
<script>
const list = document.getElementById("rows");
let items = ["Kılıf A", "Kılıf B", "Kılıf C"];
const remove = (index) => {
  document.getElementById("state").textContent = "deleted " + items[index];
  items = items.filter((_, other) => other !== index);
  render();
};
const build = () => {
  list.innerHTML = "";
  for (const index of [0, 1]) {
    const row = document.createElement("li");
    row.innerHTML = "<span></span> <button>Sil</button>";
    row.querySelector("button").onclick = () => remove(index);
    list.append(row);
  }
};
const render = () => {
  build();
  for (const [index, row] of [...list.children].entries()) row.querySelector("span").textContent = items[index];
};
render();
</script>`,
      ),
    },
    "/snapshot/deep-rows": {
      html: EDGE_HTML(
        "Deep rows",
        `<p id="state">none</p><ul>
<li><button onclick="say('deleted Kılıf A')">Sil</button><table><tr><td>Kılıf A</td></tr></table></li>
<li><button onclick="say('deleted Kılıf B')">Sil</button><table><tr><td>Kılıf B</td></tr></table></li>
</ul>
<script>function say(text) { document.getElementById("state").textContent = text; }</script>`,
      ),
    },
    "/snapshot/quantity": {
      html: EDGE_HTML(
        "Quantity",
        `<main><table><tbody><tr><td>Kılıf</td><td id="state">1 adet</td><td><button onclick="count += 1; document.getElementById('state').textContent = count + ' adet'">Artır</button></td></tr></tbody></table>
<p id="follows">0 follows</p><button onclick="follows += 1; document.getElementById('follows').textContent = follows + ' follows'; this.textContent = this.textContent === 'Takip et' ? 'Takibi bırak' : 'Takip et'">Takip et</button></main>
<script>let count = 1; let follows = 0;</script>`,
      ),
    },
    "/snapshot/frame-swap": {
      html: EDGE_HTML(
        "Frame swap",
        `<p id="state">none</p><iframe id="frame" src="/snapshot/frame-button?name=one"></iframe><button onclick="document.getElementById('frame').src = '/snapshot/frame-button?name=two'">Değiştir</button>`,
      ),
    },
    "/snapshot/srcdoc": {
      html: EDGE_HTML(
        "Srcdoc",
        `<p id="state">none</p><button id="pay"></button><iframe id="frame"></iframe>
<script>
const order = Number(sessionStorage.getItem("order") ?? 0) + 1;
sessionStorage.setItem("order", String(order));
window.pay = () => { document.getElementById("state").textContent = "paid " + order; };
document.getElementById("pay").textContent = "Pay order " + order;
document.getElementById("pay").onclick = pay;
document.getElementById("frame").srcdoc = "<p>Sipariş " + order + "</p><button onclick='parent.pay()'>Pay</button>";
</script>`,
      ),
    },
    "/snapshot/hash-order": {
      html: EDGE_HTML(
        "Hash order",
        `<main><h1 id="title"></h1><p id="state">open</p><button id="cancel">İptal et</button><a href="#/order/B">Sonraki sipariş</a></main>
<script>
const show = () => {
  const order = location.hash.split("/")[2] ?? "A";
  document.getElementById("title").textContent = "Sipariş " + order;
  document.getElementById("cancel").onclick = () => { document.getElementById("state").textContent = "cancelled " + order; };
};
addEventListener("hashchange", show);
show();
</script>`,
      ),
    },
    "/snapshot/frame-order": {
      html: EDGE_HTML(
        "Frame order",
        `<p id="state">open</p><iframe src="/snapshot/frame-order-inner?id=A"></iframe>`,
      ),
    },
    "/snapshot/frame-order-inner": {
      html: EDGE_HTML(
        "Frame order inner",
        `<h1 id="title"></h1><button id="cancel">İptal et</button><a href="#" id="next">Sonraki sipariş</a>
<script>
let order = new URLSearchParams(location.search).get("id") ?? "A";
const show = () => {
  document.getElementById("title").textContent = "Sipariş " + order;
  document.getElementById("cancel").onclick = () => { parent.document.getElementById("state").textContent = "cancelled " + order; };
};
document.getElementById("next").onclick = (event) => {
  event.preventDefault();
  order = "B";
  history.pushState(null, "", "?id=B");
  show();
};
show();
</script>`,
      ),
    },
    "/snapshot/cards": {
      html: EDGE_HTML(
        "Cards",
        `<main><p id="state">none</p><div id="cards"></div><button id="filter">Sadece B ve C</button></main>
<script>
let items = ["Ürün A", "Ürün B", "Ürün C"];
const cards = document.getElementById("cards");
const render = () => {
  cards.innerHTML = items.map((item) => "<div><h3>" + item + "</h3><button>Sepete ekle</button></div>").join("");
  [...cards.children].forEach((card, index) => {
    card.querySelector("button").onclick = () => { document.getElementById("state").textContent = "added " + items[index]; };
  });
};
document.getElementById("filter").onclick = () => { items = ["Ürün B", "Ürün C"]; render(); };
render();
</script>`,
      ),
    },
    "/snapshot/signup": {
      html: EDGE_HTML(
        "Signup",
        `<main><p id="state">none</p><form aria-label="Kayıt" onsubmit="event.preventDefault(); document.getElementById('state').textContent = 'submitted'"><label>E-posta <input id="email" type="email"></label><p id="valid"></p><label>Şifre <input id="password" type="password"></label><p id="strength"></p><button>Kayıt ol</button></form></main>
<script>
const email = document.getElementById("email");
const password = document.getElementById("password");
email.oninput = () => { document.getElementById("valid").textContent = email.value.includes("@") ? "" : "Geçerli bir e-posta girin"; };
password.oninput = () => { document.getElementById("strength").textContent = "Şifre gücü: " + (password.value.length > 8 ? "güçlü" : "zayıf"); };
</script>`,
      ),
    },
    "/snapshot/comment": {
      html: EDGE_HTML(
        "Comment",
        `<main><p id="state">none</p><form aria-label="Yorum" onsubmit="event.preventDefault(); document.getElementById('state').textContent = 'sent'"><textarea aria-label="Yorum metni" id="text"></textarea><span id="count">0/280</span><button>Gönder</button></form></main>
<script>
const text = document.getElementById("text");
text.oninput = () => { document.getElementById("count").textContent = text.value.length + "/280"; };
</script>`,
      ),
    },
    "/snapshot/cart-dialog": {
      html: EDGE_HTML(
        "Cart dialog",
        `<main><p id="state">none</p><dialog id="cart"><h2>Sepet</h2><ul><li>Kılıf <span id="count">1</span> adet <button id="more">Artır</button></li></ul><p>Toplam <span id="total">249</span> TL</p><button onclick="document.getElementById('state').textContent = 'checkout'">Ödemeye geç</button></dialog></main>
<script>
document.getElementById("more").onclick = () => {
  const count = document.getElementById("count");
  count.textContent = String(Number(count.textContent) + 1);
  document.getElementById("total").textContent = String(249 * Number(count.textContent));
};
document.getElementById("cart").showModal();
</script>`,
      ),
    },
    "/snapshot/otp": {
      html: EDGE_HTML(
        "OTP",
        `<main><dialog id="otp"><h2>Doğrulama</h2><form onsubmit="event.preventDefault(); document.getElementById('state').textContent = 'verified ' + document.getElementById('code').value"><label>Kod <input id="code"></label><button>Onayla</button></form><p>Kodu tekrar gönder <span id="left"></span></p><p id="state">none</p></dialog></main>
<script>
let left = 120;
const tick = () => { document.getElementById("left").textContent = "0:" + String(left).padStart(3, "0"); left -= 1; };
tick();
setInterval(tick, 200);
document.getElementById("otp").showModal();
</script>`,
      ),
    },
    "/snapshot/clock": {
      html: EDGE_HTML(
        "Clock",
        `<main><p id="state">none</p><ul><li>Flaş indirim, bitişe <span id="left"></span> <button onclick="document.getElementById('state').textContent = 'bought'">Sepete ekle</button></li></ul></main>
<script>
let left = 3600;
const tick = () => { document.getElementById("left").textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"); left -= 1; };
tick();
setInterval(tick, 200);
</script>`,
      ),
    },
    "/snapshot/replace-state": {
      html: EDGE_HTML(
        "Replace state",
        `<main><h1>Sipariş A</h1><p id="state">open</p><button onclick="history.replaceState({ at: Date.now() }, '', location.href)">Yenile</button></main>`,
      ),
    },
    "/snapshot/sending": {
      html: EDGE_HTML(
        "Sending",
        `<main><p id="state">sending</p><button id="sending">Gönderiliyor 0/5</button><button onclick="history.replaceState(null, '', (location.search || '?') + '&step=2')">Adım</button></main>
<script>
let sent = 0;
const timer = setInterval(() => {
  sent += 1;
  const button = document.getElementById("sending");
  if (sent < 5 && !location.search.includes("fixed")) button.textContent = "Gönderiliyor " + sent + "/5";
  if (sent < 5) return;
  clearInterval(timer);
  button.remove();
  document.getElementById("state").textContent = "sent";
}, 300);
</script>`,
      ),
    },
    "/snapshot/load-more": {
      html: EDGE_HTML(
        "Load more",
        `<main><p id="state">1 item</p><ul id="list"><li>Ürün 1</li></ul><button id="more">Daha fazla yükle</button></main>
<script>
const more = document.getElementById("more");
more.onclick = () => {
  more.hidden = true;
  setTimeout(() => {
    document.getElementById("list").insertAdjacentHTML("beforeend", "<li>Ürün 2</li>");
    document.getElementById("state").textContent = "2 items";
    more.hidden = false;
  }, 800);
};
</script>`,
      ),
    },
    "/snapshot/locked": {
      html: EDGE_HTML(
        "Locked",
        `<main><p id="state">none</p><button id="open" onclick="say('opened')">Aç</button><button onclick="hideFor('open', 'hidden')">Gizle</button><button id="press" onclick="say('pressed')">Basılı</button><button onclick="hideFor('press', 'pointerEvents')">Kilitle</button></main>
<script>
const say = (text) => { document.getElementById("state").textContent = text; };
const hideFor = (id, how) => {
  const element = document.getElementById(id);
  if (how === "hidden") element.hidden = true;
  else element.style.pointerEvents = "none";
  setTimeout(() => { element.hidden = false; element.style.pointerEvents = ""; }, 600);
};
</script>`,
      ),
    },
    "/snapshot/churn": {
      html: EDGE_HTML(
        "Churn",
        `<main><button>Sabit</button><div id="list"></div></main>
<script>
const draw = () => document.getElementById("list").replaceChildren(...Array.from({ length: 200 }, (_, index) => Object.assign(document.createElement("button"), { textContent: "Satır " + index })));
draw();
setInterval(draw, 150);
</script>`,
      ),
    },
    "/snapshot/redrawn-list": {
      html: EDGE_HTML(
        "Redrawn list",
        `<main><div id="list"></div></main>
<script>
const removed = [];
let round = 0;
window.redraw = () => {
  round += 1;
  for (const button of document.querySelectorAll("#list button")) removed.push(new WeakRef(button));
  document.getElementById("list").replaceChildren(...Array.from({ length: 300 }, (_, index) => Object.assign(document.createElement("button"), { textContent: "Öğe " + index + " " + round })));
};
window.removedAlive = () => removed.filter((button) => button.deref()).length;
redraw();
</script>`,
      ),
    },
    "/snapshot/many-buttons": {
      html: EDGE_HTML(
        "Many buttons",
        `<main><p id="state">none</p><button id="target">Hedef</button><div id="list"></div></main>
<script>
document.getElementById("list").replaceChildren(...Array.from({ length: 10000 }, (_, index) => Object.assign(document.createElement("button"), { textContent: "Düğme " + index })));
</script>`,
      ),
    },
    "/snapshot/follow": {
      html: EDGE_HTML(
        "Follow",
        `<main><p id="state">0 toggles</p><button id="follow">Takip et</button><a id="next" href="#devam" role="button">Devam</a><button onclick="document.getElementById('next').removeAttribute('role')">Rolü kaldır</button></main>
<script>
let toggles = 0;
document.getElementById("follow").onclick = (event) => {
  toggles += 1;
  event.target.textContent = event.target.textContent === "Takip et" ? "Takibi bırak" : "Takip et";
  document.getElementById("state").textContent = toggles + " toggles";
};
</script>`,
      ),
    },
    "/snapshot/frozen-frame": {
      html: EDGE_HTML(
        "Frozen frame",
        `<main><p id="state">none</p><button onclick="document.getElementById('state').textContent = 'clicked'">Ana</button><iframe id="frame" title="Reklam"></iframe></main>
<script>document.getElementById("frame").src = location.origin.replace("127.0.0.1", "localhost") + "/snapshot/frozen";</script>`,
      ),
    },
    "/snapshot/frozen": {
      html: EDGE_HTML(
        "Frozen",
        `<button>Reklam</button><script>setTimeout(() => { const start = Date.now(); while (Date.now() - start < 20000) {} }, 1500);</script>`,
      ),
    },
    "/snapshot/login": {
      html: EDGE_HTML(
        "Login",
        `<main><h1 id="site"></h1><form><label>Şifre <input type="password" id="password"></label></form></main>
<script>document.getElementById("site").textContent = "Site " + new URLSearchParams(location.search).get("site");</script>`,
      ),
    },
    "/text": {
      html: EDGE_HTML(
        "Text",
        `<p id="sample">Çağrı İstanbul’da ığdır şöförü 👩🏽‍💻 🏳️‍🌈 שלום עולם مرحبا</p><label>Note <input id="note"></label><label>Body <textarea id="body"></textarea></label><button aria-label="Gönder 👍">Gönder 👍</button>`,
      ),
    },
    "/human-input/inner-scroller": {
      html: EDGE_HTML(
        "Inner Scroller",
        `<style>body{margin:0;height:4000px}#list{position:fixed;left:0;top:0;width:100%;height:80vh;overflow:auto}</style>
<div id="list"><div style="height:3000px"><button id="item">Item</button></div></div>`,
      ),
    },
    "/human-input": {
      html: EDGE_HTML(
        "Input Recorder",
        `<style>body{margin:0;height:4000px}.box{position:absolute}</style>
<input id="field" class="box" style="left:60px;top:60px;width:200px">
<button id="target" class="box" style="left:520px;top:340px;width:120px;height:40px" onclick="this.textContent = 'clicked'">Target</button>
<div id="source" class="box" style="left:60px;top:200px;width:60px;height:60px;background:#ccc">Source</div>
<div id="drop" class="box" style="left:400px;top:180px;width:100px;height:100px;background:#eee">Drop</div>
<input id="agree" type="checkbox" class="box" style="left:60px;top:300px">
<select id="size" class="box" style="left:60px;top:340px"><option>Small</option><option>Large</option></select>
<p id="double" class="box" style="left:300px;top:420px" ondblclick="this.textContent = 'double clicked'">Double</p>
<script>
const events = [];
for (const type of ["mousemove", "mousedown", "mouseup", "keydown", "keyup", "wheel"])
  addEventListener(type, (event) => events.push({ type, key: event.key, x: event.clientX, y: event.clientY, t: performance.now() }), true);
const modifiers = ["Control", "Meta", "Shift", "Alt"];
let dragging = false;
document.getElementById("source").addEventListener("mousedown", () => { dragging = true; });
addEventListener("mouseup", (event) => {
  const box = document.getElementById("drop").getBoundingClientRect();
  if (dragging && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) document.getElementById("drop").textContent = "dropped";
  dragging = false;
});
window.inputLog = () => {
  const of = (type) => events.filter((event) => event.type === type);
  const log = {
    moves: of("mousemove").map((event) => [event.x, event.y]),
    downs: of("mousedown").map((event) => ({ x: event.x, y: event.y, t: event.t })),
    ups: of("mouseup").map((event) => event.t),
    keydowns: of("keydown").filter((event) => !modifiers.includes(event.key)).map((event) => event.t),
    keyups: of("keyup").map((event) => event.t),
    wheels: of("wheel").length,
    scrollY: window.scrollY,
  };
  events.length = 0;
  return JSON.stringify(log);
};
</script>`,
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

const CLOUDFLARE_SLOW_MS = 2900;
const TURNSTILE_SLOW_MS = 1000;

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
  if (pathname === "/popup-slow")
    return Bun.sleep(1500).then(
      () =>
        new Response(EDGE_HTML("Slow Provider", "<p>slow</p>"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
  if (pathname === "/challenge/turnstile-slow")
    return Bun.sleep(TURNSTILE_SLOW_MS).then(
      () =>
        new Response(
          EDGE_HTML(
            "Just a moment...",
            `<p>Verify you are human by completing the action below.</p><div class="cf-turnstile" style="width:300px;height:65px"></div><span id="spinner"></span><script>let turn = 0; setInterval(() => { document.getElementById("spinner").textContent = String(turn++ % 4); }, 100);</script>`,
          ),
          { status: 403, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );
  if (pathname === "/challenge/cloudflare-slow")
    return Bun.sleep(CLOUDFLARE_SLOW_MS).then(
      () =>
        new Response(
          EDGE_HTML(
            "Just a moment...",
            `<div id="challenge-running"><p>Checking your browser before accessing the site.</p><span id="spinner"></span></div><script>let turn = 0; setInterval(() => { document.getElementById("spinner").textContent = String(turn++ % 4); }, 100);</script>`,
          ),
          { status: 503, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
    );
  if (pathname === "/files/slow-frame")
    return Bun.sleep(700).then(
      () =>
        new Response(EDGE_HTML("Slow Frame", "<p>slow frame</p>"), {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
  if (pathname === "/files/slow-style.css")
    return Bun.sleep(500).then(
      () =>
        new Response("body { background: rgb(255, 0, 0); }", {
          headers: { "content-type": "text/css" },
        }),
    );
  if (pathname === "/files/slow-font.woff2")
    return Bun.sleep(1000).then(
      () => new Response(new Uint8Array(64), { headers: { "content-type": "font/woff2" } }),
    );
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
