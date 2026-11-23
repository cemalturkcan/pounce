import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { useMcpHarness } from "../tests/mcpHarness.ts";
import { inSequence } from "../src/shared/async.ts";
import type { SecretStore } from "../src/shared/secrets.ts";
import { openedTab } from "./tools-harness.ts";

const SECRET = "S3cretValue!";
const secrets: SecretStore = {
  backend: "fake",
  list: async () => ["site"],
  get: async () => SECRET,
};
const { call, ok } = useMcpHarness({ name: "ref-contract", secrets });

let server: ReturnType<typeof Bun.serve>;
const actions: string[] = [];
const openTabs: string[] = [];
const base = () => `http://127.0.0.1:${server.port}`;
const otherSite = () => `http://localhost:${server.port}`;

const many = (n: number) =>
  Array.from({ length: n }, (_, i) => `<button>Düğme ${i}</button>`).join("");

const removedAlive = `window.weak = []; window.removedAlive = () => weak.filter((w) => w.deref() && !w.deref().isConnected).length;`;

type PageBody = (query: URLSearchParams) => string;

const sizeOf = (query: URLSearchParams) => Number(query.get("n") ?? 3000);

const rowsOf = (query: URLSearchParams) =>
  Array.from(
    { length: sizeOf(query) },
    (_, i) => `<div><span>Satır ${i}</span><button>Düğme ${i}</button></div>`,
  ).join("");

const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const PAGES = new Map<string, PageBody>(
  Object.entries({
    "/order": (q) =>
      `<main><h1>Sipariş ${q.get("id")}</h1><button onclick="fetch('/act?w=cancel%20${q.get("id")}')">İptal et</button></main>`,
    "/spa": () => `<main id="m"></main><script>
function show(id){ m.innerHTML = '<h1>Sipariş '+id+'</h1><button onclick="fetch(\\'/act?w=cancel%20'+id+'\\')">İptal et</button><a href="#" onclick="history.pushState(null,\\'\\',\\'/spa?id=B\\');show(\\'B\\');return false">Sonraki sipariş</a>'; }
show(new URLSearchParams(location.search).get('id') || 'A');
</script>`,
    "/hash":
      () => `<main><h1 id="t"></h1><button id="c">İptal et</button><a href="#/order/B">Sonraki sipariş</a></main>
<script>
const show = () => { const id = location.hash.split('/')[2] || 'A'; t.textContent = 'Sipariş ' + id; c.onclick = () => fetch('/act?w=cancel%20' + id); };
addEventListener('hashchange', show); show();
</script>`,
    "/inner":
      () => `<h1 id="t"></h1><button id="c">İptal et</button><a href="#" id="nx">Sonraki sipariş</a>
<script>
let id = new URLSearchParams(location.search).get('id') || 'A';
const show = () => { t.textContent = 'Sipariş ' + id; c.onclick = () => fetch('/act?w=cancel%20' + id); };
nx.onclick = (e) => { e.preventDefault(); id = 'B'; history.pushState(null, '', '?id=B'); show(); }; show();
</script>`,
    "/outer": () => `<main><iframe title="sipariş" src="/inner?id=A"></iframe></main>`,
    "/list": () => `<main><ul id="l"></ul></main><script>
let items = ['Kılıf A', 'Kılıf B', 'Kılıf C', 'Kılıf D'];
function render(){ l.innerHTML = ''; for (const it of items.slice(0, 2)) { const li = document.createElement('li'); li.innerHTML = '<span>' + it + '</span>'; const b = document.createElement('button'); b.textContent = 'Sil'; b.onclick = () => { fetch('/act?w=' + encodeURIComponent('delete ' + it)); items = items.filter((x) => x !== it); render(); }; li.append(b); l.append(li); } }
render();
</script>`,
    "/bfa": () =>
      `<main><h1>Sayfa A</h1><button onclick="fetch('/act?w=bfA')">Onayla</button><a href="/bfb">B</a></main>`,
    "/bfb": () =>
      `<main><h1>Sayfa B</h1><button onclick="fetch('/act?w=bfB')">Onayla</button></main>`,
    "/srcdoc":
      () => `<main><iframe id="f1" srcdoc="<button onclick=&quot;fetch('/act?w=pay1')&quot;>Öde</button>"></iframe><iframe id="f2" srcdoc="<p>x</p>"></iframe><button id="sw">Değiştir</button></main>
<script>sw.onclick = () => { f1.srcdoc = '<p>x</p>'; f2.srcdoc = '<button onclick=&quot;fetch(\\'/act?w=pay2\\')&quot;>Öde</button>'; };</script>`,
    "/pay": () => `<button onclick="fetch('/act?w=pay')">Öde</button>`,
    "/twin": () =>
      `<main><iframe src="/pay?n=1" title="a"></iframe><iframe src="/pay?n=1" title="b"></iframe></main>`,
    "/in1": () => `<button onclick="fetch('/act?w=in1')">Bekliyor</button>`,
    "/in2": () => `<button onclick="fetch('/act?w=in2')">Başka</button>`,
    "/fr": (q) => {
      const host = q.get("x") ? otherSite() : base();
      return `<main><button id="a" onclick="fetch('/act?w=a')">Ana</button><button id="r" onclick="document.querySelector('iframe').src='${host}/in2'">Değiştir</button><iframe title="x" src="${host}/in1"></iframe></main>`;
    },
    "/fs": () =>
      `<main><button id="a" onclick="fetch('/act?w=a')">Ana</button><button id="r" onclick="document.querySelector('iframe').contentWindow.location.reload()">Yenile</button><iframe title="x" src="/in1"></iframe></main>`,
    "/pw": () => `<main><label>Şifre <input type="password" id="p"></label></main>`,
    "/pw2": () => `<main><label>Şifre <input type="text" id="p"></label></main>`,
    "/rows": () => `<main><ul id="l"></ul></main><script>
let items = [1, 2, 3, 4, 5, 6];
function r(){ l.replaceChildren(...items.map((i) => { const li = document.createElement('li'); const b = document.createElement('button'); b.textContent = 'Sil ' + i; b.onclick = () => { fetch('/act?w=sil' + i); items = items.filter((x) => x !== i); r(); }; li.append(b); return li; })); }
r();
</script>`,
    "/signup":
      () => `<main><form aria-label="Kayıt" onsubmit="event.preventDefault(); fetch('/act?w=submit')"><label>E-posta <input id="e" type="email"></label><p id="v"></p><label>Şifre <input id="pw" type="password"></label><p id="s"></p><button>Kayıt ol</button></form></main>
<script>
e.oninput = () => { v.textContent = e.value.includes('@') ? '' : 'Geçerli bir e-posta girin'; };
pw.oninput = () => { s.textContent = 'Şifre gücü: ' + (pw.value.length > 8 ? 'güçlü' : 'zayıf'); };
</script>`,
    "/comment":
      () => `<main><form aria-label="Yorum" onsubmit="event.preventDefault(); fetch('/act?w=comment')"><textarea aria-label="Yorum metni" id="ta"></textarea><span id="n">0/280</span><button>Gönder</button></form></main>
<script>ta.oninput = () => { n.textContent = ta.value.length + '/280'; };</script>`,
    "/cart":
      () => `<main><dialog id="d"><h2>Sepet</h2><ul><li>Kılıf <span id="q">1</span> adet <button id="p">Artır</button></li></ul><p>Toplam <span id="tot">249</span> TL</p><button onclick="fetch('/act?w=checkout')">Ödemeye geç</button></dialog></main>
<script>
p.onclick = () => { q.textContent = String(+q.textContent + 1); tot.textContent = String(249 * +q.textContent); };
d.showModal();
</script>`,
    "/otp":
      () => `<main><dialog id="d"><h2>Doğrulama</h2><form onsubmit="event.preventDefault(); fetch('/act?w=otp')"><label>Kod <input id="k"></label><button>Onayla</button></form><p>Kodu tekrar gönder <span id="c"></span></p></dialog></main>
<script>d.showModal(); let s = 120; const tick = () => { c.textContent = '0:' + String(s).padStart(3, '0'); s--; }; tick(); setInterval(tick, 1000);</script>`,
    "/clock":
      () => `<main><ul><li>Flaş indirim, bitişe <span id="c"></span> <button onclick="fetch('/act?w=buy')">Sepete ekle</button></li></ul></main>
<script>let s = 3600; const tick = () => { c.textContent = '00:' + String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); s--; }; tick(); setInterval(tick, 1000);</script>`,
    "/moved": () =>
      `<main><section aria-label="A"><button id="x" onclick="fetch('/act?w=x')">Sil</button></section><section aria-label="B" id="B"></section><button onclick="B.append(x)">Taşı</button></main>`,
    "/reins": () =>
      `<main><div id="h"><button id="x" onclick="fetch('/act?w=x')">Sil</button></div><button onclick="const e = x; e.remove(); setTimeout(() => { const c = document.createElement('button'); c.id = 'x'; c.textContent = 'Sil'; c.onclick = () => fetch('/act?w=clone'); h.append(c); }, 300)">Kopya</button></main>`,
    "/rs": () =>
      `<main><h1>Sipariş A</h1><button onclick="fetch('/act?w=cancelA')">İptal et</button><button id="r" onclick="history.replaceState({ x: 1 }, '', location.href)">Yenile</button></main>`,
    "/two": () =>
      `<main><div role="row"><button id="a" onclick="fetch('/act?w=a')">Birinci</button></div><div role="row"><button id="b" onclick="fetch('/act?w=b')">İkinci</button><button id="c" onclick="fetch('/act?w=c')">Üçüncü</button></div></main>`,
    "/save-or-cancel": () =>
      `<main><button id="a" onclick="fetch('/act?w=' + encodeURIComponent(this.textContent))">Kaydet</button><button id="b" onclick="fetch('/act?w=' + encodeURIComponent(this.textContent))">Vazgeç</button></main>`,
    "/save-or-cancel-closed": () =>
      `<main><button id="a">Kaydet</button><button id="b">Vazgeç</button><x-closed></x-closed></main><script>customElements.define('x-closed', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'closed' }).innerHTML = '<span>iç</span>'; } });</script>`,
    "/chain-or": () =>
      `<main><div id="d"><button id="c" onclick="fetch('/act?w=c')">Tamam</button></div><button id="b" onclick="fetch('/act?w=b')">Vazgeç</button></main>`,
    "/labeled-or": () =>
      `<main><div id="g" onclick="fetch('/act?w=g')" style="cursor:pointer" aria-label="Etiketli kutu">x</div><button id="b" onclick="fetch('/act?w=b')">Vazgeç</button></main>`,
    "/order-rows": () =>
      `<main><div role="row" id="r1"><span role="cell" id="c1">Sipariş A</span><button onclick="fetch('/act?w=row1')">Sil</button></div><div role="row" id="r2"><span role="cell" id="c2">Sipariş C</span><button onclick="fetch('/act?w=row2')">Sil</button></div></main>`,
    "/hid": () =>
      `<main><button id="a" onclick="fetch('/act?w=a')">Aç</button><button id="t" onclick="a.hidden = true; setTimeout(() => { a.hidden = false; }, 600)">Gizle</button><button id="p" onclick="fetch('/act?w=p')">Basılı</button><button id="q" onclick="p.style.pointerEvents = 'none'; setTimeout(() => { p.style.pointerEvents = ''; }, 600)">Kilitle</button></main>`,
    "/more": () =>
      `<main><ul id="l"><li>Ürün 1</li></ul><button id="m" onclick="m.hidden = true; setTimeout(() => { l.insertAdjacentHTML('beforeend', '<li>Ürün 2</li>'); m.hidden = false; }, 2000)">Daha fazla yükle</button></main>`,
    "/hang": () =>
      `<button onclick="fetch('/act?w=hang')">Askıda</button><script>setTimeout(() => { const t = Date.now(); while (Date.now() - t < 60000) {} }, 1500)</script>`,
    "/frozen": () =>
      `<main><button onclick="fetch('/act?w=main')">Ana</button><iframe title="reklam" src="${otherSite()}/hang"></iframe></main>`,
    "/rm": () =>
      `<main><button id="x" onclick="fetch('/act?w=x')">Bildirim</button><button id="k" onclick="x.remove()">Kaldır</button><button id="hd" onclick="x.hidden = true">Gizle</button></main>`,
    "/modal": () =>
      `<main><dialog id="d"><h2>Kaydedildi</h2><button id="ok" onclick="fetch('/act?w=ok')">Tamam</button><button id="cl" onclick="d.close()">Kapat</button><button id="rm" onclick="d.remove()">Sil</button></dialog></main><script>d.showModal();</script>`,
    "/loader": () =>
      `<main><button id="g">Gönderiliyor 0/5</button></main><script>let n = 0; const t = setInterval(() => { n++; if (n < 5) g.textContent = 'Gönderiliyor ' + n + '/5'; else { clearInterval(t); g.remove(); } }, 600)</script>`,
    "/rsl": () =>
      `<main><button id="g">Gönderiliyor</button><button id="u" onclick="history.replaceState(null, '', '?step=2')">Adım</button></main><script>setTimeout(() => g.remove(), 2500)</script>`,
    "/toggle": () =>
      `<main><button id="b" onclick="this.textContent = this.textContent === 'Takip et' ? 'Takibi bırak' : 'Takip et'; fetch('/act?w=' + encodeURIComponent(this.textContent))">Takip et</button><button id="o">Diğer</button></main>`,
    "/churn": () =>
      `<main><button id="k" onclick="fetch('/act?w=k')">Sabit</button><div id="l"></div></main><script>function r(){ l.replaceChildren(...Array.from({ length: 200 }, (_, i) => { const b = document.createElement('button'); b.textContent = 'Satır ' + i; return b; })); } r(); setInterval(r, 150);</script>`,
    "/spa-list": () =>
      `<main><div id="l"></div></main><script>${removedAlive} function r(){ for (const b of l.querySelectorAll('button')) weak.push(new WeakRef(b)); l.replaceChildren(...Array.from({ length: 300 }, (_, i) => { const b = document.createElement('button'); b.textContent = 'Öğe ' + i + ' ' + Math.random().toString(36).slice(2, 6); return b; })); } r();</script>`,
    "/drag": () =>
      `<main><button id="s">Kaynak</button><button id="t" onmouseup="fetch('/act?w=' + encodeURIComponent('drop ' + this.textContent))">Hedef</button><a href="#/b">Sonraki</a></main>`,
    "/big": (q) =>
      `<main><button id="t" onclick="fetch('/act?w=t')">Hedef</button>${many(Number(q.get("n") ?? 10000))}</main>`,
    "/shy": () =>
      `<main><button id="b" onclick="fetch('/act?w=b')">Takip et</button><button id="hide" onclick="b.style.display = 'none'">Gizle</button></main>`,
    "/saving": () =>
      `<main><div role="dialog" aria-label="Kayıt" id="d"><p>Kaydediliyor</p><button>Tamam</button></div><button id="rm" onclick="setTimeout(() => d.remove(), 500)">Kapat</button></main>`,
    "/table": (q) => `<main>${rowsOf(q)}</main>`,
    "/generic": (q) =>
      `<main><div id="g" onclick="1" style="cursor:pointer">${rowsOf(q)}</div></main>`,
    "/cell": (q) => `<main><table><tr><td id="c">${rowsOf(q)}</td></tr></table></main>`,
    "/tree": (q) =>
      `<main><ul role="tree" aria-label="Dosyalar"><li role="treeitem" aria-expanded="true">Kök<ul role="group">${Array.from({ length: sizeOf(q) }, (_, i) => `<li role="treeitem">Öğe ${i}</li>`).join("")}</ul></li></ul></main>`,
    "/items": (q) =>
      `<main><ul aria-label="Liste">${Array.from({ length: sizeOf(q) }, (_, i) => `<li>Öğe ${i} <button>Sil ${i}</button></li>`).join("")}</ul></main>`,
    "/inputs": (q) =>
      `<main><form aria-label="Form">${Array.from({ length: sizeOf(q) }, (_, i) => `<label>Alan ${i} <input></label>`).join("")}</form></main>`,
    "/options": (q) =>
      `<main><ul role="listbox" aria-label="Seçenekler" id="lb">${Array.from({ length: sizeOf(q) }, (_, i) => `<li role="option">Seç ${i}</li>`).join("")}</ul></main>`,
    "/kinds": () =>
      `<main><div id="g" onclick="fetch('/act?w=generic')" style="cursor:pointer"><span>Kutu</span><b>kalın</b></div>
<table><tr><td onclick="fetch('/act?w=cell')"><div><span>Satır 1</span><button>İç 1</button></div><div><span>Satır 2</span><button>İç 2</button></div></td></tr></table>
<div onclick="fetch('/act?w=labeled')" style="cursor:pointer" aria-label="Etiketli kutu">x</div>
<div onclick="fetch('/act?w=titled')" style="cursor:pointer" title="Başlıklı kutu">y</div>
<button onclick="fetch('/act?w=long')">${"Uzun ad ".repeat(20)}</button>
<button onclick="fetch('/act?w=quoted')">  Çok   boşluk&nbsp;nbsp "tırnak" \\ ters: iki</button>
<button onclick="fetch('/act?w=hidden-child')">Görünen<span hidden> Gizli</span></button>
<button aria-hidden="true" onclick="fetch('/act?w=aria-hidden')">Gizli ama görünür</button>
<span id="lbl">Etiket metni</span><button aria-labelledby="lbl" onclick="fetch('/act?w=labelledby')">x</button>
<button onclick="fetch('/act?w=icon')"><img alt="Simge" src="${PIXEL}"></button>
<iframe title="Çerçeve" srcdoc="<p>iç</p>"></iframe></main>`,
    "/frame": () => `<main><iframe id="f" title="Çerçeve" src="/inner-button?w=A"></iframe></main>`,
    "/two-frames": () =>
      `<main><iframe id="f1" title="Bir" src="/inner-button?w=A"></iframe><iframe id="f2" title="İki" src="/inner-button?w=B"></iframe></main>`,
    "/mixed-frame": () =>
      `<main><h1>Başlık</h1><iframe id="f" title="Çerçeve" src="/mixed-inner"></iframe></main>`,
    "/mixed-inner": () => `<button>Tamam</button><a href="#x">Bağlantı</a><p>iç</p>`,
    "/form-frame": () => `<main><iframe id="f" title="Çerçeve" src="/form-inner"></iframe></main>`,
    "/form-inner": () =>
      `<form aria-label="Sipariş"><button>Tamam</button></form><button>Dış</button>`,
    "/editor-frame": () =>
      `<main><iframe id="f" title="Düzenleyici" src="/editor?w=A"></iframe></main>`,
    "/editor": (q) => `<body contenteditable="true">${q.get("w")}</body>`,
    "/inner-button": (q) =>
      `<button onclick="fetch('/act?w=inner%20${q.get("w")}')">Tamam</button>`,
    "/shadow-host": () =>
      `<main><x-host id="h" role="button" aria-label="Kaydet" onclick="fetch('/act?w=' + encodeURIComponent('host ' + this.getAttribute('aria-label')))"></x-host></main><script>h.attachShadow({ mode: 'open' }).innerHTML = '<div role="button" aria-label="Kaydet">x</div>';</script>`,
    "/shadow-big": (q) =>
      `<main><x-host id="h" role="button" aria-label="Kaydet">k</x-host></main><script>h.attachShadow({ mode: 'open' }).innerHTML = '<slot></slot><div hidden>' + Array.from({ length: ${sizeOf(q)} }, (_, i) => '<span>s' + i + '</span>').join('') + '</div>';</script>`,
    "/custom": (q) => `<main><app-list id="g">${rowsOf(q)}</app-list></main>`,
    "/section": (q) => `<main><section id="g">${rowsOf(q)}</section></main>`,
    "/label": (q) => `<main><label id="g">${rowsOf(q)}</label></main>`,
    "/icon-menu": (q) =>
      `<main><ul role="menu" id="m" aria-label="Menü"><li role="menuitem" id="mi"><span aria-hidden="true">✓</span> Kopyala</li></ul>${rowsOf(q)}</main>`,
    "/order-dialog": () =>
      `<main><div role="dialog" id="d" aria-label="Sipariş A"><button id="b" onclick="fetch('/act?w=' + encodeURIComponent('delete ' + d.getAttribute('aria-label')))">Sil</button></div></main>`,
    "/labeled": (q) => `<main><div id="g" aria-label="Liste">${rowsOf(q)}</div></main>`,
    "/titled": (q) => `<main><span id="g" title="İpucu">${rowsOf(q)}</span></main>`,
    "/silent-frame": () => `<main><iframe id="f" title="Yavaş" src="/never"></iframe></main>`,
    "/saving-button": () =>
      `<main><button id="b" disabled onclick="fetch('/act?w=' + encodeURIComponent(b.textContent))">Kaydet</button></main>`,
    "/saving-field": () =>
      `<main><label><span id="l">Ad</span> <input id="f" disabled oninput="fetch('/act?w=' + encodeURIComponent(l.textContent))"></label></main>`,
    "/order-wait": (q) =>
      `<main><div role="dialog" id="d" aria-label="Sipariş A"><p>İçerik</p><button id="b" ${q.get("disabled") ? "disabled" : 'style="display:none"'} onclick="fetch('/act?w=' + encodeURIComponent('delete ' + d.getAttribute('aria-label')))">Sil</button></div></main>`,
    "/hidden-parts": () =>
      `<main><div id="w"><button id="rb">Kaydet<span style="display:none">(mobil)</span></button><div id="ng" aria-label="Bildirimler"><p>Yeni ileti</p></div></div></main>`,
    "/small-named": (q) =>
      `<main><div id="g" aria-label="Araçlar"><button>Araç</button></div>${rowsOf(q)}</main>`,
    "/hover-label": () =>
      `<main><button id="f" onclick="fetch('/act?w=follow')" onmouseenter="f.textContent = 'Takibi bırak'" onmouseleave="f.textContent = 'Takip ediliyor'">Takip ediliyor</button><button id="o">Başka</button></main>`,
    "/hover-label-css": () =>
      `<style>#f .h{display:none}#f:hover .n{display:none}#f:hover .h{display:inline}</style><main><button id="f" onclick="fetch('/act?w=follow')"><span class="n">Takip ediliyor</span><span class="h">Takibi bırak</span></button><button id="o">Başka</button></main>`,
    "/window-menu": () =>
      `<script>window.clicks = 0; addEventListener('click', () => { clicks += 1; setTimeout(() => { m.hidden = true; }, 0); }, true);</script><main><div id="m" role="menu" aria-label="Liste"><div role="menuitem" onclick="fetch('/act?w=item')">Öğe</div></div></main>`,
    "/window-toggle": () =>
      `<script>addEventListener('click', (e) => { if (e.target.id === 't') t.setAttribute('aria-pressed', String(t.getAttribute('aria-pressed') !== 'true')); }, true);</script><main><button id="t" aria-pressed="false">Değiştir</button></main>`,
    "/window-dblclick": () =>
      `<script>addEventListener('dblclick', () => fetch('/act?w=dblclick'), true);</script><main><button>Büyüt</button></main>`,
  } satisfies Record<string, PageBody>),
);

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/never") return new Promise<Response>(() => undefined);
      if (url.pathname === "/act") {
        actions.push(url.searchParams.get("w") ?? "");
        return new Response("ok");
      }
      const body = PAGES.get(url.pathname);
      if (!body) return new Response("not found", { status: 404 });
      return new Response(
        `<!doctype html><html><head><meta charset="utf-8"><title>p</title></head><body>${body(url.searchParams)}</body></html>`,
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    },
  });
});

