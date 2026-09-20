// Face detection worker. Classic (non-module) worker on purpose: MediaPipe loads
// its WASM glue with importScripts(), which module workers don't have.
//
// in:  {type:"detect", id, bitmap, minTile}   (a newer id cancels the run in flight)
//      {type:"refine", id, box}               (re-examine one candidate box of the current photo)
// out: {type:"ready", delegate} | {type:"error", message}
//      {type:"progress", id, p} | {type:"result", id, boxes, faces, ms}
//      {type:"refined", id, face}
// A "face" is glasses geometry without any randomness: {c, ang, s, fx, temples, need, kind, boxIndex}.

// Started from a blob: URL (see app.js) so that it inherits the page's CSP — a worker loaded
// straight from its URL would not, and could talk to any server. app.js prepends self.VENDOR.
const VENDOR = self.VENDOR;

const MIN_SCORE = 0.5;          // detector confidence
// Tuned on test-photos/: every real face scored >= 0.76, every false positive <= 0.71
const MESH_SCORE = 0.7;         // candidates confirmed by the landmarker need at least this detector score
const FALLBACK_SCORE = 0.75;    // detector-only faces (landmarker found nothing) need this much
const CROP = 384;               // landmarker input crop size

let detector, landmarker;
let source = null;              // ImageBitmap of the current photo
let current = 0;                // id of the newest detect request

// ---------- model loading ----------
async function createTasks(vision, delegate) {
  const fileset = await vision.FilesetResolver.forVisionTasks(`${VENDOR}mediapipe/wasm`);
  detector = await vision.FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${VENDOR}models/blaze_face_short_range.tflite`, delegate },
    runningMode: "IMAGE",
    minDetectionConfidence: MIN_SCORE,
  });
  landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${VENDOR}models/face_landmarker.task`, delegate },
    runningMode: "IMAGE",
    numFaces: 3,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
  });
}

const ready = (async () => {
  const vision = await import(`${VENDOR}mediapipe/vision_bundle.mjs`);
  let delegate = "GPU";
  try { await createTasks(vision, delegate); }
  catch (e) { console.warn("GPU delegate failed, using CPU", e); delegate = "CPU"; await createTasks(vision, delegate); }
  postMessage({ type: "ready", delegate });
})();
ready.catch((e) => postMessage({ type: "error", message: String(e?.message || e) }));

// ---------- detection ----------
// Square tiles at halving sizes with 50% overlap, so every face smaller than
// half a tile sits fully inside at least one tile at a scale where it is large
// enough for the short-range detector.
function* tiles(w, h, minTile) {
  yield { x: 0, y: 0, w, h };
  for (let t = Math.max(w, h) / 2; t >= minTile; t /= 2) {
    const tw = Math.min(t, w), th = Math.min(t, h);
    const nx = Math.max(1, Math.ceil((w - tw) / (t / 2))), ny = Math.max(1, Math.ceil((h - th) / (t / 2)));
    for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) {
      if ((i && w === tw) || (j && h === th)) continue;
      yield { x: Math.round((w - tw) * i / nx), y: Math.round((h - th) * j / ny), w: Math.round(tw), h: Math.round(th) };
    }
  }
}

function overlap(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.min(a.w * a.h, b.w * b.h);
}

// lets queued messages (a newer detect = cancellation) be delivered mid-run
const breathe = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = r; ch.port2.postMessage(0); });

async function detectBoxes(minTile, id) {
  const all = [...tiles(source.width, source.height, minTile)];
  const tile = new OffscreenCanvas(1, 1), tctx = tile.getContext("2d");
  const found = [];
  let last = performance.now();
  for (let n = 0; n < all.length; n++) {
    const t = all[n];
    tile.width = t.w; tile.height = t.h;
    tctx.drawImage(source, t.x, t.y, t.w, t.h, 0, 0, t.w, t.h);
    for (const d of detector.detect(tile).detections) {
      const b = d.boundingBox, m = Math.min(t.w, t.h) * 0.02;
      // drop faces cut off by a tile edge (unless that edge is the photo's edge)
      if ((b.originX < m && t.x > 0) || (b.originY < m && t.y > 0) ||
          (b.originX + b.width > t.w - m && t.x + t.w < source.width) ||
          (b.originY + b.height > t.h - m && t.y + t.h < source.height)) continue;
      found.push({
        x: t.x + b.originX, y: t.y + b.originY, w: b.width, h: b.height,
        score: d.categories[0].score,
        eyes: d.keypoints.slice(0, 2).map((k) => ({ x: t.x + k.x * t.w, y: t.y + k.y * t.h })),
      });
    }
    if (performance.now() - last > 50) {
      postMessage({ type: "progress", id, p: (n + 1) / all.length });
      await breathe();
      if (id !== current) return null;
      last = performance.now();
    }
  }
  found.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of found) if (!keep.some((k) => overlap(k, f) > 0.4)) keep.push(f);
  return keep;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

