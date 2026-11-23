export const SLOW_MS = 3000;
const LATE_DATA_MS = 1200;

const actionPage = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0">${body}</body></html>`;

const ACTIONS = actionPage(
  "Action Results",
  `<canvas id="pad" width="300" height="200" style="position:absolute;left:0;top:0;width:300px;height:200px;background:#eee"></canvas>
<p id="pad-out" style="position:absolute;left:0;top:210px">none</p>
<div id="hover-zone" style="position:absolute;left:400px;top:0;width:100px;height:100px;background:#ccd"></div>
<p id="hover-out" style="position:absolute;left:400px;top:110px">away</p>
<main style="position:absolute;left:0;top:300px">
<p id="status">idle</p>
<button id="save" onclick="document.getElementById('status').textContent = 'saved'">Save</button>
<label>Email <input id="email"></label>
<input id="note">
<a id="slow" href="/actions/slow">Slow page</a>
<a id="redirect" href="/actions/redirect">Redirecting link</a>
<a id="missing" href="/actions/missing">Missing page</a>
<a id="refused" href="/actions/missing">Refused link</a>
<a id="empty" href="/empty-500">Empty error</a>
<a id="late" href="/actions/late">Late results</a>
</main>
<script>
const pad = document.getElementById("pad");
pad.addEventListener("click", (event) => {
  document.getElementById("pad-out").textContent = event.offsetX + "," + event.offsetY;
});
document.getElementById("hover-zone").addEventListener("mouseenter", () => {
  document.getElementById("hover-out").textContent = "hovered";
});
</script>`,
);

const LANDING = actionPage("Action Landing", "<main><h1>Landed</h1></main>");

const LATE = actionPage(
  "Late Results",
  `<main><h1>Search</h1><div id="results"></div></main>
<script>
fetch("/actions/data").then((response) => response.text()).then((text) => {
  const line = document.createElement("p");
  line.textContent = text;
  document.getElementById("results").append(line);
});
</script>`,
);

const HEAVY = actionPage(
  "Heavy Page",
  `<main><h1>Gallery</h1><img alt="Large photo" src="/actions/slow-image"></main>`,
);

const SKELETON = actionPage(
  "Skeleton Page",
  `<main><h1>Feed</h1><div id="feed"><div class="skeleton" style="width:200px;height:20px;background:#ddd">Loading</div></div></main>
<script>
setTimeout(() => {
  document.getElementById("feed").innerHTML = "<p>Skeleton replaced</p>";
}, 800);
</script>`,
);

function html(body: string) {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export function actionRouteResponse(url: URL) {
  switch (url.pathname) {
    case "/actions":
      return html(ACTIONS);
    case "/actions/landing":
      return html(LANDING);
    case "/actions/redirect":
      return new Response(null, { status: 302, headers: { location: "/actions/landing" } });
    case "/actions/slow":
      return Bun.sleep(SLOW_MS).then(() => html(LANDING));
    case "/actions/late":
      return html(LATE);
    case "/actions/data":
      return Bun.sleep(LATE_DATA_MS).then(
        () => new Response("Results loaded", { headers: { "content-type": "text/plain" } }),
      );
    case "/actions/heavy":
      return html(HEAVY);
    case "/actions/slow-image":
      return Bun.sleep(SLOW_MS).then(() => new Response(null, { status: 404 }));
    case "/actions/skeleton":
      return html(SKELETON);
    default:
      return undefined;
  }
}