afterAll(() => {
  server?.stop(true);
});

beforeEach(() => {
  actions.length = 0;
});

afterEach(async () => {
  const closing = openTabs.splice(0);
  if (closing.length) await call("tabs", { close: closing });
});

async function open(path: string) {
  const tab = openedTab(await ok("navigate", { url: `${base()}${path}` }));
  openTabs.push(tab);
  return tab;
}

function refOf(snapshot: string, label: string, nth = 0) {
  const line = snapshot.split("\n").filter((candidate) => candidate.includes(label))[nth];
  const ref = line ? /\[ref=([a-z0-9]+)\]/.exec(line)?.[1] : undefined;
  expect(ref, `no ref for ${label} in:\n${snapshot}`).toMatch(/^[a-z0-9]+$/);
  return ref ?? "";
}

async function actionsSoFar() {
  await Bun.sleep(400);
  return [...actions];
}

async function valueOf(tab: string, expression: string) {
  const result = await call("evaluate", { tab, expression });
  return String(result.structured?.value);
}

async function timed<T>(work: () => Promise<T>) {
  const start = performance.now();
  await work();
  return performance.now() - start;
}

async function waitedFor(tab: string, target: string, state: string, timeout_ms = 3000) {
  return (await call("wait_for", { tab, target, state, timeout_ms })).text;
}

describe("a ref never acts on another element", () => {
  test("a ref from one order's page does not cancel the next order on the same site", async () => {
    const tab = await open("/order?id=A");
    const cancel = refOf(await ok("snapshot", { tab }), 'button "İptal et"');
    await ok("navigate", { tab, url: `${base()}/order?id=B` });
    await call("click", { tab, target: cancel });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a ref does not cancel the next order after a pushState route change", async () => {
    const tab = await open("/spa?id=A");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, "Sonraki sipariş") });
    await call("click", { tab, target: refOf(snapshot, 'button "İptal et"') });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a ref does not cancel the next order after a hash route change", async () => {
    const tab = await open("/hash#/order/A");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, "Sonraki sipariş") });
    await call("click", { tab, target: refOf(snapshot, 'button "İptal et"') });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a ref inside an iframe does not cancel the next order after the iframe's pushState", async () => {
    const tab = await open("/outer");
    await Bun.sleep(500);
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await ok("click", { tab, target: refOf(snapshot, "Sonraki sipariş") });
    await call("click", { tab, target: refOf(snapshot, 'button "İptal et"') });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a deleted row's ref does not delete the row drawn in its place", async () => {
    const tab = await open("/list");
    const sil = refOf(await ok("snapshot", { tab }), 'button "Sil"');
    await ok("click", { tab, target: sil });
    await call("click", { tab, target: sil });
    expect(await actionsSoFar()).toEqual(["delete Kılıf A"]);
  });

  test("a ref of a page left and restored from the back/forward cache is not used on the other page", async () => {
    const tab = await open("/bfa");
    const snapshotA = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshotA, 'link "B"') });
    await Bun.sleep(400);
    const confirmB = refOf(await ok("snapshot", { tab }), 'button "Onayla"');
    await ok("navigate", { tab, url: "back" });
    await Bun.sleep(400);
    await call("click", { tab, target: confirmB });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a srcdoc iframe's ref does not pay in the sibling srcdoc iframe", async () => {
    const tab = await open("/srcdoc");
    await Bun.sleep(400);
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await ok("click", { tab, target: refOf(snapshot, 'button "Değiştir"') });
    await Bun.sleep(800);
    await call("click", { tab, target: refOf(snapshot, 'button "Öde"') });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a ref in one of two twin iframes is not used after that iframe reloaded", async () => {
    const tab = await open("/twin");
    await Bun.sleep(500);
    const pay = refOf(await ok("snapshot", { tab, scope: "full" }), 'button "Öde"');
    await call("evaluate", {
      tab,
      expression: "document.querySelector('iframe').contentWindow.location.reload(); 1",
    });
    await Bun.sleep(800);
    await call("click", { tab, target: pay });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a ref in an iframe that reloaded the same page is not used for the new page's button", async () => {
    const tab = await open("/fs");
    await Bun.sleep(800);
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await ok("click", { tab, target: refOf(snapshot, 'button "Yenile"') });
    await Bun.sleep(800);
    await call("click", { tab, target: refOf(snapshot, 'button "Bekliyor"') });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a ref only another tab gave out is refused", async () => {
    const own = await open("/rows");
    const other = await open("/big?n=300");
    await ok("snapshot", { tab: own });
    const foreign = refOf(
      await ok("snapshot", { tab: other, scope: "full", max_chars: 100_000 }),
      'button "Düğme 250"',
    );
    const result = await call("click", { tab: own, target: foreign });
    expect(result.isError).toBe(true);
  });

  test("fill with a secret does not type it into another page's field", async () => {
    const tab = await open("/pw");
    const password = refOf(await ok("snapshot", { tab }), 'textbox "Şifre"');
    await ok("navigate", { tab, url: `${base()}/pw2` });
    await call("fill", { tab, target: password, secret: "site" });
    expect(await valueOf(tab, "p.value")).toBe("");
  });

  test("secrets.fill in a script does not type it into another page's field", async () => {
    const tab = await open("/pw");
    const password = refOf(await ok("snapshot", { tab }), 'textbox "Şifre"');
    await ok("navigate", { tab, url: `${base()}/pw2` });
    await call("run_script", { tab, code: `await secrets.fill("${password}", "site");` });
    expect(await valueOf(tab, "p.value")).toBe("");
  });
});

describe("a ref is not refused for text that changed around it", () => {
  test("fill types every field and submits a form whose strength meter changed", async () => {
    const tab = await open("/signup");
    const snapshot = await ok("snapshot", { tab });
    await call("fill", {
      tab,
      fields: [
        { target: refOf(snapshot, 'textbox "E-posta"'), value: "a@b.co" },
        { target: refOf(snapshot, 'textbox "Şifre"'), value: "correcthorse" },
      ],
      submit: refOf(snapshot, 'button "Kayıt ol"'),
    });
    expect(await actionsSoFar()).toEqual(["submit"]);
  });

  test("a comment form sends after its character counter changed", async () => {
    const tab = await open("/comment");
    const snapshot = await ok("snapshot", { tab });
    await ok("fill", { tab, target: refOf(snapshot, "Yorum metni"), value: "Harika ürün" });
    await call("click", { tab, target: refOf(snapshot, 'button "Gönder"') });
    expect(await actionsSoFar()).toEqual(["comment"]);
  });

  test("a cart dialog goes to checkout after its total changed", async () => {
    const tab = await open("/cart");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Artır"') });
    await call("click", { tab, target: refOf(snapshot, 'button "Ödemeye geç"') });
    expect(await actionsSoFar()).toEqual(["checkout"]);
  });

  test("a code field fills while the dialog's countdown ticks", async () => {
    const tab = await open("/otp");
    const snapshot = await ok("snapshot", { tab });
    await Bun.sleep(1200);
    await call("fill", { tab, target: refOf(snapshot, 'textbox "Kod"'), value: "123456" });
    expect(await valueOf(tab, "k.value")).toBe("123456");
  });

  test("a button in a row with a live clock clicks", async () => {
    const tab = await open("/clock");
    const snapshot = await ok("snapshot", { tab });
    await Bun.sleep(1500);
    await call("click", { tab, target: refOf(snapshot, 'button "Sepete ekle"') });
    expect(await actionsSoFar()).toEqual(["buy"]);
  });

  test("a tab's own ref clicks while another tab gave out a ref with the same name", async () => {
    const own = await open("/rm");
    const other = await open("/toggle");
    const notice = refOf(await ok("snapshot", { tab: own }), 'button "Bildirim"');
    await ok("snapshot", { tab: other });
    await call("click", { tab: own, target: notice });
    expect(await actionsSoFar()).toEqual(["x"]);
  });

  test("a ref whose button moved to another section clicks that same button", async () => {
    const tab = await open("/moved");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Taşı"') });
    await call("click", { tab, target: refOf(snapshot, 'button "Sil"') });
    expect(await actionsSoFar()).toEqual(["x"]);
  });

  test("a ref clicks after replaceState kept the same address", async () => {
    const tab = await open("/rs");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Yenile"') });
    await call("click", { tab, target: refOf(snapshot, 'button "İptal et"') });
    expect(await actionsSoFar()).toEqual(["cancelA"]);
  });

  test("a toggle's first ref clicks again once its name came back", async () => {
    const tab = await open("/toggle");
    const first = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
    await ok("click", { tab, target: first });
    await ok("click", {
      tab,
      target: refOf(await ok("snapshot", { tab }), 'button "Takibi bırak"'),
    });
    await ok("snapshot", { tab });
    actions.length = 0;
    await call("click", { tab, target: first, timeout_ms: 2000 });
    expect(await actionsSoFar()).toEqual(["Takibi bırak"]);
  });
});

