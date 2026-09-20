const MAX_EDGE = 4096;          // working resolution cap

const q = new URLSearchParams(location.search);   // dev knobs, see bottom of file
const $ = (id) => document.getElementById(id);
const view = $("view"), vctx = view.getContext("2d");
const statusEl = $("status"), stage = $("stage");

let source = null;              // canvas holding the original pixels
let glasses = [];               // see "glasses model" below
let rawBoxes = [];
let busy = false;
let runId = 0;                  // id of the newest detection; older ones are ignored (and cancelled in the worker)
let fileName = "photo";

const setStatus = (html) => { statusEl.innerHTML = html; };
const veil = $("veil");
// p = null -> indeterminate (model download), otherwise 0..1
function setVeil(p, text) {
  veil.hidden = false;
  veil.classList.toggle("indeterminate", p === null);
  veil.style.setProperty("--p", p ?? 0);
  veil.querySelector(".label").textContent = text;
  setStatus(text);
}
// ---------- detection worker ----------
// All model work happens in worker.js, so the page stays responsive.
// The worker is started from a blob: URL because only then does it inherit this page's CSP
// (connect-src 'self'); a worker loaded by URL is governed by its own response headers instead,
// which a static host can't set. Verified: a URL worker can fetch cross-origin, a blob worker can't.
const workerSrc = `self.VENDOR = ${JSON.stringify(new URL("vendor/", location.href).href)};\n` + await (await fetch("worker.js")).text();
const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: "text/javascript" })));
const pending = new Map();      // request id -> resolve, for "result" / "refined" replies
let reqId = 0;
let onProgress = null;

const ready = new Promise((resolve, reject) => {
  worker.addEventListener("message", ({ data }) => {
    if (data.type === "ready") { setStatus(`模型已就緒（${data.delegate}）。請選擇照片。`); resolve(); }
    else if (data.type === "error") { console.error(data.message); setStatus("發生錯誤：" + data.message); reject(new Error(data.message)); }
    else if (data.type === "progress") { if (data.id === runId) onProgress?.(data.p); }
    else { pending.get(data.id)?.(data); pending.delete(data.id); }
  });
});
ready.catch(() => {});
const ask = (msg, transfer) => new Promise((resolve) => { pending.set(msg.id, resolve); worker.postMessage(msg, transfer || []); });

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// ---------- glasses model ----------
// Privacy: a pair of glasses must not encode the wearer's facial measurements.
// So every face in a photo wears the SAME model (one template, sized so it
// covers the most demanding face), lenses are always symmetric, and each pair
// gets fresh crypto-random jitter in size / position / tilt. The drawn size is
// therefore template x jitter x a coarse face scale — it cannot be inverted
// back to eye spacing or eye width, and re-running gives a different result.
const rand = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
const BASE = { tw: 0.9, th: 0.76, gap: 0.16, drop: 0.06 };   // in units of face scale (~ eye-to-eye distance)
let template = null;

function fitTemplate() {
  const span = Math.max(0, ...glasses.map((g) => g.need?.span || 0));
  const up = Math.max(0, ...glasses.map((g) => g.need?.up || 0));
  const k = 1 + rand() * 0.08;
  template = {
    // needs may grow the model by at most 20%, so one odd face cannot balloon everyone's glasses
    tw: Math.min(BASE.tw * 1.2, Math.max(BASE.tw, span - BASE.gap / 2)) * k,
    th: Math.min(BASE.th * 1.2, Math.max(BASE.th, 2 * (up + BASE.drop))) * k,
    gap: BASE.gap, drop: BASE.drop,
  };
}

const jitter = () => ({ scale: 1 + rand() * 0.18, rot: (rand() - 0.5) * 0.07, dx: (rand() - 0.5) * 0.08, dy: (rand() - 0.5) * 0.08 });

const withJitter = (face, box) => ({ ...face, j: jitter(), box });
const glassesFromEyes = (a, b) =>
  withJitter({ c: mid(a, b), ang: Math.atan2(b.y - a.y, b.x - a.x), s: dist(a, b), fx: 1, temples: null, need: null, kind: "manual" }, null);

