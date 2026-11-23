const page = (title: string, body: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const FORM = page(
  "Fill Form",
  `<p id="status">idle</p>
<form id="signup" onsubmit="event.preventDefault(); document.getElementById('status').textContent = 'submitted ' + document.getElementById('name').value">
<label>Name <input id="name" name="name" required></label>
<label>Age <input id="age" type="number" min="18"></label>
<label>Password <input id="password" type="password"></label>
<label>Plan <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select></label>
<label><input id="terms" type="checkbox"> Accept terms</label>
<button id="send" type="submit">Register</button>
</form>
<label>Search <input id="search" onkeydown="if (event.key === 'Enter') document.getElementById('status').textContent = 'searched ' + this.value"></label>
<label>Avatar <input id="avatar" type="file" multiple onchange="document.getElementById('status').textContent = 'files ' + [...this.files].map((file) => file.name).join(',')"></label>
<button id="pick" onclick="document.getElementById('hidden-file').click()">Choose file</button>
<input id="hidden-file" type="file" style="display:none" onchange="document.getElementById('status').textContent = 'picked ' + this.files[0].name">
<label>Enter alert <input id="enter-alert" onkeydown="if (event.key === 'Enter') alert('Entered')"></label>
<label>File alert <input id="file-alert" type="file" onchange="alert('Attached')"></label>`,
);

const DRAG = page(
  "Drag Board",
  `<style>.column{display:inline-block;width:120px;height:120px;margin:20px;border:2px solid #333}.over{border-style:dashed}</style>
<div id="columns"><div class="column" id="column-a" draggable="true"><header>A</header></div><div class="column" id="column-b" draggable="true"><header>B</header></div></div>
<div id="guarded"><div class="column" id="column-c" draggable="true"><header>C</header></div><div class="column" id="column-d" draggable="true"><header>D</header></div></div>
<div id="still-a" class="column" draggable="true">Still A</div><div id="still-b" class="column">Still B</div>
<div id="mouse-source" style="position:absolute;left:20px;top:400px;width:60px;height:60px;background:#ccc">Handle</div>
<div id="mouse-drop" style="position:absolute;left:300px;top:400px;width:100px;height:100px;background:#eee">Mouse drop</div>
<div id="late-source" style="position:absolute;left:20px;top:560px;width:60px;height:60px;background:#ccc">Late handle</div>
<div id="late-drop" style="position:absolute;left:300px;top:560px;width:100px;height:100px;background:#eee">0</div>
<script>
let dragSource = null;
const columns = document.querySelectorAll("#columns .column, #guarded .column");
document.getElementById("guarded").addEventListener("mousedown", (event) => event.preventDefault());
columns.forEach((column) => {
  column.addEventListener("dragstart", (event) => { dragSource = column; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/html", column.innerHTML); });
  column.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "move"; });
  column.addEventListener("drop", (event) => {
    event.stopPropagation();
    if (dragSource !== column) { dragSource.innerHTML = column.innerHTML; column.innerHTML = event.dataTransfer.getData("text/html"); }
  });
});
let pressed = false;
document.getElementById("mouse-source").addEventListener("mousedown", () => { pressed = true; });
addEventListener("mouseup", (event) => {
  const box = document.getElementById("mouse-drop").getBoundingClientRect();
  if (pressed && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) document.getElementById("mouse-drop").textContent = "dropped";
  pressed = false;
});
const lateDrop = document.getElementById("late-drop");
const countDrop = () => { lateDrop.textContent = String(Number(lateDrop.textContent) + 1); };
let latePressed = false;
document.getElementById("late-source").addEventListener("mousedown", () => { latePressed = true; });
addEventListener("mouseup", (event) => {
  const box = lateDrop.getBoundingClientRect();
  if (latePressed && event.clientX >= box.left && event.clientX <= box.right && event.clientY >= box.top && event.clientY <= box.bottom) setTimeout(countDrop, 400);
  latePressed = false;
});
lateDrop.addEventListener("dragover", (event) => event.preventDefault());
lateDrop.addEventListener("drop", countDrop);
</script>`,
);

const SCROLL = page(
  "Scroll Page",
  `<style>body{margin:0;height:5000px}#panel{position:absolute;left:0;top:0;width:300px;height:200px;overflow:auto}</style>
<div id="panel"><div style="height:3000px">Panel content</div></div>
<p id="far" style="position:absolute;top:3000px">Far paragraph</p>`,
);

const WAIT = page(
  "Wait Page",
  `<div style="display:none">Results ready</div>
<div style="display:none">Verify you are human</div>
<div id="prompt">Verify you are human</div>
<button id="later" onclick="setTimeout(() => { const p = document.createElement('p'); p.textContent = 'Results ready'; document.body.append(p); }, 400)">Load results</button>`,
);

const PAGES = new Map(
  Object.entries({ "/form": FORM, "/drag": DRAG, "/scroll": SCROLL, "/wait": WAIT }),
);

export type FillFixture = { url: string; close: () => Promise<void> };

export function startFillFixture(): FillFixture {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (request) => {
      const body = PAGES.get(new URL(request.url).pathname);
      return body
        ? new Response(body, { headers: { "content-type": "text/html" } })
        : new Response("Not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    close: () => server.stop(true),
  };
}