describe("a ref whose element is hidden for a moment waits for it", () => {
  test("a click on a button hidden for a moment clicks it", async () => {
    const tab = await open("/hid");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: "#t" });
    await call("click", { tab, target: refOf(snapshot, 'button "Aç"') });
    expect(await actionsSoFar()).toEqual(["a"]);
  });

  test("a click on a button that ignores the pointer for a moment clicks it", async () => {
    const tab = await open("/hid");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: "#q" });
    await call("click", { tab, target: refOf(snapshot, 'button "Basılı"') });
    expect(await actionsSoFar()).toEqual(["p"]);
  });

  test("wait_for a load more button that hid while loading finds it again", async () => {
    const tab = await open("/more");
    const more = refOf(await ok("snapshot", { tab }), 'button "Daha fazla yükle"');
    await ok("click", { tab, target: more });
    expect(await waitedFor(tab, more, "visible", 8000)).toBe(`${more} is visible.`);
  });

  test("a ref click on the page goes through while a cross-site iframe is frozen", async () => {
    const tab = await open("/frozen");
    await Bun.sleep(500);
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    await Bun.sleep(2000);
    await call("click", { tab, target: refOf(snapshot, 'button "Ana"') });
    expect(await actionsSoFar()).toEqual(["main"]);
  });
});

type Step = {
  name: string;
  run: (tab: string, snapshot: string, trigger: string) => Promise<string>;
};

const removalSteps: Step[] = [
  {
    name: "right after the removing click",
    run: (tab, s, t) => ok("click", { tab, target: refOf(s, t) }),
  },
  {
    name: "after a removing click with include_diff",
    run: (tab, s, t) => ok("click", { tab, target: refOf(s, t), include_diff: true }),
  },
  {
    name: "after a removing click with include_snapshot",
    run: (tab, s, t) => ok("click", { tab, target: refOf(s, t), include_snapshot: true }),
  },
  {
    name: "after a removing click and a new snapshot",
    run: async (tab, s, t) => {
      await ok("click", { tab, target: refOf(s, t) });
      return ok("snapshot", { tab });
    },
  },
  {
    name: "after a removing click and another ref's action",
    run: async (tab, s, t) => {
      await ok("click", { tab, target: refOf(s, t) });
      return ok("hover", { tab, target: refOf(s, 'button "Kaldır"') });
    },
  },
  {
    name: "after a removing click and a selector action",
    run: async (tab, s, t) => {
      await ok("click", { tab, target: refOf(s, t) });
      return ok("hover", { tab, target: "#k" });
    },
  },
];

const absences = [
  { state: "detached", trigger: 'button "Kaldır"' },
  { state: "hidden", trigger: 'button "Gizle"' },
];

describe("wait_for hidden or detached on an element that really left", () => {
  for (const { state, trigger } of absences)
    for (const step of removalSteps)
      test(`wait_for ${state} says ${state} ${step.name}`, async () => {
        const tab = await open("/rm");
        const snapshot = await ok("snapshot", { tab });
        const notice = refOf(snapshot, 'button "Bildirim"');
        await step.run(tab, snapshot, trigger);
        expect(await waitedFor(tab, notice, state)).toBe(`${notice} is ${state}.`);
      });

  for (const { state, trigger } of absences)
    test(`wait_for ${state} answers within 1 s after a removing click and a new snapshot`, async () => {
      const tab = await open("/rm");
      const snapshot = await ok("snapshot", { tab });
      const notice = refOf(snapshot, 'button "Bildirim"');
      await ok("click", { tab, target: refOf(snapshot, trigger) });
      await ok("snapshot", { tab });
      expect(await timed(() => waitedFor(tab, notice, state, 5000))).toBeLessThan(1000);
    });

  test("wait_for hidden says hidden for a closed dialog's button after a new snapshot", async () => {
    const tab = await open("/modal");
    const snapshot = await ok("snapshot", { tab });
    const done = refOf(snapshot, 'button "Tamam"');
    await ok("click", { tab, target: refOf(snapshot, 'button "Kapat"') });
    await ok("snapshot", { tab });
    expect(await waitedFor(tab, done, "hidden")).toBe(`${done} is hidden.`);
  });

  test("wait_for detached says detached for a removed dialog's button after a new snapshot", async () => {
    const tab = await open("/modal");
    const snapshot = await ok("snapshot", { tab });
    const done = refOf(snapshot, 'button "Tamam"');
    await ok("click", { tab, target: refOf(snapshot, 'button "Sil"') });
    await ok("snapshot", { tab });
    expect(await waitedFor(tab, done, "detached")).toBe(`${done} is detached.`);
  });

  test("wait_for detached says detached for a button replaced by a copy", async () => {
    const tab = await open("/reins");
    const snapshot = await ok("snapshot", { tab });
    const sil = refOf(snapshot, 'button "Sil"');
    await ok("click", { tab, target: refOf(snapshot, 'button "Kopya"') });
    expect(await waitedFor(tab, sil, "detached")).toBe(`${sil} is detached.`);
  });

  test("wait_for hidden answers only once a button whose name counts up is removed", async () => {
    const tab = await open("/loader");
    const loader = refOf(await ok("snapshot", { tab }), "Gönderiliyor");
    await Bun.sleep(800);
    await call("wait_for", { tab, target: loader, state: "hidden", timeout_ms: 8000 });
    expect(await valueOf(tab, "document.getElementById('g') ? 'there' : 'removed'")).toBe(
      "removed",
    );
  });

  test("wait_for hidden answers only once the button is removed after the address changed in place", async () => {
    const tab = await open("/rsl");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Adım"') });
    await call("wait_for", {
      tab,
      target: refOf(snapshot, 'button "Gönderiliyor"'),
      state: "hidden",
      timeout_ms: 8000,
    });
    expect(await valueOf(tab, "document.getElementById('g') ? 'there' : 'removed'")).toBe(
      "removed",
    );
  });

  test("wait_for hidden on a visible button whose name changed does not say hidden", async () => {
    const tab = await open("/toggle");
    const follow = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
    await ok("evaluate", { tab, expression: "b.textContent = 'Takibi bırak'; 1" });
    expect(await waitedFor(tab, follow, "hidden", 1500)).not.toBe(`${follow} is hidden.`);
  });
});

const iframeReloads = [
  { name: "loaded another page", path: "/fr", trigger: 'button "Değiştir"' },
  { name: "loaded another site's page", path: "/fr?x=1", trigger: 'button "Değiştir"' },
  { name: "reloaded the same page", path: "/fs", trigger: 'button "Yenile"' },
];

describe("wait_for on a ref inside an iframe that loaded a new document", () => {
  for (const { name, path, trigger } of iframeReloads)
    test(`wait_for detached says detached after the iframe ${name} and another ref clicked`, async () => {
      const tab = await open(path);
      await Bun.sleep(800);
      const snapshot = await ok("snapshot", { tab, scope: "full" });
      const waiting = refOf(snapshot, 'button "Bekliyor"');
      await ok("click", { tab, target: refOf(snapshot, trigger) });
      await Bun.sleep(800);
      await ok("click", { tab, target: refOf(snapshot, 'button "Ana"') });
      expect(await waitedFor(tab, waiting, "detached", 2500)).toBe(`${waiting} is detached.`);
    });

  test("wait_for detached says detached right after the iframe loaded another page", async () => {
    const tab = await open("/fr");
    await Bun.sleep(800);
    const snapshot = await ok("snapshot", { tab, scope: "full" });
    const waiting = refOf(snapshot, 'button "Bekliyor"');
    await ok("click", { tab, target: refOf(snapshot, 'button "Değiştir"') });
    await Bun.sleep(800);
    expect(await waitedFor(tab, waiting, "detached", 2500)).toBe(`${waiting} is detached.`);
  });
});

const RENAMED = /name changed from "Takip et" to "Takibi bırak"/;

const renameSteps: { name: string; run: (tab: string) => Promise<string> }[] = [
  { name: "right after the rename", run: async () => "" },
  { name: "after a new snapshot", run: (tab) => ok("snapshot", { tab }) },
  {
    name: "after a selector action on another element",
    run: (tab) => ok("hover", { tab, target: "#o" }),
  },
  { name: "after read_page", run: (tab) => ok("read_page", { tab }) },
  { name: "after a screenshot", run: (tab) => ok("screenshot", { tab }) },
];

async function renamedFollow() {
  const tab = await open("/toggle");
  const follow = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
  await ok("evaluate", { tab, expression: "b.textContent = 'Takibi bırak'; 1" });
  return { tab, follow };
}

describe("a renamed ref is refused as renamed", () => {
  for (const step of renameSteps)
    test(`a renamed ref says its old and new name ${step.name}`, async () => {
      const { tab, follow } = await renamedFollow();
      await step.run(tab);
      const result = await call("click", { tab, target: follow, timeout_ms: 3000 });
      expect(result.text).toMatch(RENAMED);
    });

  test("a ref renamed by a selector click with include_diff says its old and new name", async () => {
    const tab = await open("/toggle");
    const follow = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
    await ok("click", { tab, target: "#b", include_diff: true });
    const result = await call("click", { tab, target: follow, timeout_ms: 3000 });
    expect(result.text).toMatch(RENAMED);
  });

  test("a renamed ref is refused within 1 s after a new snapshot", async () => {
    const { tab, follow } = await renamedFollow();
    await ok("snapshot", { tab });
    expect(
      await timed(() => call("click", { tab, target: follow, timeout_ms: 5000 })),
    ).toBeLessThan(1000);
  });
});

const scriptClick = (tab: string, ref: string) =>
  call("run_script", {
    tab,
    code: `await ref(${JSON.stringify(ref)}).click({ timeout: 3000 }); return "clicked";`,
  });

async function hashMovedCancel() {
  const tab = await open("/hash#/order/A");
  const snapshot = await ok("snapshot", { tab });
  await ok("click", { tab, target: refOf(snapshot, "Sonraki sipariş") });
  return { tab, cancel: refOf(snapshot, 'button "İptal et"') };
}