async function run() {
  if (!source) return;
  const id = runId = ++reqId;
  busy = true; glasses = []; rawBoxes = [];
  updateButtons(); render();
  setVeil(null, "載入模型中…");
  try { await ready; } catch { busy = false; veil.hidden = true; return; }   // ready already reported the error
  if (id !== runId) return;
  setVeil(0, "偵測人臉中 0%");
  onProgress = (p) => setVeil(p, `偵測人臉中 ${Math.round(p * 100)}%`);
  const minTile = +document.querySelector("[name=depth]:checked").value;
  const bitmap = await createImageBitmap(source);
  const res = await ask({ type: "detect", id, bitmap, minTile }, [bitmap]);
  if (id !== runId) return;
  rawBoxes = res.boxes;
  glasses = res.faces.map((f) => withJitter(f, rawBoxes[f.boxIndex]));
  fitTemplate();
  busy = false; updateButtons(); render(); veil.hidden = true;
  const fb = glasses.filter((g) => g.kind === "eyes").length;
  setStatus(`找到 <b>${glasses.length}</b> 張臉${fb ? `（其中 ${fb} 張為粗略定位）` : ""}，耗時 ${(res.ms / 1000).toFixed(1)} 秒。有漏掉的請手動拖曳補上。`);
  window.__result = {
    template, faces: glasses.length, fallback: fb, candidates: rawBoxes.length, ms: res.ms,
    boxes: rawBoxes.map((b) => ({ x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), score: +b.score.toFixed(2), kind: glasses.find((g) => g.box === b)?.kind || "dropped" })),
  };
}

// ---------- rendering ----------
function lensPath(ctx, w, h) {
  ctx.beginPath();
  ctx.roundRect(-w / 2, -h / 2, w, h, [h * 0.22, h * 0.22, h * 0.45, h * 0.45]);
}

function metrics(g) {
  const S = g.s * g.j.scale;
  return { S, w: S * template.tw * g.fx, h: S * template.th, gap: S * template.gap * g.fx, drop: S * template.drop };
}

function drawGlasses(ctx, g) {
  const { S, w, h, gap, drop } = metrics(g);
  const ang = g.ang + g.j.rot, c = { x: g.c.x + g.j.dx * S, y: g.c.y + g.j.dy * S };
  ctx.save();
  ctx.translate(c.x, c.y); ctx.rotate(ang); ctx.translate(0, drop);
  const lx = -(gap + w) / 2, rx = (gap + w) / 2, frame = Math.max(1.5, h * 0.07);
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = "#0a0a0a";

  if (g.temples) {
    // temples run from each lens' outer top corner to the side of the head
    const inv = (p) => { const x = p.x - c.x, y = p.y - c.y, cs = Math.cos(-ang), sn = Math.sin(-ang); return { x: x * cs - y * sn, y: x * sn + y * cs - drop }; };
    const tl = inv(g.temples[0]), tr = inv(g.temples[1]);
    ctx.lineWidth = frame * 1.3;
    ctx.beginPath();
    if (tl.x < lx - w / 2) { ctx.moveTo(lx - w / 2, -h * 0.28); ctx.lineTo(tl.x, -h * 0.2); }
    if (tr.x > rx + w / 2) { ctx.moveTo(rx + w / 2, -h * 0.28); ctx.lineTo(tr.x, -h * 0.2); }
    ctx.stroke();
  }

  ctx.lineWidth = frame * 1.6;
  ctx.beginPath(); ctx.moveTo(lx + w / 2, -h * 0.26); ctx.lineTo(rx - w / 2, -h * 0.26); ctx.stroke();

  for (const x of [lx, rx]) {
    ctx.save(); ctx.translate(x, 0);
    const grad = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    grad.addColorStop(0, "#262626"); grad.addColorStop(1, "#000");
    lensPath(ctx, w, h); ctx.fillStyle = grad; ctx.fill();
    ctx.lineWidth = frame; ctx.stroke();
    // glint — drawn over the opaque lens, so nothing underneath shows through
    ctx.save(); lensPath(ctx, w, h); ctx.clip();
    ctx.rotate(-0.5); ctx.fillStyle = "rgba(255,255,255,.13)";
    ctx.fillRect(-w * 0.32, -h, w * 0.14, h * 2); ctx.fillRect(-w * 0.12, -h, w * 0.05, h * 2);
    ctx.restore(); ctx.restore();
  }
  ctx.restore();
}

function paint(ctx, debug) {
  ctx.drawImage(source, 0, 0);
  for (const g of glasses) drawGlasses(ctx, g);
  if (debug) {
    ctx.lineWidth = Math.max(2, source.width / 600);
    for (const g of glasses) if (g.box) {
      ctx.strokeStyle = g.kind === "mesh" ? "#3f6" : "#fa3";
      ctx.strokeRect(g.box.x, g.box.y, g.box.w, g.box.h);
    }
    ctx.strokeStyle = "#f44";
    for (const b of rawBoxes) if (!glasses.some((g) => g.box === b)) ctx.strokeRect(b.x, b.y, b.w, b.h);
  }
}