const faceFromEyes = (a, b) => ({ c: mid(a, b), ang: Math.atan2(b.y - a.y, b.x - a.x), s: dist(a, b), fx: 1, temples: null, need: null, kind: "eyes" });

const cropCanvas = new OffscreenCanvas(CROP, CROP);
const cropCtx = cropCanvas.getContext("2d");

function refine(box) {
  const side = Math.max(box.w, box.h) * 2.2;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const ox = cx - side / 2, oy = cy - side / 2;
  cropCtx.fillStyle = "#000"; cropCtx.fillRect(0, 0, CROP, CROP);
  cropCtx.drawImage(source, ox, oy, side, side, 0, 0, CROP, CROP);
  const res = landmarker.detect(cropCanvas);
  const faces = res.faceLandmarks || [];
  const P = (lm, i) => ({ x: ox + lm[i].x * side, y: oy + lm[i].y * side });
  let best = null;
  faces.forEach((lm, i) => {
    const c = mid(mid(P(lm, 33), P(lm, 133)), mid(P(lm, 362), P(lm, 263)));
    const off = dist(c, { x: cx, y: cy });
    if (c.x < box.x || c.x > box.x + box.w || c.y < box.y || c.y > box.y + box.h) return;
    if (!best || off < best.off) best = { lm, off, m: res.facialTransformationMatrixes?.[i]?.data };
  });
  if (!best) return null;
  const { lm, m } = best;
  const eL = mid(P(lm, 33), P(lm, 133)), eR = mid(P(lm, 362), P(lm, 263));
  const ang = Math.atan2(eR.y - eL.y, eR.x - eL.x);
  // head pose (not a biometric) tells how much horizontal / vertical extents are foreshortened
  const fx = m ? Math.max(0.55, Math.hypot(m[0], m[1]) / Math.hypot(m[0], m[1], m[2])) : 1;
  const fy = m ? Math.max(0.7, Math.hypot(m[4], m[5]) / Math.hypot(m[4], m[5], m[6])) : 1;
  const scale = Math.max(dist(eL, eR) / fx, dist(P(lm, 10), P(lm, 152)) * 0.34 / fy);
  const c = P(lm, 168);   // nose bridge between the eyes
  const upOf = (p) => (p.x - c.x) * Math.sin(ang) - (p.y - c.y) * Math.cos(ang);
  return {
    c, ang, s: scale, fx, temples: [P(lm, 127), P(lm, 356)], kind: "mesh",
    // what this face needs from the shared template: reach just past the outer eye corners, and over most of the brows
    // (strongly turned heads are skipped: their far-side landmarks are guesses)
    need: fx < 0.8 ? null : {
      span: Math.max(dist(c, P(lm, 33)), dist(c, P(lm, 263))) / (scale * fx) + 0.08,
      up: Math.max(upOf(P(lm, 105)), upOf(P(lm, 334))) / scale * 0.75,
    },
  };
}

// ---------- messages ----------
onmessage = async ({ data }) => {
  try {
    await ready;
    if (data.type === "detect") {
      current = data.id;
      source?.close();
      source = data.bitmap;
      const t0 = performance.now();
      const boxes = await detectBoxes(data.minTile, data.id);
      if (!boxes) return;
      const faces = [];
      boxes.forEach((box, boxIndex) => {
        const f = (box.score >= MESH_SCORE && refine(box)) ||
          (box.score >= FALLBACK_SCORE ? faceFromEyes(box.eyes[0], box.eyes[1]) : null);
        if (f) faces.push({ ...f, boxIndex });
      });
      postMessage({ type: "result", id: data.id, boxes, faces, ms: Math.round(performance.now() - t0) });
    } else if (data.type === "refine") {
      const b = data.box;
      postMessage({ type: "refined", id: data.id, face: refine(b) || faceFromEyes(b.eyes[0], b.eyes[1]) });
    }
  } catch (e) {
    postMessage({ type: "error", message: String(e?.message || e) });
  }
};