describe("a script's ref follows the same rule as the tools", () => {
  test("a script's renamed ref says its old and new name", async () => {
    const { tab, follow } = await renamedFollow();
    expect((await scriptClick(tab, follow)).text).toMatch(RENAMED);
  });

  test("a script's renamed ref does not click the renamed button", async () => {
    const { tab, follow } = await renamedFollow();
    await scriptClick(tab, follow);
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a script's ref after a hash route change says the address changed", async () => {
    const { tab, cancel } = await hashMovedCancel();
    expect((await scriptClick(tab, cancel)).text).toMatch(/address changed from .*#\/order\/A/);
  });

  test("a script's ref does not cancel the next order after a hash route change", async () => {
    const { tab, cancel } = await hashMovedCancel();
    await scriptClick(tab, cancel);
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a script's ref of an unchanged button clicks it", async () => {
    const tab = await open("/toggle");
    await scriptClick(tab, refOf(await ok("snapshot", { tab }), 'button "Takip et"'));
    expect(await actionsSoFar()).toEqual(["Takibi bırak"]);
  });

  test("a script's ref of a hidden button says it is not visible", async () => {
    const tab = await open("/rm");
    const note = refOf(await ok("snapshot", { tab }), 'button "Bildirim"');
    await ok("click", { tab, target: "#hd" });
    const result = await call("run_script", {
      tab,
      code: `return await ref(${JSON.stringify(note)}).isVisible();`,
    });
    expect(result.structured?.value).toBe(false);
  });

  test("a script's ref of a removed button counts no element", async () => {
    const tab = await open("/rm");
    const note = refOf(await ok("snapshot", { tab }), 'button "Bildirim"');
    await ok("click", { tab, target: "#k" });
    const result = await call("run_script", {
      tab,
      code: `return await ref(${JSON.stringify(note)}).count();`,
    });
    expect(result.structured?.value).toBe(0);
  });

  test("a script's renamed ref refuses to read its text", async () => {
    const { tab, follow } = await renamedFollow();
    const result = await call("run_script", {
      tab,
      code: `return await ref(${JSON.stringify(follow)}).textContent();`,
    });
    expect(result.text).toMatch(RENAMED);
  });

  test("a locator a script derives from a renamed ref does not click", async () => {
    const { tab, follow } = await renamedFollow();
    await call("run_script", {
      tab,
      code: `await ref(${JSON.stringify(follow)}).filter({ visible: true }).click({ timeout: 3000 });`,
    });
    expect(await actionsSoFar()).toEqual([]);
  });
});

const MOVED_TARGET = /name changed from "Hedef" to "Başka"/;

async function dragPage() {
  const tab = await open("/drag");
  const snapshot = await ok("snapshot", { tab });
  return {
    tab,
    source: refOf(snapshot, 'button "Kaynak"'),
    target: refOf(snapshot, 'button "Hedef"'),
    next: refOf(snapshot, 'link "Sonraki"'),
  };
}

async function renamedTarget() {
  const page = await dragPage();
  await ok("evaluate", { tab: page.tab, expression: "t.textContent = 'Başka'; 1" });
  return page;
}

const script = (tab: string, code: string) => call("run_script", { tab, code });

const dragCode = (source: string, target: string) =>
  `await ${source}.dragTo(ref(${JSON.stringify(target)}), { timeout: 3000 });`;

describe("a ref a script passes to another locator follows the same rule", () => {
  test("a drag to a renamed target says its old and new name", async () => {
    const { tab, source, target } = await renamedTarget();
    const result = await script(tab, dragCode(`ref(${JSON.stringify(source)})`, target));
    expect(result.text).toMatch(MOVED_TARGET);
  });

  test("a drag to a renamed target does not drop on it", async () => {
    const { tab, source, target } = await renamedTarget();
    await script(tab, dragCode(`ref(${JSON.stringify(source)})`, target));
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a drag to a target after a hash change says the address changed", async () => {
    const { tab, target, next } = await dragPage();
    await ok("click", { tab, target: next });
    const result = await script(tab, dragCode(`page.locator("#s")`, target));
    expect(result.text).toMatch(/address changed from .*\/drag to .*\/drag#\/b/);
  });

  test("a drag to a target after a hash change does not drop on it", async () => {
    const { tab, target, next } = await dragPage();
    await ok("click", { tab, target: next });
    await script(tab, dragCode(`page.locator("#s")`, target));
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a drag between two unchanged refs drops on the target", async () => {
    const { tab, source, target } = await dragPage();
    await script(tab, dragCode(`ref(${JSON.stringify(source)})`, target));
    expect(await actionsSoFar()).toEqual(["drop Hedef"]);
  });

  test("a locator joined with a renamed ref by and refuses to click", async () => {
    const { tab, target } = await renamedTarget();
    const result = await script(
      tab,
      `await page.locator("button").and(ref(${JSON.stringify(target)})).click({ timeout: 3000 });`,
    );
    expect(result.text).toMatch(MOVED_TARGET);
  });

  test("a locator joined with a renamed ref by or refuses to click", async () => {
    const { tab, target } = await renamedTarget();
    const result = await script(
      tab,
      `await page.locator("#none").or(ref(${JSON.stringify(target)})).click({ timeout: 3000 });`,
    );
    expect(result.text).toMatch(MOVED_TARGET);
  });

  test("a locator filtered to have a renamed ref refuses to click", async () => {
    const { tab, target } = await renamedTarget();
    const result = await script(
      tab,
      `await page.locator("main").filter({ has: ref(${JSON.stringify(target)}) }).click({ timeout: 3000 });`,
    );
    expect(result.text).toMatch(MOVED_TARGET);
  });

  test("a locator filtered to lack a renamed ref refuses to click", async () => {
    const { tab, target } = await renamedTarget();
    const result = await script(
      tab,
      `await page.locator("button").filter({ hasNot: ref(${JSON.stringify(target)}) }).first().click({ timeout: 3000 });`,
    );
    expect(result.text).toMatch(MOVED_TARGET);
  });

  test("a locator inside a renamed ref's locator refuses to click", async () => {
    const { tab, target } = await renamedTarget();
    const result = await script(
      tab,
      `await page.locator("main").locator(ref(${JSON.stringify(target)})).click({ timeout: 3000 });`,
    );
    expect(result.text).toMatch(MOVED_TARGET);
  });
});

const ORDER_A_LEFT = /address changed from .*#\/order\/A/;

async function hashOrder() {
  const tab = await open("/hash#/order/A");
  const snapshot = await ok("snapshot", { tab });
  return { tab, cancel: refOf(snapshot, 'button "İptal et"'), main: refOf(snapshot, "- main") };
}

const toOrderB = `await page.evaluate(() => { location.hash = "#/order/B"; });`;

const resnappedCancel = (cancel: string) =>
  `const l = ref(${JSON.stringify(cancel)}); ${toOrderB} await snapshot(); await l.click({ timeout: 3000 });`;

async function cancelInJobAfterToolSnapshot() {
  const { tab, cancel } = await hashOrder();
  const started = await ok("run_script", {
    tab,
    background: true,
    code: `const l = ref(${JSON.stringify(cancel)}); await sleep(2500); await l.click({ timeout: 3000 });`,
  });
  await ok("evaluate", { tab, expression: "location.hash = '#/order/B'; 1" });
  await ok("snapshot", { tab });
  return call("run_script", { job: /job (j\d+)/.exec(started)?.[1] ?? "", wait: true });
}

const rowAfterHashChange = (main: string) =>
  `const rows = await ref(${JSON.stringify(main)}).getByRole("button").all(); ${toOrderB} await rows[0].click({ timeout: 3000 });`;

const renamedAfterAll = (follow: string) =>
  `const [l] = await ref(${JSON.stringify(follow)}).all(); await page.evaluate(() => { b.textContent = "Takibi bırak"; }); await l.click({ timeout: 3000 });`;

describe("a script's ref keeps the element it was taken for", () => {
  test("a script's ref after its own new snapshot and a hash change says the address changed", async () => {
    const { tab, cancel } = await hashOrder();
    expect((await script(tab, resnappedCancel(cancel))).text).toMatch(ORDER_A_LEFT);
  });

  test("a script's ref after its own new snapshot and a hash change does not cancel the next order", async () => {
    const { tab, cancel } = await hashOrder();
    await script(tab, resnappedCancel(cancel));
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a background script's ref after a tool snapshot and a hash change says the address changed", async () => {
    expect((await cancelInJobAfterToolSnapshot()).text).toMatch(ORDER_A_LEFT);
  });

  test("a background script's ref after a tool snapshot and a hash change does not cancel the next order", async () => {
    await cancelInJobAfterToolSnapshot();
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a row from all() of a ref's locator after a hash change says the address changed", async () => {
    const { tab, main } = await hashOrder();
    expect((await script(tab, rowAfterHashChange(main))).text).toMatch(ORDER_A_LEFT);
  });

  test("a row from all() of a ref's locator after a hash change does not cancel the next order", async () => {
    const { tab, main } = await hashOrder();
    await script(tab, rowAfterHashChange(main));
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a locator from a ref's all() renamed afterwards says its old and new name", async () => {
    const tab = await open("/toggle");
    const follow = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
    expect((await script(tab, renamedAfterAll(follow))).text).toMatch(RENAMED);
  });

  test("a locator from a ref's all() renamed afterwards does not click", async () => {
    const tab = await open("/toggle");
    const follow = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
    await script(tab, renamedAfterAll(follow));
    expect(await actionsSoFar()).toEqual([]);
  });

  for (const method of ["elementHandle", "elementHandles", "evaluateHandle", "normalize"])
    test(`${method} on a script's ref is refused with the ref to use instead`, async () => {
      const tab = await open("/toggle");
      const follow = refOf(await ok("snapshot", { tab }), 'button "Takip et"');
      const args = method === "evaluateHandle" ? "(element) => element" : "";
      const result = await script(tab, `await ref(${JSON.stringify(follow)}).${method}(${args});`);
      expect(result.text).toMatch(new RegExp(`${method} .*Use the ref itself`));
    });
});

async function shyFollow() {
  const tab = await open("/shy");
  return { tab, follow: refOf(await ok("snapshot", { tab }), 'button "Takip et"') };
}

describe("a script waiting on a ref follows the real element", () => {
  test("a locator derived from a ref is waited out as hidden once its button hides", async () => {
    const { tab, follow } = await shyFollow();
    const result = await script(
      tab,
      `await page.locator("#hide").click(); await ref(${JSON.stringify(follow)}).first().waitFor({ state: "hidden", timeout: 3000 }); return "hidden";`,
    );
    expect(result.structured?.value).toBe("hidden");
  });

  test("text inside a removed dialog's ref is waited out as hidden", async () => {
    const tab = await open("/saving");
    const dialog = refOf(await ok("snapshot", { tab }), 'dialog "Kayıt"');
    const result = await script(
      tab,
      `await page.locator("#rm").click(); await ref(${JSON.stringify(dialog)}).getByText("Kaydediliyor").waitFor({ state: "hidden", timeout: 5000 }); return "hidden";`,
    );
    expect(result.structured?.value).toBe("hidden");
  });

  test("a ref of a hidden but attached button is attached at once", async () => {
    const { tab, follow } = await shyFollow();
    const result = await script(
      tab,
      `await page.locator("#hide").click(); const start = Date.now(); await ref(${JSON.stringify(follow)}).waitFor({ state: "attached", timeout: 3000 }); return Date.now() - start;`,
    );
    expect(Number(result.structured?.value)).toBeLessThan(1000);
  });
});

const GONE = /is gone from the page/;

async function rowsWithFirstDeleted(include_diff = false) {
  const tab = await open("/rows");
  const snapshot = await ok("snapshot", { tab });
  await ok("click", { tab, target: refOf(snapshot, 'button "Sil 1"'), include_diff });
  return { tab, snapshot };
}

describe("a removed ref is refused as gone", () => {
  test("a redrawn row's ref says its button is gone right after the redraw", async () => {
    const { tab, snapshot } = await rowsWithFirstDeleted();
    const result = await call("click", {
      tab,
      target: refOf(snapshot, 'button "Sil 2"'),
      timeout_ms: 3000,
    });
    expect(result.text).toMatch(GONE);
  });

  test("a redrawn row's ref says its button is gone after a click with include_diff", async () => {
    const { tab, snapshot } = await rowsWithFirstDeleted(true);
    const result = await call("click", {
      tab,
      target: refOf(snapshot, 'button "Sil 2"'),
      timeout_ms: 3000,
    });
    expect(result.text).toMatch(GONE);
  });

  test("a redrawn row's ref says its button is gone after an earlier stale ref was refused", async () => {
    const { tab, snapshot } = await rowsWithFirstDeleted();
    await call("click", { tab, target: refOf(snapshot, 'button "Sil 3"'), timeout_ms: 3000 });
    const result = await call("click", {
      tab,
      target: refOf(snapshot, 'button "Sil 2"'),
      timeout_ms: 3000,
    });
    expect(result.text).toMatch(GONE);
  });

  test("a redrawn row's ref says its button is gone after a new snapshot", async () => {
    const { tab, snapshot } = await rowsWithFirstDeleted();
    await ok("snapshot", { tab });
    const result = await call("click", {
      tab,
      target: refOf(snapshot, 'button "Sil 2"'),
      timeout_ms: 3000,
    });
    expect(result.text).toMatch(GONE);
  });

  test("a button replaced by a copy is refused as gone and the copy is not clicked", async () => {
    const tab = await open("/reins");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Kopya"') });
    await Bun.sleep(500);
    const result = await call("click", {
      tab,
      target: refOf(snapshot, 'button "Sil"'),
      timeout_ms: 3000,
    });
    expect(result.text).toMatch(GONE);
  });

  test("a removed ref is refused within 1 s after a click with include_diff", async () => {
    const { tab, snapshot } = await rowsWithFirstDeleted(true);
    const sil = refOf(snapshot, 'button "Sil 2"');
    expect(await timed(() => call("click", { tab, target: sil, timeout_ms: 5000 }))).toBeLessThan(
      1000,
    );
  });
});

const RAW_SNAPSHOT = "await page.locator('#k').ariaSnapshot(); return 1";

describe("refs after a script took its own aria snapshot", () => {
  test("wait_for hidden on a visible ref does not say hidden", async () => {
    const tab = await open("/rm");
    const notice = refOf(await ok("snapshot", { tab }), 'button "Bildirim"');
    await ok("run_script", { tab, code: RAW_SNAPSHOT });
    expect(await waitedFor(tab, notice, "hidden", 1500)).not.toBe(`${notice} is hidden.`);
  });

  test("wait_for detached on an attached ref does not say detached", async () => {
    const tab = await open("/rm");
    const notice = refOf(await ok("snapshot", { tab }), 'button "Bildirim"');
    await ok("run_script", { tab, code: RAW_SNAPSHOT });
    expect(await waitedFor(tab, notice, "detached", 1500)).not.toBe(`${notice} is detached.`);
  });

  test("a click on a ref hidden for a moment waits for it and clicks", async () => {
    const tab = await open("/rm");
    const notice = refOf(await ok("snapshot", { tab }), 'button "Bildirim"');
    await ok("run_script", { tab, code: RAW_SNAPSHOT });
    await ok("evaluate", {
      tab,
      expression: "x.hidden = true; setTimeout(() => { x.hidden = false; }, 1500); 1",
    });
    await call("click", { tab, target: notice });
    expect(await actionsSoFar()).toEqual(["x"]);
  });
});

describe("wait_for after an action on the same snapshot", () => {
  test("wait_for finds another visible ref after a ref action", async () => {
    const tab = await open("/rs");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Yenile"') });
    const heading = refOf(snapshot, "heading");
    expect(await waitedFor(tab, heading, "visible", 2000)).toBe(`${heading} is visible.`);
  });

  test("wait_for hidden on another visible ref after a ref action does not say hidden", async () => {
    const tab = await open("/rs");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: refOf(snapshot, 'button "Yenile"') });
    const heading = refOf(snapshot, "heading");
    expect(await waitedFor(tab, heading, "hidden", 1000)).not.toBe(`${heading} is hidden.`);
  });

  test("wait_for finds another visible ref after a selector action", async () => {
    const tab = await open("/two");
    const snapshot = await ok("snapshot", { tab });
    await ok("click", { tab, target: "#a" });
    const second = refOf(snapshot, 'button "İkinci"');
    expect(await waitedFor(tab, second, "visible", 2000)).toBe(`${second} is visible.`);
  });
});

const ROUNDS = Array.from({ length: 15 }, (_, round) => round);

const COLLECT_GARBAGE = `const cdp = await page.context().newCDPSession(page);
await cdp.send("HeapProfiler.enable");
for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
await cdp.detach();
return 1;`;

async function hoverTook(tab: string, target: string) {
  const took = await inSequence([0, 1, 2], () => timed(() => ok("hover", { tab, target })));
  return Math.min(...took);
}

const unchangedKinds = [
  { kind: "a generic with a pointer cursor", label: "Kutu", act: "generic" },
  { kind: "a generic with an aria-label", label: 'generic "Etiketli kutu"', act: "labeled" },
  { kind: "a generic with a title", label: 'generic "Başlıklı kutu"', act: "titled" },
  { kind: "a cell holding buttons", label: "- cell [ref=", act: "cell" },
  { kind: "a button with a long name", label: 'button "Uzun ad', act: "long" },
  { kind: "a button with quotes, a backslash, a colon and spaces", label: "tırnak", act: "quoted" },
  { kind: "a button with hidden child text", label: 'button "Görünen"', act: "hidden-child" },
  { kind: "an aria-hidden but visible button", label: "Gizli ama görünür", act: "aria-hidden" },
  { kind: "a button named by aria-labelledby", label: 'button "Etiket metni"', act: "labelledby" },
  { kind: "an icon button", label: "- button [ref=", act: "icon" },
];

async function kindsRef(label: string) {
  const tab = await open("/kinds");
  await Bun.sleep(300);
  return { tab, target: refOf(await ok("snapshot", { tab }), label) };
}

describe("an unchanged ref is not refused", () => {
  for (const { kind, label, act } of unchangedKinds) {
    test(`a click on ${kind} acts on it`, async () => {
      const { tab, target } = await kindsRef(label);
      await call("click", { tab, target, timeout_ms: 3000 });
      expect(await actionsSoFar()).toEqual([act]);
    });

    test(`a script read through ${kind} is not refused`, async () => {
      const { tab, target } = await kindsRef(label);
      const read = await script(tab, `return await ref(${JSON.stringify(target)}).textContent();`);
      expect(read.isError).toBe(false);
    });
  }

  test("a click on an iframe is not refused", async () => {
    const { tab, target } = await kindsRef("- iframe");
    expect((await call("click", { tab, target, timeout_ms: 3000 })).isError).toBe(false);
  });

  test("a script read through an iframe is not refused", async () => {
    const { tab, target } = await kindsRef("- iframe");
    const read = await script(tab, `return await ref(${JSON.stringify(target)}).textContent();`);
    expect(read.isError).toBe(false);
  });
});

async function frameRef() {
  const tab = await open("/frame");
  await Bun.sleep(500);
  return { tab, frame: refOf(await ok("snapshot", { tab, scope: "full" }), "- iframe") };
}

const clickInFrame = (frame: string, reload: boolean, derive = "") =>
  `${reload ? `await page.evaluate(() => { f.src = "/inner-button?w=B"; }); await sleep(800);` : ""} await ref(${JSON.stringify(frame)})${derive}.contentFrame().getByRole("button").click({ timeout: 3000 }); return "clicked";`;

describe("a locator inside a ref's iframe keeps the iframe's page", () => {
  test("a click inside an iframe ref's contentFrame() after the iframe loaded another page says so", async () => {
    const { tab, frame } = await frameRef();
    expect((await script(tab, clickInFrame(frame, true))).text).toMatch(
      /its iframe loaded a new page since the snapshot/,
    );
  });

  test("a click inside an iframe ref's contentFrame() after the iframe loaded another page does not click", async () => {
    const { tab, frame } = await frameRef();
    await script(tab, clickInFrame(frame, true));
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a click inside an iframe ref's contentFrame() on the same page clicks", async () => {
    const { tab, frame } = await frameRef();
    await script(tab, clickInFrame(frame, false));
    expect(await actionsSoFar()).toEqual(["inner A"]);
  });
});

describe("a locator derived from an iframe ref keeps the iframe's page", () => {
  for (const derive of [
    ".first()",
    ".nth(0)",
    ".last()",
    ".filter({ visible: true })",
    '.or(page.locator("#none"))',
    '.locator(":scope")',
  ])
    test(`a click inside an iframe ref's ${derive}.contentFrame() after the iframe loaded another page does not click`, async () => {
      const { tab, frame } = await frameRef();
      await script(tab, clickInFrame(frame, true, derive));
      expect(await actionsSoFar()).toEqual([]);
    });

  test("a click inside an iframe ref's first().contentFrame() after the iframe loaded another page says so", async () => {
    const { tab, frame } = await frameRef();
    expect((await script(tab, clickInFrame(frame, true, ".first()"))).text).toMatch(
      /its iframe loaded a new page since the snapshot/,
    );
  });

  test("a click inside an iframe ref's first().contentFrame() on the same page clicks", async () => {
    const { tab, frame } = await frameRef();
    await script(tab, clickInFrame(frame, false, ".first()"));
    expect(await actionsSoFar()).toEqual(["inner A"]);
  });
});

const renamedGenerics = [
  {
    kind: "aria-label",
    label: 'generic "Etiketli kutu"',
    rename: `document.querySelector('[aria-label="Etiketli kutu"]').setAttribute('aria-label', 'Başka kutu')`,
    changed: /name changed from "Etiketli kutu" to "Başka kutu"/,
  },
  {
    kind: "title",
    label: 'generic "Başlıklı kutu"',
    rename: `document.querySelector('[title="Başlıklı kutu"]').setAttribute('title', 'Başka başlık')`,
    changed: /name changed from "Başlıklı kutu" to "Başka başlık"/,
  },
];

async function renamedGeneric(label: string, rename: string) {
  const { tab, target } = await kindsRef(label);
  await ok("evaluate", { tab, expression: `${rename}; 1` });
  return { tab, target };
}

describe("a generic named by an attribute is checked by its name", () => {
  for (const { kind, label, rename, changed } of renamedGenerics) {
    test(`a click on a generic whose ${kind} changed says its old and new name`, async () => {
      const { tab, target } = await renamedGeneric(label, rename);
      expect((await call("click", { tab, target, timeout_ms: 3000 })).text).toMatch(changed);
    });

    test(`a click on a generic whose ${kind} changed does not click`, async () => {
      const { tab, target } = await renamedGeneric(label, rename);
      await call("click", { tab, target, timeout_ms: 3000 });
      expect(await actionsSoFar()).toEqual([]);
    });

    test(`a script read through a generic whose ${kind} changed is refused`, async () => {
      const { tab, target } = await renamedGeneric(label, rename);
      const read = await script(tab, `return await ref(${JSON.stringify(target)}).textContent();`);
      expect(read.text).toMatch(changed);
    });
  }
});