function render(drag) {
  if (!source) return;
  paint(vctx, !busy && $("debug").checked);
  if (drag) {
    vctx.strokeStyle = "#ffd23f"; vctx.lineWidth = Math.max(2, source.width / 500);
    vctx.beginPath(); vctx.moveTo(drag.a.x, drag.a.y); vctx.lineTo(drag.b.x, drag.b.y); vctx.stroke();
  }
}

function updateButtons() {
  for (const id of ["savePng", "saveJpg"]) $(id).disabled = !source || busy;
}

// ---------- input ----------
async function loadBlob(blob, name) {
  const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const s = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  source = document.createElement("canvas");
  source.width = Math.round(bmp.width * s); source.height = Math.round(bmp.height * s);
  source.getContext("2d").drawImage(bmp, 0, 0, source.width, source.height);
  bmp.close();
  view.width = source.width; view.height = source.height;
  fileName = (name || "photo").replace(/\.[^.]+$/, "");
  stage.classList.add("loaded");
  await run();
}

$("file").addEventListener("change", (e) => e.target.files[0] && loadBlob(e.target.files[0], e.target.files[0].name));
for (const r of document.querySelectorAll("[name=depth]")) r.addEventListener("change", run);
addEventListener("paste", (e) => {
  const f = [...e.clipboardData.files].find((f) => f.type.startsWith("image/"));
  if (f) { e.preventDefault(); loadBlob(f, f.name && f.name !== "image.png" ? f.name : "pasted"); }
});
$("debug").addEventListener("change", () => render());
for (const ev of ["dragenter", "dragover"]) stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add("drag"); });
for (const ev of ["dragleave", "drop"]) stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove("drag"); });
stage.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) loadBlob(f, f.name); });

const toImage = (e) => {
  const r = view.getBoundingClientRect();
  return { x: (e.clientX - r.left) * view.width / r.width, y: (e.clientY - r.top) * view.height / r.height };
};
function hit(p) {
  for (let i = glasses.length - 1; i >= 0; i--) {
    const g = glasses[i], m = metrics(g);
    if (dist(p, g.c) < m.gap / 2 + m.w) return i;
  }
  return -1;
}
let drag = null;
view.addEventListener("pointerdown", (e) => { if (busy) return; view.setPointerCapture(e.pointerId); drag = { a: toImage(e), b: toImage(e) }; });
view.addEventListener("pointermove", (e) => { if (drag) { drag.b = toImage(e); render(drag); } });
view.addEventListener("pointerup", async () => {
  if (!drag) return;
  const { a, b } = drag; drag = null;
  const moved = dist(a, b) * view.getBoundingClientRect().width / view.width;
  if (moved < 8) {
    const i = hit(a);
    if (i >= 0) glasses.splice(i, 1);
    else if ($("debug").checked) {
      // promote a skipped candidate
      const box = rawBoxes.find((b) => !glasses.some((g) => g.box === b) && a.x >= b.x && a.x <= b.x + b.w && a.y >= b.y && a.y <= b.y + b.h);
      if (box) {
        const run = runId, { face } = await ask({ type: "refine", id: ++reqId, box });
        if (run === runId && !glasses.some((g) => g.box === box)) glasses.push(withJitter(face, box));
      }
    }
  }
  else { const [l, r] = a.x <= b.x ? [a, b] : [b, a]; glasses.push(glassesFromEyes(l, r)); }
  render();
  setStatus(`目前有 <b>${glasses.length}</b> 副墨鏡。`);
});
view.addEventListener("pointercancel", () => { drag = null; render(); });

// ---------- export ----------
function save(type, ext) {
  const out = document.createElement("canvas");
  out.width = source.width; out.height = source.height;
  paint(out.getContext("2d"), false);
  out.toBlob((blob) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `${fileName}-sunglasses.${ext}`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }, type, 0.92);
}
$("savePng").addEventListener("click", () => save("image/png", "png"));
$("saveJpg").addEventListener("click", () => save("image/jpeg", "jpg"));

// dev helper: ?img=test-photos/obama.jpg[&depth=96][&debug=1]
if (q.get("depth")) document.querySelector(`[name=depth][value="${q.get("depth")}"]`).checked = true;
if (q.get("debug")) $("debug").checked = true;
if (q.get("img")) fetch(q.get("img")).then((r) => r.blob()).then((b) => loadBlob(b, q.get("img").split("/").pop()));