async function dialogShownAgain(rename: string) {
  const tab = await open("/order-dialog");
  const dialog = refOf(await ok("snapshot", { tab }), 'dialog "Sipariş A"');
  await ok("evaluate", {
    tab,
    expression: `d.style.display = 'none'; setTimeout(() => { ${rename} d.style.display = ''; }, 1000); 1`,
  });
  return { tab, dialog };
}

const RENAMED_DIALOG = "d.setAttribute('aria-label', 'Sipariş B');";

const deleteInDialog = (dialog: string) =>
  `await ref(${JSON.stringify(dialog)}).getByRole("button", { name: "Sil" }).click({ timeout: 5000 }); return "clicked";`;

async function hiddenWhile(change: string) {
  const tab = await open("/order-dialog");
  const snapshot = await ok("snapshot", { tab });
  await ok("evaluate", { tab, expression: `d.style.display = 'none'; ${change} 1` });
  return {
    tab,
    dialog: refOf(snapshot, 'dialog "Sipariş A"'),
    button: refOf(snapshot, 'button "Sil"'),
  };
}

const HIDDEN_UNCONFIRMED = /cannot be used: its (button "Sil"|dialog "Sipariş A") is hidden/;

describe("a hidden ref is checked by its name", () => {
  test("a click inside a dialog ref renamed while hidden says its old and new name", async () => {
    const { tab, dialog } = await dialogShownAgain(RENAMED_DIALOG);
    expect((await script(tab, deleteInDialog(dialog))).text).toMatch(
      /name changed from "Sipariş A" to "Sipariş B"/,
    );
  });

  test("a click inside a dialog ref renamed while hidden does not click", async () => {
    const { tab, dialog } = await dialogShownAgain(RENAMED_DIALOG);
    await script(tab, deleteInDialog(dialog));
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a click inside a dialog ref hidden for a moment clicks once it shows", async () => {
    const { tab, dialog } = await dialogShownAgain("");
    await script(tab, deleteInDialog(dialog));
    expect(await actionsSoFar()).toEqual(["delete Sipariş A"]);
  });

  test("a read of a button ref renamed while hidden is refused", async () => {
    const { tab, button } = await hiddenWhile("b.textContent = 'Onayla';");
    const read = await script(tab, `return await ref(${JSON.stringify(button)}).textContent();`);
    expect(read.text).toMatch(HIDDEN_UNCONFIRMED);
  });

  test("isVisible on a button ref renamed while hidden answers false", async () => {
    const { tab, button } = await hiddenWhile("b.textContent = 'Onayla';");
    const read = await script(tab, `return await ref(${JSON.stringify(button)}).isVisible();`);
    expect(read.structured?.value).toBe(false);
  });

  test("a read inside a dialog ref renamed while hidden is refused", async () => {
    const { tab, dialog } = await hiddenWhile(RENAMED_DIALOG);
    const read = await script(
      tab,
      `return await ref(${JSON.stringify(dialog)}).getByRole("button", { includeHidden: true }).textContent();`,
    );
    expect(read.text).toMatch(HIDDEN_UNCONFIRMED);
  });

  test("a read of a hidden menu item ref whose name skips an aria-hidden icon says its name cannot be checked", async () => {
    const tab = await open("/icon-menu?n=10");
    const target = refOf(await ok("snapshot", { tab, query: "Kopyala" }), 'menuitem "Kopyala"');
    await ok("evaluate", { tab, expression: "m.style.display = 'none'; 1" });
    const read = await script(tab, `return await ref(${JSON.stringify(target)}).textContent();`);
    expect(read.text).toMatch(/its menuitem "Kopyala" is hidden, so its name cannot be checked/);
  });

  test("a read of a hidden unchanged button ref returns its text", async () => {
    const { tab, button } = await hiddenWhile("");
    const read = await script(tab, `return await ref(${JSON.stringify(button)}).textContent();`);
    expect(read.structured?.value).toBe("Sil");
  });

  test("a read inside a hidden unchanged dialog ref returns its text", async () => {
    const { tab, dialog } = await hiddenWhile("");
    const read = await script(
      tab,
      `return await ref(${JSON.stringify(dialog)}).getByRole("button", { includeHidden: true }).textContent();`,
    );
    expect(read.structured?.value).toBe("Sil");
  });
});

const hiddenParts = [
  {
    kind: "a menu item whose name skips an aria-hidden icon",
    path: "/icon-menu?n=10",
    label: 'menuitem "Kopyala"',
    hide: "m.style.display = 'none';",
    rename: "mi.lastChild.textContent = ' Yapıştır';",
  },
  {
    kind: "a button whose name skips a display:none part",
    path: "/hidden-parts",
    label: 'button "Kaydet"',
    hide: "w.style.display = 'none';",
    rename: "rb.firstChild.textContent = 'Sil';",
  },
  {
    kind: "a generic named by its aria-label",
    path: "/hidden-parts",
    label: 'generic "Bildirimler"',
    hide: "w.style.display = 'none';",
    rename: "ng.setAttribute('aria-label', 'Mesajlar');",
  },
];

async function hiddenPart(path: string, label: string, change: string) {
  const tab = await open(path);
  const target = refOf(await ok("snapshot", { tab }), label);
  await ok("evaluate", { tab, expression: `${change} 1` });
  return { tab, target };
}

describe("a hidden ref answers whether it is shown", () => {
  for (const { kind, path, label, hide, rename } of hiddenParts) {
    test(`isVisible on ${kind} hidden afterwards answers false`, async () => {
      const { tab, target } = await hiddenPart(path, label, hide);
      const read = await script(tab, `return await ref(${JSON.stringify(target)}).isVisible();`);
      expect(read.structured?.value).toBe(false);
    });

    test(`isHidden on ${kind} hidden afterwards answers true`, async () => {
      const { tab, target } = await hiddenPart(path, label, hide);
      const read = await script(tab, `return await ref(${JSON.stringify(target)}).isHidden();`);
      expect(read.structured?.value).toBe(true);
    });

    test(`a read of ${kind} renamed while hidden is refused`, async () => {
      const { tab, target } = await hiddenPart(path, label, `${hide} ${rename}`);
      const read = await script(tab, `return await ref(${JSON.stringify(target)}).textContent();`);
      expect(read.text).toMatch(/Ref \w+ cannot be used/);
    });
  }
});

async function savingButton(change: string) {
  const tab = await open("/saving-button");
  const target = refOf(await ok("snapshot", { tab }), 'button "Kaydet"');
  await ok("evaluate", {
    tab,
    expression: `setTimeout(() => { ${change} b.disabled = false; }, 1000); 1`,
  });
  return { tab, target };
}

const RENAME_SAVE = "b.textContent = 'Sil';";

const clickWithin = (tab: string, target: string) =>
  call("click", { tab, target, timeout_ms: 5000 });

const scriptClickWithin = (tab: string, target: string) =>
  script(tab, `await ref(${JSON.stringify(target)}).click({ timeout: 5000 }); return "clicked";`);

async function orderWaiting(query: string, change: string) {
  const tab = await open(`/order-wait${query}`);
  const dialog = refOf(await ok("snapshot", { tab }), 'dialog "Sipariş A"');
  await ok("evaluate", {
    tab,
    expression: `setTimeout(() => { ${change} b.style.display = ''; b.disabled = false; }, 1000); 1`,
  });
  return { tab, dialog };
}

const waitingButtons = [
  { kind: "hidden", query: "" },
  { kind: "disabled", query: "?disabled=1" },
];

async function savingField(change: string) {
  const tab = await open("/saving-field");
  const target = refOf(await ok("snapshot", { tab }), 'textbox "Ad"');
  await ok("evaluate", {
    tab,
    expression: `setTimeout(() => { ${change} f.disabled = false; }, 1000); 1`,
  });
  return { tab, target };
}

describe("a ref whose element is ready later is acted on once it is ready", () => {
  test("a click on a button enabled later clicks it", async () => {
    const { tab, target } = await savingButton("");
    await clickWithin(tab, target);
    expect(await actionsSoFar()).toEqual(["Kaydet"]);
  });

  test("a click on a button enabled later names the button it clicked", async () => {
    const { tab, target } = await savingButton("");
    expect((await clickWithin(tab, target)).text).toContain(`Clicked button "Kaydet"`);
  });

  test("a human click on a button enabled later clicks it", async () => {
    const { tab, target } = await savingButton("");
    await call("click", { tab, target, timeout_ms: 5000, human: true });
    expect(await actionsSoFar()).toEqual(["Kaydet"]);
  });

  test("a script click on a button enabled later clicks it", async () => {
    const { tab, target } = await savingButton("");
    await scriptClickWithin(tab, target);
    expect(await actionsSoFar()).toEqual(["Kaydet"]);
  });

  for (const { kind, query } of waitingButtons)
    test(`a click inside an unchanged dialog ref clicks its ${kind} button once it is ready`, async () => {
      const { tab, dialog } = await orderWaiting(query, "");
      await script(tab, deleteInDialog(dialog));
      expect(await actionsSoFar()).toEqual(["delete Sipariş A"]);
    });

  test("a fill into a field enabled later types into it", async () => {
    const { tab, target } = await savingField("");
    await call("fill", { tab, target, value: "x" });
    expect(await actionsSoFar()).toEqual(["Ad"]);
  });

  test("a click through a ref shown late and a ref that stays hidden gives up within one timeout", async () => {
    const { tab, dialog, button } = await hiddenWhile(
      "b.style.display = 'none'; setTimeout(() => { d.style.display = ''; }, 1500);",
    );
    const took = await timed(() =>
      script(
        tab,
        `await ref(${JSON.stringify(dialog)}).locator(ref(${JSON.stringify(button)})).click({ timeout: 2000 });`,
      ),
    );
    expect(took).toBeLessThan(3000);
  });
});

describe("known limit: a ref renamed while its action waits for it to be ready reaches only its own element, once", () => {
  test("a click on a disabled button renamed before it is enabled clicks that button once", async () => {
    const { tab, target } = await savingButton(RENAME_SAVE);
    await clickWithin(tab, target);
    expect(await actionsSoFar()).toEqual(["Sil"]);
  });

  test("a human click on a disabled button renamed before it is enabled clicks that button once", async () => {
    const { tab, target } = await savingButton(RENAME_SAVE);
    await call("click", { tab, target, timeout_ms: 5000, human: true });
    expect(await actionsSoFar()).toEqual(["Sil"]);
  });

  test("a script click on a disabled button renamed before it is enabled clicks that button once", async () => {
    const { tab, target } = await savingButton(RENAME_SAVE);
    await scriptClickWithin(tab, target);
    expect(await actionsSoFar()).toEqual(["Sil"]);
  });

  for (const { kind, query } of waitingButtons)
    test(`a click inside a dialog ref renamed while its ${kind} button waits clicks that button once`, async () => {
      const { tab, dialog } = await orderWaiting(query, RENAMED_DIALOG);
      await script(tab, deleteInDialog(dialog));
      expect(await actionsSoFar()).toEqual(["delete Sipariş B"]);
    });

  test("a fill into a disabled field renamed before it is enabled types into that field once", async () => {
    const { tab, target } = await savingField("l.textContent = 'Şifre';");
    await call("fill", { tab, target, value: "x" });
    expect(await actionsSoFar()).toEqual(["Şifre"]);
  });
});

const hiddenAlternatives = [
  {
    name: "ref(a).or(ref(b)).first()",
    chain: (a: string, b: string) => `ref(${a}).or(ref(${b})).first()`,
  },
  {
    name: "ref(b).or(ref(a)).first()",
    chain: (a: string, b: string) => `ref(${b}).or(ref(${a})).first()`,
  },
  {
    name: "a selector .or(ref(b)).first()",
    chain: (_a: string, b: string) =>
      `page.getByRole("button", { name: "Birinci" }).or(ref(${b})).first()`,
  },
  {
    name: "rows filtered to lack ref(b)",
    chain: (_a: string, b: string) =>
      `page.getByRole("row").filter({ hasNot: ref(${b}) }).getByRole("button")`,
  },
];

describe("a ref used only as an alternative or a filter does not have to be shown", () => {
  for (const { name, chain } of hiddenAlternatives)
    test(`a click through ${name} with b hidden clicks a`, async () => {
      const tab = await open("/two");
      const snapshot = await ok("snapshot", { tab });
      const a = JSON.stringify(refOf(snapshot, 'button "Birinci"'));
      const b = JSON.stringify(refOf(snapshot, 'button "İkinci"'));
      await ok("evaluate", { tab, expression: "b.style.display = 'none'; 1" });
      await script(tab, `await ${chain(a, b)}.click({ timeout: 3000 });`);
      expect(await actionsSoFar()).toEqual(["a"]);
    });
});

async function saveOrCancel(change: string, path = "/save-or-cancel") {
  const tab = await open(path);
  const snapshot = await ok("snapshot", { tab });
  const save = JSON.stringify(refOf(snapshot, 'button "Kaydet"'));
  const cancel = JSON.stringify(refOf(snapshot, 'button "Vazgeç"'));
  await ok("evaluate", { tab, expression: `${change} 1` });
  const both = `ref(${save}).or(ref(${cancel}))`;
  return { tab, save, both, either: `${both}.first()` };
}

const HIDDEN_SAVE =
  /^Ref \w+ cannot be used: its button "Kaydet" is hidden, so its name cannot be checked\./;

describe("a ref inside or() is acted on and read only under its own name", () => {
  test("a click through or() after main was hidden from assistive tech and the first ref renamed clicks nothing", async () => {
    const { tab, either } = await saveOrCancel(
      "document.querySelector('main').setAttribute('aria-hidden', 'true'); a.textContent = 'Sil';",
    );
    await script(tab, `await ${either}.click({ timeout: 2000 });`);
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a click through or() whose first ref was hidden from assistive tech and renamed clicks the other ref", async () => {
    const { tab, either } = await saveOrCancel(
      "a.setAttribute('aria-hidden', 'true'); a.textContent = 'Sil';",
    );
    await script(tab, `await ${either}.click({ timeout: 3000 });`);
    expect(await actionsSoFar()).toEqual(["Vazgeç"]);
  });

  test("a click through or() whose first ref was renamed while hidden and then shown clicks the other ref", async () => {
    const { tab, either } = await saveOrCancel(
      "a.style.display = 'none'; a.textContent = 'Sil'; setTimeout(() => { a.style.display = ''; }, 700);",
    );
    await script(tab, `await ${either}.click({ timeout: 4000 });`);
    expect(await actionsSoFar()).toEqual(["Vazgeç"]);
  });

  test("a read through or() whose first ref was renamed while hidden says its name cannot be checked", async () => {
    const { tab, either } = await saveOrCancel("a.style.display = 'none'; a.textContent = 'Sil';");
    const read = await script(tab, `return await ${either}.textContent();`);
    expect(read.text).toMatch(HIDDEN_SAVE);
  });

  test("a read through or() whose first ref was hidden from assistive tech and renamed is refused", async () => {
    const { tab, either } = await saveOrCancel(
      "a.setAttribute('aria-hidden', 'true'); a.textContent = 'Sil';",
    );
    const read = await script(tab, `return await ${either}.textContent();`);
    expect(read.text).toMatch(/^Ref \w+ cannot be used: its button/);
  });

  test("a click through or() whose first ref is hidden clicks the shown one", async () => {
    const { tab, either } = await saveOrCancel("a.style.display = 'none';");
    await script(tab, `await ${either}.click({ timeout: 3000 });`);
    expect(await actionsSoFar()).toEqual(["Vazgeç"]);
  });

  test("a click through or() on a button relabeled on hover clicks it", async () => {
    const tab = await open("/hover-label");
    const snapshot = await ok("snapshot", { tab });
    const follow = JSON.stringify(refOf(snapshot, 'button "Takip ediliyor"'));
    const other = JSON.stringify(refOf(snapshot, 'button "Başka"'));
    await script(tab, `await ref(${follow}).or(ref(${other})).first().click({ timeout: 3000 });`);
    expect(await actionsSoFar()).toEqual(["follow"]);
  });
});

async function orderRows() {
  const tab = await open("/order-rows");
  const snapshot = await ok("snapshot", { tab });
  return {
    tab,
    first: JSON.stringify(refOf(snapshot, 'cell "Sipariş A"')),
    second: JSON.stringify(refOf(snapshot, 'cell "Sipariş C"')),
  };
}

describe("a ref inside filter() keeps only the elements that hold it", () => {
  test("a click on the button of the row that has the second cell clicks that row", async () => {
    const { tab, second } = await orderRows();
    await script(
      tab,
      `await page.getByRole("row").filter({ has: ref(${second}) }).getByRole("button").click({ timeout: 3000 });`,
    );
    expect(await actionsSoFar()).toEqual(["row2"]);
  });

  test("a click on the button of the row that lacks the first cell clicks the second row", async () => {
    const { tab, first } = await orderRows();
    await script(
      tab,
      `await page.getByRole("row").filter({ hasNot: ref(${first}) }).getByRole("button").click({ timeout: 3000 });`,
    );
    expect(await actionsSoFar()).toEqual(["row2"]);
  });

  test("the second row filtered to have the first row's cell counts none", async () => {
    const { tab, first } = await orderRows();
    const counted = await script(
      tab,
      `return await page.locator("#r2").filter({ has: ref(${first}) }).count();`,
    );
    expect(counted.structured?.value).toBe(0);
  });

  test("rows filtered to lack the first cell count one", async () => {
    const { tab, first } = await orderRows();
    const counted = await script(
      tab,
      `return await page.getByRole("row").filter({ hasNot: ref(${first}) }).count();`,
    );
    expect(counted.structured?.value).toBe(1);
  });

  test("a click on the button of the row whose cell was renamed while hidden does not click it once shown", async () => {
    const { tab, first } = await orderRows();
    await ok("evaluate", {
      tab,
      expression:
        "r1.style.display = 'none'; c1.textContent = 'Sipariş X'; setTimeout(() => { r1.style.display = ''; }, 700); 1",
    });
    await script(
      tab,
      `await page.getByRole("row").filter({ has: ref(${first}) }).getByRole("button").click({ timeout: 2500 });`,
    );
    expect(await actionsSoFar()).toEqual([]);
  });

  test("rows filtered to lack a cell hidden from assistive tech are refused", async () => {
    const { tab, first } = await orderRows();
    await ok("evaluate", { tab, expression: "c1.setAttribute('aria-hidden', 'true'); 1" });
    const counted = await script(
      tab,
      `return await page.getByRole("row").filter({ hasNot: ref(${first}) }).count();`,
    );
    expect(counted.text).toMatch(/^Ref \w+ cannot be used: its cell/);
  });
});

const WAIT_TIMED_OUT = /^Nothing matched .+ to be visible within 1\.5 s\./;
const CLICK_TIMED_OUT = /^Nothing matched .+\.first\(\) within 1\.5 s\./;

describe("a ref inside or() whose elements are both hidden is answered like a plain locator", () => {
  const bothHidden = "a.style.display = 'none'; b.style.display = 'none';";

  test("isVisible through or() answers false", async () => {
    const { tab, either } = await saveOrCancel(bothHidden);
    const read = await script(tab, `return await ${either}.isVisible();`);
    expect(read.structured?.value).toBe(false);
  });

  test("count through or() counts both", async () => {
    const { tab, both } = await saveOrCancel(bothHidden);
    const read = await script(tab, `return await ${both}.count();`);
    expect(read.structured?.value).toBe(2);
  });

  test("a wait for attached through or() resolves", async () => {
    const { tab, either } = await saveOrCancel(bothHidden);
    const read = await script(
      tab,
      `await ${either}.waitFor({ state: "attached", timeout: 3000 }); return 1;`,
    );
    expect(read.structured?.value).toBe(1);
  });

  test("a wait for visible through or() resolves once the other ref shows", async () => {
    const { tab, either } = await saveOrCancel(
      `${bothHidden} setTimeout(() => { b.style.display = ''; }, 700);`,
    );
    const read = await script(tab, `await ${either}.waitFor({ timeout: 4000 }); return 1;`);
    expect(read.structured?.value).toBe(1);
  });

  test("a wait for visible through or() times out", async () => {
    const { tab, either } = await saveOrCancel(bothHidden);
    const read = await script(tab, `await ${either}.waitFor({ timeout: 1500 }); return 1;`);
    expect(read.text).toMatch(WAIT_TIMED_OUT);
  });

  test("a click through or() times out", async () => {
    const { tab, either } = await saveOrCancel(bothHidden);
    const read = await script(tab, `await ${either}.click({ timeout: 1500 }); return 1;`);
    expect(read.text).toMatch(CLICK_TIMED_OUT);
  });
});

describe("a ref chain inside or() matches only while its ref holds", () => {
  test("a click through a hidden ref chain or() a shown ref clicks the shown ref", async () => {
    const tab = await open("/chain-or");
    const snapshot = await ok("snapshot", { tab });
    const tamam = JSON.stringify(refOf(snapshot, 'button "Tamam"'));
    const cancel = JSON.stringify(refOf(snapshot, 'button "Vazgeç"'));
    await ok("evaluate", { tab, expression: "c.style.display = 'none'; 1" });
    await script(
      tab,
      `await ref(${tamam}).locator("xpath=.").or(ref(${cancel})).first().click({ timeout: 3000 });`,
    );
    expect(await actionsSoFar()).toEqual(["b"]);
  });

  test("a click through a removed named generic or() a shown ref clicks the shown ref", async () => {
    const tab = await open("/labeled-or");
    const snapshot = await ok("snapshot", { tab });
    const labeled = JSON.stringify(refOf(snapshot, 'generic "Etiketli kutu"'));
    const cancel = JSON.stringify(refOf(snapshot, 'button "Vazgeç"'));
    await ok("evaluate", { tab, expression: "g.remove(); 1" });
    await script(tab, `await ref(${labeled}).or(ref(${cancel})).first().click({ timeout: 3000 });`);
    expect(await actionsSoFar()).toEqual(["b"]);
  });
});

describe("a ref removed from the page is lacked by every element", () => {
  test("rows filtered to lack a removed cell count every row", async () => {
    const { tab, first } = await orderRows();
    await ok("evaluate", { tab, expression: "c1.remove(); 1" });
    const counted = await script(
      tab,
      `return await page.getByRole("row").filter({ hasNot: ref(${first}) }).count();`,
    );
    expect(counted.structured?.value).toBe(2);
  });

  test("a click on the first row lacking a cell whose row was removed clicks the remaining row", async () => {
    const { tab, first } = await orderRows();
    await ok("evaluate", { tab, expression: "r1.remove(); 1" });
    await script(
      tab,
      `await page.getByRole("row").filter({ hasNot: ref(${first}) }).first().getByRole("button").click({ timeout: 3000 });`,
    );
    expect(await actionsSoFar()).toEqual(["row2"]);
  });
});

describe("a hidden ref whose role holds is present through has and or", () => {
  test("rows filtered to have a hidden cell count its row", async () => {
    const { tab, first } = await orderRows();
    await ok("evaluate", { tab, expression: "c1.style.display = 'none'; 1" });
    const counted = await script(
      tab,
      `return await page.getByRole("row").filter({ has: ref(${first}) }).count();`,
    );
    expect(counted.structured?.value).toBe(1);
  });

  test("a wait for attached on main filtered to have a hidden button resolves", async () => {
    const tab = await open("/save-or-cancel");
    const save = JSON.stringify(refOf(await ok("snapshot", { tab }), 'button "Kaydet"'));
    await ok("evaluate", { tab, expression: "a.style.display = 'none'; 1" });
    const read = await script(
      tab,
      `await page.locator("main").filter({ has: ref(${save}) }).waitFor({ state: "attached", timeout: 3000 }); return 1;`,
    );
    expect(read.structured?.value).toBe(1);
  });

  test("a wait for hidden through or() with the first ref hidden resolves", async () => {
    const { tab, either } = await saveOrCancel("a.style.display = 'none';");
    const read = await script(
      tab,
      `await ${either}.waitFor({ state: "hidden", timeout: 1500 }); return 1;`,
    );
    expect(read.structured?.value).toBe(1);
  });

  test("count through or() with the first ref hidden counts both", async () => {
    const { tab, both } = await saveOrCancel("a.style.display = 'none';");
    const read = await script(tab, `return await ${both}.count();`);
    expect(read.structured?.value).toBe(2);
  });
});

describe("a ref chain with a hidden side lists the elements it counts", () => {
  const firstHidden = "a.style.display = 'none';";

  test("all() through or() with the first ref hidden gives both", async () => {
    const { tab, both } = await saveOrCancel(firstHidden);
    const read = await script(tab, `return (await ${both}.all()).length;`);
    expect(read.structured?.value).toBe(2);
  });

  test("the second element through or() with the first ref hidden reads the shown ref", async () => {
    const { tab, both } = await saveOrCancel(firstHidden);
    const read = await script(tab, `return await ${both}.nth(1).textContent({ timeout: 3000 });`);
    expect(read.structured?.value).toBe("Vazgeç");
  });

  test("the first element through or() with the first ref hidden reads the hidden ref", async () => {
    const { tab, either } = await saveOrCancel(firstHidden);
    const read = await script(tab, `return await ${either}.textContent({ timeout: 3000 });`);
    expect(read.structured?.value).toBe("Kaydet");
  });

  test("allTextContents through or() with the first ref hidden reads both", async () => {
    const { tab, both } = await saveOrCancel(firstHidden);
    const read = await script(tab, `return await ${both}.allTextContents();`);
    expect(read.structured?.value).toEqual(["Kaydet", "Vazgeç"]);
  });

  test("a read of the row filtered to have a hidden cell reads that row", async () => {
    const { tab, first } = await orderRows();
    await ok("evaluate", { tab, expression: "c1.style.display = 'none'; 1" });
    const read = await script(
      tab,
      `return await page.getByRole("row").filter({ has: ref(${first}) }).getByRole("button").textContent({ timeout: 3000 });`,
    );
    expect(read.structured?.value).toBe("Sil");
  });

  test("a click on the button of the row filtered to have a hidden cell clicks that row", async () => {
    const { tab, first } = await orderRows();
    await ok("evaluate", { tab, expression: "c1.style.display = 'none'; 1" });
    await script(
      tab,
      `await page.getByRole("row").filter({ has: ref(${first}) }).getByRole("button").click({ timeout: 3000 });`,
    );
    expect(await actionsSoFar()).toEqual(["row1"]);
  });
});

describe("a ref chain lists its elements in the page's own script world", () => {
  test("allTextContents of a ref reads its text", async () => {
    const { tab, save } = await saveOrCancel("");
    const read = await script(tab, `return await ref(${save}).allTextContents();`);
    expect(read.structured?.value).toEqual(["Kaydet"]);
  });

  test("allInnerTexts through or() reads both", async () => {
    const { tab, both } = await saveOrCancel("");
    const read = await script(tab, `return await ${both}.allInnerTexts();`);
    expect(read.structured?.value).toEqual(["Kaydet", "Vazgeç"]);
  });

  test("evaluateAll through or() passes both elements and the argument", async () => {
    const { tab, both } = await saveOrCancel("");
    const read = await script(
      tab,
      `return await ${both}.evaluateAll((elements, mark) => elements.map((element) => element.id + mark), "!");`,
    );
    expect(read.structured?.value).toEqual(["a!", "b!"]);
  });

  test("evaluateAll on main filtered to have a ref passes main", async () => {
    const { tab, save } = await saveOrCancel("");
    const read = await script(
      tab,
      `return await page.locator("main").filter({ has: ref(${save}) }).evaluateAll((elements) => elements.map((element) => element.tagName));`,
    );
    expect(read.structured?.value).toEqual(["MAIN"]);
  });

  test("evaluateAll through or() of two removed refs passes no elements", async () => {
    const { tab, both } = await saveOrCancel("a.remove(); b.remove();");
    const read = await script(
      tab,
      `return await ${both}.evaluateAll((elements) => elements.length);`,
    );
    expect(read.structured?.value).toBe(0);
  });
});

const CLOSED_ROOT = "/save-or-cancel-closed";

describe("a ref chain on a page with a closed shadow root finds its elements", () => {
  test("count through or() counts both", async () => {
    const { tab, both } = await saveOrCancel("", CLOSED_ROOT);
    const read = await script(tab, `return await ${both}.count();`);
    expect(read.structured?.value).toBe(2);
  });

  test("all() through or() gives both", async () => {
    const { tab, both } = await saveOrCancel("", CLOSED_ROOT);
    const read = await script(tab, `return (await ${both}.all()).length;`);
    expect(read.structured?.value).toBe(2);
  });

  test("allTextContents through or() reads both", async () => {
    const { tab, both } = await saveOrCancel("", CLOSED_ROOT);
    const read = await script(tab, `return await ${both}.allTextContents();`);
    expect(read.structured?.value).toEqual(["Kaydet", "Vazgeç"]);
  });

  test("count of a hidden ref or() a selector that matches nothing counts the hidden ref", async () => {
    const { tab, save } = await saveOrCancel("a.style.display = 'none';", CLOSED_ROOT);
    const read = await script(tab, `return await ref(${save}).or(page.locator("#none")).count();`);
    expect(read.structured?.value).toBe(1);
  });
});

async function framedTamam() {
  const tab = await open("/frame");
  await Bun.sleep(500);
  const snapshot = await ok("snapshot", { tab, scope: "full" });
  return { tab, tamam: JSON.stringify(refOf(snapshot, 'button "Tamam"')) };
}

describe("a ref inside an iframe filters a locator reached through frameLocator()", () => {
  test("the iframe's body filtered to have the ref counts one", async () => {
    const { tab, tamam } = await framedTamam();
    const read = await script(
      tab,
      `return await page.frameLocator("#f").locator("body").filter({ has: ref(${tamam}) }).count();`,
    );
    expect(read.structured?.value).toBe(1);
  });

  test("a click on the button of the iframe's body filtered to have the ref clicks it", async () => {
    const { tab, tamam } = await framedTamam();
    await script(
      tab,
      `await page.frameLocator("#f").locator("body").filter({ has: ref(${tamam}) }).getByRole("button").click({ timeout: 3000 });`,
    );
    expect(await actionsSoFar()).toEqual(["inner A"]);
  });

  test("the iframe's body filtered to lack the ref counts none", async () => {
    const { tab, tamam } = await framedTamam();
    const read = await script(
      tab,
      `return await page.frameLocator("#f").locator("body").filter({ hasNot: ref(${tamam}) }).count();`,
    );
    expect(read.structured?.value).toBe(0);
  });
});

async function shownTamam() {
  const tab = await open("/frame");
  await Bun.sleep(500);
  const shown = await ok("hover", { tab, target: "#f >> internal:control=enter-frame >> button" });
  const tamam = /^Hovering button "Tamam" \((\w+), from/.exec(shown)?.[1];
  expect(tamam, shown).toMatch(/^f\d+e\d+$/);
  return { tab, tamam: JSON.stringify(tamam) };
}

describe("a ref an action showed inside an iframe filters a locator reached through frameLocator()", () => {
  test("the iframe's body filtered to have the ref counts one", async () => {
    const { tab, tamam } = await shownTamam();
    const read = await script(
      tab,
      `return await page.frameLocator("#f").locator("body").filter({ has: ref(${tamam}) }).count();`,
    );
    expect(read.structured?.value).toBe(1);
  });

  test("the iframe's body filtered to lack the ref counts none", async () => {
    const { tab, tamam } = await shownTamam();
    const read = await script(
      tab,
      `return await page.frameLocator("#f").locator("body").filter({ hasNot: ref(${tamam}) }).count();`,
    );
    expect(read.structured?.value).toBe(0);
  });
});

async function twoFramedButtons() {
  const tab = await open("/two-frames");
  await Bun.sleep(500);
  const snapshot = await ok("snapshot", { tab, scope: "full" });
  return {
    tab,
    first: JSON.stringify(refOf(snapshot, 'button "Tamam"')),
    second: JSON.stringify(refOf(snapshot, 'button "Tamam"', 1)),
    frame: JSON.stringify(refOf(snapshot, "iframe")),
  };
}

const ONE_FRAME = /^Refs \w+ and \w+ cannot be joined with or\(\): they are in different frames\./;

describe("or() joins refs from one frame only", () => {
  test("a count through or() of refs in two iframes says or() needs refs from one frame", async () => {
    const { tab, first, second } = await twoFramedButtons();
    const read = await script(tab, `return await ref(${first}).or(ref(${second})).count();`);
    expect(read.text).toMatch(ONE_FRAME);
  });

  test("a count through or() of a page ref and a ref in an iframe says or() needs refs from one frame", async () => {
    const { tab, first, frame } = await twoFramedButtons();
    const read = await script(tab, `return await ref(${frame}).or(ref(${first})).count();`);
    expect(read.text).toMatch(ONE_FRAME);
  });
});

async function shownBesideSnapshot() {
  const tab = await open("/frame");
  await Bun.sleep(500);
  const tamam = JSON.stringify(
    refOf(await ok("snapshot", { tab, scope: "full" }), 'button "Tamam"'),
  );
  await ok("evaluate", {
    tab,
    expression: `f.contentDocument.body.insertAdjacentHTML("beforeend", "<button>Vazgeç</button>"); 1`,
  });
  const shown = await ok("hover", {
    tab,
    target: "#f >> internal:control=enter-frame >> button >> nth=1",
  });
  const cancel = /^Hovering button "Vazgeç" \((\w+), from/.exec(shown)?.[1];
  expect(cancel, shown).toMatch(/^f\d+e\d+$/);
  return { tab, tamam, cancel: JSON.stringify(cancel) };
}

const LOCATOR_FRAME =
  /^Ref \w+ cannot be joined with that locator in or\(\): an action showed the ref inside an iframe, and the locator starts from another frame\./;

describe("or() joins a ref an action showed inside an iframe with refs of that iframe", () => {
  test("a count through or() of a shown ref and a snapshot ref in one iframe counts both", async () => {
    const { tab, tamam, cancel } = await shownBesideSnapshot();
    const read = await script(tab, `return await ref(${cancel}).or(ref(${tamam})).count();`);
    expect(read.structured?.value).toBe(2);
  });

  test("a count through or() of a snapshot ref and a shown ref in one iframe counts both", async () => {
    const { tab, tamam, cancel } = await shownBesideSnapshot();
    const read = await script(tab, `return await ref(${tamam}).or(ref(${cancel})).count();`);
    expect(read.structured?.value).toBe(2);
  });

  test("a count through or() of a snapshot ref joined with a shown ref and again with itself counts both", async () => {
    const { tab, tamam, cancel } = await shownBesideSnapshot();
    const read = await script(
      tab,
      `return await ref(${tamam}).or(ref(${cancel})).or(ref(${tamam})).count();`,
    );
    expect(read.structured?.value).toBe(2);
  });

  test("or() of a shown ref in an iframe and a locator through frameLocator() says or() needs one frame", async () => {
    const { tab, tamam } = await shownTamam();
    const read = await script(
      tab,
      `return await ref(${tamam}).or(page.frameLocator("#f").getByRole("button")).count();`,
    );
    expect(read.text).toMatch(LOCATOR_FRAME);
  });

  test("or() of a shown ref in an iframe and a page locator says or() needs one frame", async () => {
    const { tab, tamam } = await shownTamam();
    const read = await script(tab, `return await ref(${tamam}).or(page.locator("main")).count();`);
    expect(read.text).toMatch(LOCATOR_FRAME);
  });

  test("or() of a page locator and a shown ref in an iframe says or() needs one frame", async () => {
    const { tab, tamam } = await shownTamam();
    const read = await script(tab, `return await page.locator("main").or(ref(${tamam})).count();`);
    expect(read.text).toMatch(LOCATOR_FRAME);
  });
});

async function mixedRefs() {
  const tab = await open("/mixed-frame");
  await Bun.sleep(500);
  const snapshot = await ok("snapshot", { tab, scope: "full" });
  return {
    tab,
    tamam: JSON.stringify(refOf(snapshot, 'button "Tamam"')),
    paragraph: JSON.stringify(refOf(snapshot, "paragraph")),
    heading: JSON.stringify(refOf(snapshot, "heading")),
    frame: JSON.stringify(refOf(snapshot, "- iframe")),
  };
}

async function shownLink() {
  const tab = await open("/mixed-frame");
  await Bun.sleep(500);
  const shown = await ok("hover", { tab, target: "#f >> internal:control=enter-frame >> a" });
  const link = /^Hovering link "Bağlantı" \((\w+), from/.exec(shown)?.[1];
  expect(link, shown).toMatch(/^f\d+e\d+$/);
  return { tab, link: JSON.stringify(link) };
}

const snapshotFrame = (method: string) =>
  new RegExp(
    `^Ref \\w+ cannot be joined with that locator in ${method}\\(\\): a snapshot showed the ref inside an iframe, and ${method}\\(\\) joins such a ref only with refs of that iframe\\.`,
  );

const shownFrame = (method: string) =>
  new RegExp(
    `^Ref \\w+ cannot be joined with that locator in ${method}\\(\\): an action showed the ref inside an iframe, and the locator starts from another frame\\.`,
  );

const INTO_FRAME =
  /^or\(\) cannot join a locator that goes into an iframe through contentFrame\(\) or frameLocator\(\)/;

describe("or() and and() never match a page locator inside a ref's iframe", () => {
  test("or() of a snapshot ref in an iframe and a page locator says the ref joins only refs of its iframe", async () => {
    const { tab, tamam } = await mixedRefs();
    const read = await script(tab, `return await ref(${tamam}).or(page.locator("p")).count();`);
    expect(read.text).toMatch(snapshotFrame("or"));
  });

  test("or() of a snapshot ref in an iframe and a page locator does not click the iframe's link", async () => {
    const { tab, tamam } = await mixedRefs();
    await script(
      tab,
      `await ref(${tamam}).or(page.locator("a")).last().click({ timeout: 3000 }); return 1;`,
    );
    expect(await valueOf(tab, "f.contentWindow.location.hash")).toBe("");
  });

  test("or() of a page locator and a snapshot ref in an iframe says the ref joins only refs of its iframe", async () => {
    const { tab, tamam } = await mixedRefs();
    const read = await script(tab, `return await page.locator("h1").or(ref(${tamam})).count();`);
    expect(read.text).toMatch(snapshotFrame("or"));
  });

  test("or() of a snapshot ref in an iframe and a locator through frameLocator() says the ref joins only refs of its iframe", async () => {
    const { tab, tamam } = await mixedRefs();
    const read = await script(
      tab,
      `return await ref(${tamam}).or(page.frameLocator("#f").locator("a")).count();`,
    );
    expect(read.text).toMatch(snapshotFrame("or"));
  });

  test("and() of a snapshot ref in an iframe and a page locator says the ref joins only refs of its iframe", async () => {
    const { tab, tamam } = await mixedRefs();
    const read = await script(
      tab,
      `return await ref(${tamam}).and(page.locator("button")).count();`,
    );
    expect(read.text).toMatch(snapshotFrame("and"));
  });

  test("locator() of a page locator with a snapshot ref in an iframe says the ref joins only refs of its iframe", async () => {
    const { tab, tamam } = await mixedRefs();
    const read = await script(
      tab,
      `return await page.locator("main").locator(ref(${tamam})).count();`,
    );
    expect(read.text).toMatch(snapshotFrame("locator"));
  });

  test("or() of a page ref and a locator through frameLocator() says or() cannot join a locator that goes into an iframe", async () => {
    const { tab, heading } = await mixedRefs();
    const read = await script(
      tab,
      `return await ref(${heading}).or(page.frameLocator("#f").locator("a")).count();`,
    );
    expect(read.text).toMatch(INTO_FRAME);
  });

  test("or() of a locator through frameLocator() and a page ref says or() cannot join a locator that goes into an iframe", async () => {
    const { tab, heading } = await mixedRefs();
    const read = await script(
      tab,
      `return await page.frameLocator("#f").locator("a").or(ref(${heading})).count();`,
    );
    expect(read.text).toMatch(INTO_FRAME);
  });

  test("or() of a locator inside an iframe ref's contentFrame() and a page ref says or() cannot join a locator that goes into an iframe", async () => {
    const { tab, heading, frame } = await mixedRefs();
    const read = await script(
      tab,
      `return await ref(${frame}).contentFrame().locator("a").or(ref(${heading})).count();`,
    );
    expect(read.text).toMatch(INTO_FRAME);
  });

  test("or() of a page ref and a locator from the iframe's frame says the locator starts from an iframe", async () => {
    const { tab, heading } = await mixedRefs();
    const read = await script(
      tab,
      `return await ref(${heading}).or(page.frames()[1].locator("a")).count();`,
    );
    expect(read.text).toMatch(
      /^Ref \w+ cannot be joined with that locator in or\(\): the ref is in the page, and the locator starts from an iframe\./,
    );
  });

  test("and() of a page ref and a snapshot ref in an iframe says they are in different frames", async () => {
    const { tab, heading, tamam } = await mixedRefs();
    const read = await script(tab, `return await ref(${heading}).and(ref(${tamam})).count();`);
    expect(read.text).toMatch(
      /^Refs \w+ and \w+ cannot be joined with and\(\): they are in different frames\./,
    );
  });

  test("and() of a shown ref in an iframe and a page locator says the locator starts from another frame", async () => {
    const { tab, link } = await shownLink();
    const read = await script(tab, `return await ref(${link}).and(page.locator("a")).count();`);
    expect(read.text).toMatch(shownFrame("and"));
  });

  test("locator() of a page locator with a shown ref in an iframe says the locator starts from another frame", async () => {
    const { tab, link } = await shownLink();
    const read = await script(
      tab,
      `return await page.locator("main").locator(ref(${link})).count();`,
    );
    expect(read.text).toMatch(shownFrame("locator"));
  });
});

describe("or() and and() keep joining refs and locators of one frame", () => {
  test("or() of a page ref and a page locator counts both", async () => {
    const { tab, heading } = await mixedRefs();
    const read = await script(
      tab,
      `return await ref(${heading}).or(page.locator("main")).count();`,
    );
    expect(read.structured?.value).toBe(2);
  });

  test("or() of two snapshot refs in one iframe counts both", async () => {
    const { tab, tamam, paragraph } = await mixedRefs();
    const read = await script(tab, `return await ref(${tamam}).or(ref(${paragraph})).count();`);
    expect(read.structured?.value).toBe(2);
  });

  test("or() of a shown ref in an iframe and a locator from that iframe's frame counts both", async () => {
    const { tab, link } = await shownLink();
    const read = await script(
      tab,
      `return await ref(${link}).or(page.frames()[1].locator("p")).count();`,
    );
    expect(read.structured?.value).toBe(2);
  });

  test("and() of a shown ref and a snapshot ref of another button in one iframe counts none", async () => {
    const { tab, tamam, cancel } = await shownBesideSnapshot();
    const read = await script(tab, `return await ref(${cancel}).and(ref(${tamam})).count();`);
    expect(read.structured?.value).toBe(0);
  });

  test("the iframe's body from its frame filtered to have a shown ref counts one", async () => {
    const { tab, link } = await shownLink();
    const read = await script(
      tab,
      `return await page.frames()[1].locator("body").filter({ has: ref(${link}) }).count();`,
    );
    expect(read.structured?.value).toBe(1);
  });
});

const hoveredIn = async (tab: string, target: string, label: string) => {
  const shown = await ok("hover", {
    tab,
    target: `#f >> internal:control=enter-frame >> ${target}`,
  });
  const ref = new RegExp(`^Hovering ${label} \\((\\w+), from`).exec(shown)?.[1];
  expect(ref, shown).toMatch(/^f\d+e\d+$/);
  return JSON.stringify(ref);
};

async function framedForm() {
  const tab = await open("/form-frame");
  await Bun.sleep(500);
  return { tab, snapshot: await ok("snapshot", { tab, scope: "full" }) };
}

describe("locator() joins a ref an action showed inside an iframe with refs of that iframe", () => {
  test("locator() of a shown region ref with a snapshot ref of its button counts the button", async () => {
    const { tab, snapshot } = await framedForm();
    await ok("evaluate", {
      tab,
      expression: `const form = f.contentDocument.querySelector("form"); const region = f.contentDocument.createElement("section"); region.setAttribute("aria-label", "Bölüm"); form.before(region); region.append(form); 1`,
    });
    const region = await hoveredIn(tab, "section", 'region "Bölüm"');
    const button = JSON.stringify(refOf(snapshot, 'button "Tamam"'));
    const read = await script(tab, `return await ref(${region}).locator(ref(${button})).count();`);
    expect(read.structured?.value).toBe(1);
  });

  test("locator() of a snapshot form ref with a shown ref of its button counts the button", async () => {
    const { tab, snapshot } = await framedForm();
    await ok("evaluate", {
      tab,
      expression: `f.contentDocument.querySelector("form").insertAdjacentHTML("beforeend", "<button>Vazgeç</button>"); 1`,
    });
    const cancel = await hoveredIn(tab, "form >> button >> nth=1", 'button "Vazgeç"');
    const form = JSON.stringify(refOf(snapshot, 'form "Sipariş"'));
    const read = await script(tab, `return await ref(${form}).locator(ref(${cancel})).count();`);
    expect(read.structured?.value).toBe(1);
  });
});

async function shownAfterAddressChange() {
  const tab = await open("/frame");
  await Bun.sleep(500);
  const tamam = JSON.stringify(
    refOf(await ok("snapshot", { tab, scope: "full" }), 'button "Tamam"'),
  );
  await ok("evaluate", {
    tab,
    expression: `f.contentDocument.body.insertAdjacentHTML("beforeend", "<button>Vazgeç</button>"); f.contentWindow.history.pushState(null, "", "?moved"); 1`,
  });
  const shown = await ok("hover", {
    tab,
    target: "#f >> internal:control=enter-frame >> button >> nth=1",
  });
  const cancel = /^Hovering button "Vazgeç" \((\w+), from/.exec(shown)?.[1];
  expect(cancel, shown).toMatch(/^f\d+e\d+$/);
  return { tab, tamam, cancel: JSON.stringify(cancel) };
}

test("or() of two refs of one iframe whose address changed between them says the address changed", async () => {
  const { tab, tamam, cancel } = await shownAfterAddressChange();
  const read = await script(tab, `return await ref(${cancel}).or(ref(${tamam})).count();`);
  expect(read.text).toMatch(
    /^Refs \w+ and \w+ cannot be joined with or\(\): their frame changed its address between the snapshots or actions that gave them\./,
  );
});

const COUNT_TARGETS =
  "window.targets = 0; for (const name of ['__playwright_mark_target__', '__playwright_reset_targets__']) document.addEventListener(name, () => { targets += 1; }, true);";

describe("a ref chain lists its elements without events the page can see", () => {
  test("allTextContents through or() sends the page no target events", async () => {
    const { tab, both } = await saveOrCancel(COUNT_TARGETS);
    const read = await script(tab, `return await ${both}.allTextContents();`);
    expect(read.structured?.value).toEqual(["Kaydet", "Vazgeç"]);
    expect(Number(await valueOf(tab, "window.targets"))).toBe(0);
  });

  test("evaluateAll through or() sends the page no target events", async () => {
    const { tab, both } = await saveOrCancel(COUNT_TARGETS);
    const read = await script(
      tab,
      `return await ${both}.evaluateAll((elements) => elements.length);`,
    );
    expect(read.structured?.value).toBe(2);
    expect(Number(await valueOf(tab, "window.targets"))).toBe(0);
  });

  test("allTextContents of main filtered to have a ref sends the page no target events", async () => {
    const { tab, save } = await saveOrCancel(COUNT_TARGETS);
    const read = await script(
      tab,
      `return await page.locator("main").filter({ has: ref(${save}) }).allTextContents();`,
    );
    expect(read.structured?.value).toEqual(["KaydetVazgeç"]);
    expect(Number(await valueOf(tab, "window.targets"))).toBe(0);
  });

  test("evaluateAll of main filtered to have a ref sends the page no target events", async () => {
    const { tab, save } = await saveOrCancel(COUNT_TARGETS);
    const read = await script(
      tab,
      `return await page.locator("main").filter({ has: ref(${save}) }).evaluateAll((elements) => elements.length);`,
    );
    expect(read.structured?.value).toBe(1);
    expect(Number(await valueOf(tab, "window.targets"))).toBe(0);
  });

  test("allTextContents of main filtered to have a ref reads main", async () => {
    const { tab, save } = await saveOrCancel("");
    const read = await script(
      tab,
      `return await page.locator("main").filter({ has: ref(${save}) }).allTextContents();`,
    );
    expect(read.structured?.value).toEqual(["KaydetVazgeç"]);
  });
});

const COUNT_RESETS =
  "window.resets = 0; document.addEventListener('__playwright_reset_targets__', () => { resets += 1; }, true);";

describe("a wait through or() stays quiet on the page", () => {
  test("a wait for visible through or() with both refs hidden shows the page target resets of at most one lookup", async () => {
    const { tab, either } = await saveOrCancel(
      `${COUNT_RESETS} a.style.display = 'none'; b.style.display = 'none';`,
    );
    await script(tab, `await ${either}.waitFor({ timeout: 1500 }).catch(() => undefined);`);
    expect(Number(await valueOf(tab, "window.resets"))).toBeLessThanOrEqual(4);
  });
});

const hoverLabels = [
  { kind: "a script", path: "/hover-label" },
  { kind: "CSS", path: "/hover-label-css" },
];

async function followButton(path: string) {
  const tab = await open(path);
  const target = refOf(await ok("snapshot", { tab }), 'button "Takip ediliyor"');
  return { tab, target };
}

describe("a button whose label changes on hover works with its snapshot ref", () => {
  for (const { kind, path } of hoverLabels) {
    test(`a click on a button relabeled on hover by ${kind} clicks it`, async () => {
      const { tab, target } = await followButton(path);
      await call("click", { tab, target, timeout_ms: 3000 });
      expect(await actionsSoFar()).toEqual(["follow"]);
    });

    test(`a human click on a button relabeled on hover by ${kind} clicks it`, async () => {
      const { tab, target } = await followButton(path);
      await call("click", { tab, target, timeout_ms: 3000, human: true });
      expect(await actionsSoFar()).toEqual(["follow"]);
    });

    test(`a script click on a button relabeled on hover by ${kind} clicks it`, async () => {
      const { tab, target } = await followButton(path);
      await scriptClickWithin(tab, target);
      expect(await actionsSoFar()).toEqual(["follow"]);
    });

    test(`a hover on a button relabeled on hover by ${kind} hovers it`, async () => {
      const { tab, target } = await followButton(path);
      expect((await call("hover", { tab, target })).text).toContain(
        'Hovering button "Takip ediliyor"',
      );
    });

    test(`a human hover on a button relabeled on hover by ${kind} hovers it`, async () => {
      const { tab, target } = await followButton(path);
      expect((await call("hover", { tab, target, human: true })).text).toContain(
        'Hovering button "Takip ediliyor"',
      );
    });

    test(`a script hover on a button relabeled on hover by ${kind} hovers it`, async () => {
      const { tab, target } = await followButton(path);
      const hovered = await script(
        tab,
        `await ref(${JSON.stringify(target)}).hover({ timeout: 3000 }); return "hovered";`,
      );
      expect(hovered.structured?.value).toBe("hovered");
    });
  }
});

async function windowMenuItem() {
  const tab = await open("/window-menu");
  const target = refOf(await ok("snapshot", { tab }), 'menuitem "Öğe"');
  return { tab, target };
}

async function windowToggle() {
  const tab = await open("/window-toggle");
  const target = refOf(await ok("snapshot", { tab }), 'button "Değiştir"');
  return { tab, target };
}

async function windowDoubleClick() {
  const tab = await open("/window-dblclick");
  const target = refOf(await ok("snapshot", { tab }), 'button "Büyüt"');
  return { tab, target };
}

describe("a ref action sends the page one input, as a person would", () => {
  test("a click on a menu item that closes on any click clicks the item", async () => {
    const { tab, target } = await windowMenuItem();
    await call("click", { tab, target, timeout_ms: 3000 });
    expect(await actionsSoFar()).toEqual(["item"]);
  });

  test("a click on a menu item shows a window listener exactly one click", async () => {
    const { tab, target } = await windowMenuItem();
    await call("click", { tab, target, timeout_ms: 3000 });
    expect(await valueOf(tab, "clicks")).toBe("1");
  });

  test("a script click on a menu item that closes on any click clicks the item", async () => {
    const { tab, target } = await windowMenuItem();
    await scriptClickWithin(tab, target);
    expect(await actionsSoFar()).toEqual(["item"]);
  });

  test("a click on a button toggled by a window listener toggles it once", async () => {
    const { tab, target } = await windowToggle();
    await call("click", { tab, target, timeout_ms: 3000 });
    expect(await valueOf(tab, "t.getAttribute('aria-pressed')")).toBe("true");
  });

  test("a script click on a button toggled by a window listener toggles it once", async () => {
    const { tab, target } = await windowToggle();
    await scriptClickWithin(tab, target);
    expect(await valueOf(tab, "t.getAttribute('aria-pressed')")).toBe("true");
  });

  test("a double click sends a window listener one dblclick", async () => {
    const { tab, target } = await windowDoubleClick();
    await call("click", { tab, target, timeout_ms: 3000, click_count: 2 });
    expect(await actionsSoFar()).toEqual(["dblclick"]);
  });

  test("a script dblclick sends a window listener one dblclick", async () => {
    const { tab, target } = await windowDoubleClick();
    await script(
      tab,
      `await ref(${JSON.stringify(target)}).dblclick({ timeout: 3000 }); return "clicked";`,
    );
    expect(await actionsSoFar()).toEqual(["dblclick"]);
  });
});

async function shadowHostRenamed() {
  const tab = await open("/shadow-host");
  const target = refOf(await ok("snapshot", { tab }), 'button "Kaydet"');
  await ok("evaluate", { tab, expression: "h.setAttribute('aria-label', 'Sil'); 1" });
  return { tab, target };
}

describe("a shadow host is checked by its own role and name", () => {
  test("a click on a renamed shadow host whose shadow tree repeats its old name says it was renamed", async () => {
    const { tab, target } = await shadowHostRenamed();
    expect((await call("click", { tab, target, timeout_ms: 3000 })).text).toMatch(
      /name changed from "Kaydet" to "Sil"/,
    );
  });

  test("a click on a renamed shadow host whose shadow tree repeats its old name does not click", async () => {
    const { tab, target } = await shadowHostRenamed();
    await call("click", { tab, target, timeout_ms: 3000 });
    expect(await actionsSoFar()).toEqual([]);
  });

  test("a script read through a renamed shadow host is refused", async () => {
    const { tab, target } = await shadowHostRenamed();
    const read = await script(
      tab,
      `return await ref(${JSON.stringify(target)}).getAttribute("aria-label");`,
    );
    expect(read.text).toMatch(/name changed from "Kaydet" to "Sil"/);
  });

  test("a click on an unchanged shadow host clicks it", async () => {
    const tab = await open("/shadow-host");
    const target = refOf(await ok("snapshot", { tab }), 'button "Kaydet"');
    await call("click", { tab, target, timeout_ms: 3000 });
    expect(await actionsSoFar()).toEqual(["host Kaydet"]);
  });
});

async function editorAfterReload() {
  const tab = await open("/editor-frame");
  await Bun.sleep(500);
  const editor = refOf(await ok("snapshot", { tab }), "- iframe");
  await ok("evaluate", { tab, expression: "f.src = '/editor?w=B'; 1" });
  await Bun.sleep(800);
  const filled = await call("fill", { tab, target: editor, value: "Yeni metin", timeout_ms: 3000 });
  return { tab, filled };
}

describe("a fill into an iframe ref's editable page keeps the iframe's page", () => {
  test("a fill into an iframe ref after the iframe loaded another page says so", async () => {
    const { filled } = await editorAfterReload();
    expect(filled.text).toMatch(/its iframe loaded a new page since the snapshot/);
  });

  test("a fill into an iframe ref after the iframe loaded another page leaves the new page as it was", async () => {
    const { tab } = await editorAfterReload();
    expect(await valueOf(tab, "f.contentDocument.body.textContent")).toBe("B");
  });

  test("a fill into an iframe ref first shown by a selector hover fills its body", async () => {
    const tab = await open("/editor-frame");
    await Bun.sleep(500);
    const hovered = await ok("hover", { tab, target: "#f" });
    const editor = /\((e\d+)[,)]/.exec(hovered)?.[1] ?? "";
    expect(editor, hovered).toMatch(/^e\d+$/);
    await ok("fill", { tab, target: editor, value: "Yeni metin", timeout_ms: 3000 });
    expect(await valueOf(tab, "f.contentDocument.body.textContent")).toBe("Yeni metin");
  });

  test("a fill into an iframe ref on the same page fills its body", async () => {
    const tab = await open("/editor-frame");
    await Bun.sleep(500);
    const editor = refOf(await ok("snapshot", { tab }), "- iframe");
    await ok("fill", { tab, target: editor, value: "Yeni metin", timeout_ms: 3000 });
    expect(await valueOf(tab, "f.contentDocument.body.textContent")).toBe("Yeni metin");
  });
});

const READ_NTH_BUTTON = `.getByRole("button").nth(i).textContent()`;

const containerCosts = [
  { role: "main", path: "/table", label: "- main", selector: "main", read: READ_NTH_BUTTON },
  { role: "generic", path: "/generic", label: "- generic", selector: "#g", read: READ_NTH_BUTTON },
  { role: "cell", path: "/cell", label: "- cell", selector: "#c", read: READ_NTH_BUTTON },
  {
    role: "treeitem",
    path: "/tree",
    label: 'treeitem "Kök"',
    selector: "[role=tree] > li",
    read: `.getByRole("treeitem").nth(i).textContent()`,
  },
  {
    role: "listitem",
    path: "/items",
    label: "- listitem",
    selector: "li >> nth=0",
    read: `.getByRole("button").textContent()`,
  },
  {
    role: "textbox",
    path: "/inputs",
    label: 'textbox "Alan 5"',
    selector: "input >> nth=5",
    read: ".inputValue()",
  },
  {
    role: "custom element",
    path: "/custom",
    label: "- generic",
    selector: "#g",
    read: READ_NTH_BUTTON,
  },
  { role: "section", path: "/section", label: "- generic", selector: "#g", read: READ_NTH_BUTTON },
  { role: "label", path: "/label", label: "- generic", selector: "#g", read: READ_NTH_BUTTON },
  {
    role: "generic with an aria-label",
    path: "/labeled",
    label: 'generic "Liste"',
    selector: "#g",
    read: READ_NTH_BUTTON,
    times: 8,
  },
  {
    role: "generic with a title",
    path: "/titled",
    label: 'generic "İpucu"',
    selector: "#g",
    read: READ_NTH_BUTTON,
    times: 8,
  },
  {
    role: "hidden listbox",
    path: "/options",
    label: 'listbox "Seçenekler"',
    selector: "#lb",
    read: `.getByRole("option", { includeHidden: true }).nth(i).textContent()`,
    hide: "lb.style.display = 'none'; 1",
  },
];

async function readsTook(tab: string, target: string, read: string, count: number) {
  const took = await inSequence([0, 1, 2], async () =>
    Number(
      (
        await script(
          tab,
          `const start = Date.now(); for (let i = 0; i < ${count}; i++) await ${target}${read}; return Date.now() - start;`,
        )
      ).structured?.value,
    ),
  );
  return Math.min(...took);
}

describe("what refs cost", () => {
  test("each of 6 snapshots of a page that redraws 200 buttons every 150 ms takes under 1.5 s", async () => {
    const tab = await open("/churn");
    await Bun.sleep(800);
    const took = await inSequence(ROUNDS.slice(0, 6), () =>
      timed(() => ok("snapshot", { tab, scope: "full" })),
    );
    expect(Math.max(...took)).toBeLessThan(1500);
  });

  test("the first snapshot of a page of 10 000 buttons takes under 2.2 s", async () => {
    const tab = await open("/big?n=10000");
    await Bun.sleep(800);
    expect(await timed(() => ok("snapshot", { tab, scope: "full", max_chars: 2000 }))).toBeLessThan(
      2200,
    );
  });

  test("a renamed ref on a page of 10 000 buttons is refused within 1 s", async () => {
    const tab = await open("/big?n=10000");
    await Bun.sleep(800);
    const target = refOf(await ok("snapshot", { tab, query: "Hedef" }), 'button "Hedef"');
    await ok("evaluate", { tab, expression: "t.textContent = 'Değişti'; 1" });
    expect(await timed(() => call("hover", { tab, target, timeout_ms: 5000 }))).toBeLessThan(1000);
  });

  test("a list of 300 buttons drawn again 15 times keeps at most 600 removed buttons alive", async () => {
    const tab = await open("/spa-list");
    await Bun.sleep(500);
    await inSequence(ROUNDS, async () => {
      const snapshot = await ok("snapshot", { tab, scope: "full", max_chars: 100_000 });
      await call("hover", { tab, target: refOf(snapshot, "Öğe 3") });
      await ok("evaluate", { tab, expression: "r(); 1" });
    });
    await ok("run_script", { tab, code: COLLECT_GARBAGE });
    expect(Number(await valueOf(tab, "removedAlive()"))).toBeLessThanOrEqual(600);
  });

  for (const cost of containerCosts)
    test(`50 reads through a ${cost.role} ref on 3000 rows take at most ${cost.times ?? 2} times as long as through a selector`, async () => {
      const tab = await open(cost.path);
      const target = refOf(await ok("snapshot", { tab, max_chars: 2000 }), cost.label);
      if (cost.hide) await ok("evaluate", { tab, expression: cost.hide });
      const selector = await readsTook(
        tab,
        `page.locator(${JSON.stringify(cost.selector)})`,
        cost.read,
        50,
      );
      expect(
        await readsTook(tab, `ref(${JSON.stringify(target)})`, cost.read, 50),
      ).toBeLessThanOrEqual((cost.times ?? 2) * selector);
    });

  test("50 reads through a small generic ref with an aria-label on a page of 10 000 rows take at most twice as long as through a selector", async () => {
    const tab = await open("/small-named?n=10000");
    const target = refOf(await ok("snapshot", { tab, query: "Araç" }), 'generic "Araçlar"');
    const read = `.getByRole("button").textContent()`;
    const selector = await readsTook(tab, `page.locator("#g")`, read, 50);
    expect(await readsTook(tab, `ref(${JSON.stringify(target)})`, read, 50)).toBeLessThanOrEqual(
      2 * selector,
    );
  });

  test("50 reads through a shadow host ref with 20 000 shadow nodes take at most twice as long as through a selector", async () => {
    const tab = await open("/shadow-big?n=20000");
    const target = refOf(await ok("snapshot", { tab, max_chars: 2000 }), 'button "Kaydet"');
    const read = `.getAttribute("id")`;
    const selector = await readsTook(tab, `page.locator("#h")`, read, 50);
    expect(await readsTook(tab, `ref(${JSON.stringify(target)})`, read, 50)).toBeLessThanOrEqual(
      2 * selector,
    );
  });

  for (const cost of [
    { what: "20 reads", read: ".textContent()", count: 20 },
    { what: "10 clicks", read: ".click()", count: 10 },
  ])
    test(`${cost.what} through a button ref on a page of 20 000 rows take at most 3 times as long as through a selector`, async () => {
      const tab = await open("/table?n=20000");
      const target = refOf(await ok("snapshot", { tab, query: "Düğme 5" }), 'button "Düğme 5"');
      const selector = await readsTook(
        tab,
        `page.locator("main button >> nth=5")`,
        cost.read,
        cost.count,
      );
      expect(
        await readsTook(tab, `ref(${JSON.stringify(target)})`, cost.read, cost.count),
      ).toBeLessThanOrEqual(3 * selector);
    });

  test("a selector hover on an iframe whose page never answers takes under 5 s", async () => {
    const tab = await open("/silent-frame");
    expect(await timed(() => call("hover", { tab, target: "#f" }))).toBeLessThan(5000);
  });

  test("a selector hover on a page of 10 000 buttons costs at most 0.3 s more after a snapshot", async () => {
    const tab = await open("/big?n=10000");
    await Bun.sleep(800);
    const before = await hoverTook(tab, "#t");
    await ok("snapshot", { tab, scope: "full", max_chars: 500 });
    const after = await hoverTook(tab, "#t");
    expect(after - before).toBeLessThanOrEqual(300);
  });
});
