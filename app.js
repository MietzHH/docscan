'use strict';

const CFG = window.DOCSCAN_CONFIG || {};
const OPENCV_URL = 'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js';
const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const GSI_URL = 'https://accounts.google.com/gsi/client';
const SCOPE = 'https://www.googleapis.com/auth/drive';
const MAX_OUT = 2200;      // max. Kantenlänge einer gescannten Seite (px)
const AUTO_MS = 1200;      // so lange muss das Dokument ruhig liegen für Auto-Auslösung

const $ = s => document.querySelector(s);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LS = {
  get(k, d) { try { const v = localStorage.getItem('ds_' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ds_' + k, JSON.stringify(v)); } catch {} },
};

function settings() {
  return {
    clientId: LS.get('clientId', '') || CFG.googleClientId || '',
    mode: LS.get('mode', 'color'),
    auto: LS.get('auto', true),
  };
}

const state = {
  pages: [],
  stream: null, track: null, timer: null, busy: false, torch: false, auto: true,
  liveQuad: null, stableSince: 0, waitChange: false, capSig: null,
  editIndex: -1, edit: null, editImg: null, editScale: 1, drag: -1,
  ocr: null, nameTouched: false,
  folder: LS.get('lastFolder', null), folderPicked: false,
  token: LS.get('token', null), fstack: [],
};

/* ---------- Bildschirme & Zurück-Taste ---------- */

let current = 'home';
function show(id, push = true) {
  if (id === current) return;
  if (current === 'camera') stopCamera();
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  current = id;
  if (push) history.pushState({ screen: id }, '');
  if (id === 'camera') startCamera();
  if (id === 'finish') initFinish();
  if (id === 'home') renderHome();
  if (id === 'edit') requestAnimationFrame(drawEdit);
}
history.replaceState({ screen: 'home' }, '');
window.addEventListener('popstate', e => show((e.state && e.state.screen) || 'home', false));

/* ---------- Bibliotheken nachladen ---------- */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Konnte ' + src + ' nicht laden'));
    document.head.appendChild(s);
  });
}

let cvP = null;
function loadCv() {
  if (!cvP) cvP = (async () => {
    await loadScript(OPENCV_URL);
    if (window.cv instanceof Promise) window.cv = await window.cv;
    const t0 = Date.now();
    while (!(window.cv && window.cv.Mat)) {
      if (Date.now() - t0 > 30000) throw new Error('OpenCV-Start dauert zu lange');
      await sleep(50);
    }
    // Bewusst nichts zurückgeben: das OpenCV-Modul hat ein eigenes .then(),
    // das beim Auflösen eines Promise in eine Endlosschleife führt.
  })().catch(e => { cvP = null; throw e; });
  return cvP;
}
const cvOk = () => !!(window.cv && window.cv.Mat);

let ocrWorkerP = null;
function getOcrWorker() {
  if (!ocrWorkerP) ocrWorkerP = (async () => {
    await loadScript(TESSERACT_URL);
    return Tesseract.createWorker('deu');
  })().catch(e => { ocrWorkerP = null; throw e; });
  return ocrWorkerP;
}

let gsiP = null;
function loadGsi() {
  if (!gsiP) gsiP = loadScript(GSI_URL).catch(e => { gsiP = null; throw e; });
  return gsiP;
}

/* ---------- Bildverarbeitung (OpenCV) ---------- */

const work = document.createElement('canvas');
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function orderQuad(p) {
  const s = p.map(q => q.x + q.y), d = p.map(q => q.y - q.x);
  return [
    p[s.indexOf(Math.min(...s))],   // oben links
    p[d.indexOf(Math.min(...d))],   // oben rechts
    p[s.indexOf(Math.max(...s))],   // unten rechts
    p[d.indexOf(Math.max(...d))],   // unten links
  ];
}

function defaultQuad(w, h) {
  const mx = w * 0.05, my = h * 0.05;
  return [{ x: mx, y: my }, { x: w - mx, y: my }, { x: w - mx, y: h - my }, { x: mx, y: h - my }];
}

// Sucht das größte Viereck (= Dokument) im Bild. Liefert 4 Punkte in Quell-Koordinaten oder null.
function detectQuad(source, sw, sh, maxDim = 480) {
  const cv = window.cv;
  const scale = Math.min(1, maxDim / Math.max(sw, sh));
  const w = Math.round(sw * scale), h = Math.round(sh * scale);
  work.width = w; work.height = h;
  work.getContext('2d', { willReadFrequently: true }).drawImage(source, 0, 0, w, h);

  const src = cv.imread(work);
  const gray = new cv.Mat(), edges = new cv.Mat(), hier = new cv.Mat();
  const contours = new cv.MatVector();
  let best = null, bestArea = 0;
  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, gray, new cv.Size(5, 5), 0);
    cv.Canny(gray, edges, 40, 120);
    const k = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(edges, edges, k);
    k.delete();
    cv.findContours(edges, contours, hier, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const minArea = w * h * 0.12;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i);
      const area = cv.contourArea(c);
      if (area > minArea && area > bestArea) {
        const approx = new cv.Mat();
        cv.approxPolyDP(c, approx, 0.02 * cv.arcLength(c, true), true);
        if (approx.rows === 4 && cv.isContourConvex(approx)) {
          best = [];
          for (let j = 0; j < 4; j++) best.push({ x: approx.data32S[j * 2] / scale, y: approx.data32S[j * 2 + 1] / scale });
          bestArea = area;
        }
        approx.delete();
      }
      c.delete();
    }
  } finally {
    src.delete(); gray.delete(); edges.delete(); hier.delete(); contours.delete();
  }
  return best ? orderQuad(best) : null;
}

function enhance(mat, mode) {
  const cv = window.cv;
  if (mode === 'color') {
    mat.convertTo(mat, -1, 1.15, 10);
  } else if (mode === 'gray' || mode === 'bw') {
    const g = new cv.Mat();
    cv.cvtColor(mat, g, cv.COLOR_RGBA2GRAY);
    if (mode === 'bw') {
      const t = new cv.Mat();
      cv.adaptiveThreshold(g, t, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 25, 12);
      cv.cvtColor(t, mat, cv.COLOR_GRAY2RGBA);
      t.delete();
    } else {
      g.convertTo(g, -1, 1.2, 10);
      cv.cvtColor(g, mat, cv.COLOR_GRAY2RGBA);
    }
    g.delete();
  }
}

// Entzerrt das Viereck zu einem geraden Rechteck und wendet Filter + Drehung an.
function warp(imgEl, quad, mode, rot) {
  const cv = window.cv;
  const [tl, tr, br, bl] = quad;
  let W = Math.max(dist(tl, tr), dist(bl, br)), H = Math.max(dist(tl, bl), dist(tr, br));
  const f = Math.min(1, MAX_OUT / Math.max(W, H));
  W = Math.max(1, Math.round(W * f)); H = Math.max(1, Math.round(H * f));

  const src = cv.imread(imgEl);
  const from = cv.matFromArray(4, 1, cv.CV_32FC2, [tl.x, tl.y, tr.x, tr.y, br.x, br.y, bl.x, bl.y]);
  const to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, W, 0, W, H, 0, H]);
  const M = cv.getPerspectiveTransform(from, to);
  let dst = new cv.Mat();
  try {
    cv.warpPerspective(src, dst, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_REPLICATE, new cv.Scalar());
    enhance(dst, mode);
    if (rot) {
      const r = new cv.Mat();
      cv.rotate(dst, r, [cv.ROTATE_90_CLOCKWISE, cv.ROTATE_180, cv.ROTATE_90_COUNTERCLOCKWISE][rot - 1]);
      dst.delete(); dst = r;
    }
    const out = document.createElement('canvas');
    cv.imshow(out, dst);
    return out;
  } finally {
    src.delete(); from.delete(); to.delete(); M.delete(); dst.delete();
  }
}

/* ---------- Hilfsfunktionen ---------- */

const canvasToBlob = (c, type = 'image/jpeg', q = 0.88) => new Promise(r => c.toBlob(r, type, q));
const blobToDataUrl = b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });
function blobToImage(b) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(b);
  });
}
const pad = n => String(n).padStart(2, '0');
const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const stamp = () => { const d = new Date(); return `${isoDate(d)}_${pad(d.getHours())}-${pad(d.getMinutes())}`; };
const sanitize = s => s.replace(/[\\/:*?"<>|\n\r\t]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);

// Kleiner Bild-Fingerabdruck, um zu merken, ob eine neue Seite hingelegt wurde.
const sigCanvas = document.createElement('canvas');
sigCanvas.width = 32; sigCanvas.height = 24;
function frameSig(v) {
  const ctx = sigCanvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(v, 0, 0, 32, 24);
  const d = ctx.getImageData(0, 0, 32, 24).data, out = new Uint8Array(32 * 24);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return out;
}
function sigDiff(a, b) {
  if (!a || !b) return 999;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/* ---------- Kamera ---------- */

async function startCamera() {
  state.auto = settings().auto;
  $('#btnAuto').classList.toggle('on', state.auto);
  $('#camHint').textContent = 'Kamera startet …';
  renderThumbs();
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
      audio: false,
    });
  } catch (e) {
    alert('Kamera nicht verfügbar: ' + e.message);
    history.back();
    return;
  }
  if (current !== 'camera') { stream.getTracks().forEach(t => t.stop()); return; }
  state.stream = stream;
  state.track = stream.getVideoTracks()[0];
  const v = $('#video');
  v.srcObject = stream;
  await v.play().catch(() => {});

  const caps = state.track.getCapabilities ? state.track.getCapabilities() : {};
  $('#btnTorch').hidden = !caps.torch;
  if (caps.focusMode && caps.focusMode.includes('continuous')) {
    state.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }

  $('#camHint').textContent = 'Erkennung wird geladen …';
  try {
    await loadCv();
  } catch {
    $('#camHint').textContent = 'Erkennung nicht verfügbar – bitte manuell auslösen';
    return;
  }
  state.stableSince = 0; state.liveQuad = null;
  detectLoop();
}

function stopCamera() {
  clearTimeout(state.timer);
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = null; state.track = null; state.torch = false;
  $('#video').srcObject = null;
}

function detectLoop() {
  if (current !== 'camera' || !state.stream) return;
  const v = $('#video');
  if (v.videoWidth && !state.busy) {
    try { handleLive(detectQuad(v, v.videoWidth, v.videoHeight), v); } catch (e) { console.warn(e); }
  }
  state.timer = setTimeout(detectLoop, 120);
}

function handleLive(q, v) {
  const now = performance.now();
  const diag = Math.hypot(v.videoWidth, v.videoHeight);
  if (state.waitChange && (!q || sigDiff(frameSig(v), state.capSig) > 14)) state.waitChange = false;

  const moved = q && state.liveQuad ? Math.max(...q.map((p, i) => dist(p, state.liveQuad[i]))) / diag : 1;
  if (!q) state.stableSince = 0;
  else if (moved > 0.015 || !state.stableSince) state.stableSince = now;
  state.liveQuad = q;

  const progress = state.auto && q && !state.waitChange ? Math.min(1, (now - state.stableSince) / AUTO_MS) : 0;
  drawOverlay(q, v, progress);

  const hint = $('#camHint');
  if (state.waitChange) hint.textContent = '✓ Aufgenommen – nächste Seite hinlegen';
  else if (!q) hint.textContent = 'Dokument ins Bild halten';
  else if (state.auto) hint.textContent = 'Stillhalten …';
  else hint.textContent = 'Dokument erkannt – auslösen';

  if (state.auto && q && !state.waitChange && progress >= 1) capture();
}

function drawOverlay(q, v, progress) {
  const ov = $('#overlay'), dpr = window.devicePixelRatio || 1;
  const cw = ov.clientWidth, ch = ov.clientHeight;
  if (ov.width !== Math.round(cw * dpr) || ov.height !== Math.round(ch * dpr)) {
    ov.width = Math.round(cw * dpr); ov.height = Math.round(ch * dpr);
  }
  const ctx = ov.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cw, ch);
  if (!q) return;
  // Video wird mit object-fit: cover angezeigt → Koordinaten entsprechend umrechnen
  const s = Math.max(cw / v.videoWidth, ch / v.videoHeight);
  const ox = (cw - v.videoWidth * s) / 2, oy = (ch - v.videoHeight * s) / 2;
  ctx.beginPath();
  q.forEach((p, i) => { const x = ox + p.x * s, y = oy + p.y * s; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
  ctx.fillStyle = `rgba(34,197,94,${0.12 + 0.3 * progress})`;
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = state.waitChange ? '#facc15' : '#22c55e';
  ctx.stroke();
}

async function capture() {
  const v = $('#video');
  if (state.busy || !v.videoWidth) return;
  state.busy = true;
  const fl = $('#flash');
  fl.classList.add('on');
  setTimeout(() => fl.classList.remove('on'), 60);
  if (navigator.vibrate) navigator.vibrate(40);
  try {
    const full = document.createElement('canvas');
    full.width = v.videoWidth; full.height = v.videoHeight;
    full.getContext('2d').drawImage(v, 0, 0);

    let quad = null;
    if (cvOk()) {
      quad = detectQuad(full, full.width, full.height, 900);
      if (!quad && state.liveQuad) quad = state.liveQuad;
    }
    const page = { quad: quad || defaultQuad(full.width, full.height), mode: settings().mode, rot: 0 };
    page.orig = await canvasToBlob(full, 'image/jpeg', 0.92);
    await renderPage(page, full);
    state.pages.push(page);
    if (state.pages.length === 1) startOcr();

    state.waitChange = true;
    state.capSig = frameSig(v);
    state.stableSince = 0;
    renderThumbs();
  } catch (e) {
    alert('Aufnahme fehlgeschlagen: ' + e.message);
  } finally {
    state.busy = false;
  }
}

async function renderPage(page, srcEl) {
  const out = cvOk() ? warp(srcEl, page.quad, page.mode, page.rot) : srcEl;
  if (page.url) URL.revokeObjectURL(page.url);
  page.out = await canvasToBlob(out, 'image/jpeg', 0.85);
  page.url = URL.createObjectURL(page.out);
  page.w = out.width; page.h = out.height;
}

function renderThumbs() {
  const box = $('#thumbs');
  box.replaceChildren(...state.pages.map((p, i) => {
    const img = new Image();
    img.src = p.url;
    img.alt = 'Seite ' + (i + 1);
    img.onclick = () => openEdit(i);
    return img;
  }));
  box.scrollLeft = box.scrollWidth;
  const n = state.pages.length;
  $('#pageCount').textContent = n === 1 ? '1 Seite' : n + ' Seiten';
  $('#btnDone').disabled = n === 0;
}

/* ---------- Seite bearbeiten ---------- */

async function openEdit(i) {
  const p = state.pages[i];
  state.editIndex = i;
  state.edit = { quad: p.quad.map(q => ({ ...q })), mode: p.mode, rot: p.rot };
  state.editImg = await blobToImage(p.orig);
  $('#editNo').textContent = i + 1;
  $('#editMode').value = p.mode;
  $('#rotLabel').textContent = p.rot * 90 + '°';
  show('edit');
}

function drawEdit() {
  const img = state.editImg, cvs = $('#editCanvas'), stage = $('#editStage');
  if (!img || current !== 'edit') return;
  const s = Math.min((stage.clientWidth - 32) / img.naturalWidth, (stage.clientHeight - 32) / img.naturalHeight);
  const w = img.naturalWidth * s, h = img.naturalHeight * s, dpr = window.devicePixelRatio || 1;
  cvs.style.width = w + 'px'; cvs.style.height = h + 'px';
  cvs.width = Math.round(w * dpr); cvs.height = Math.round(h * dpr);
  state.editScale = s;

  const ctx = cvs.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.drawImage(img, 0, 0, w, h);
  const q = state.edit.quad.map(p => ({ x: p.x * s, y: p.y * s }));
  ctx.beginPath();
  ctx.rect(0, 0, w, h);
  q.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  ctx.fillStyle = 'rgba(0,0,0,.5)';
  ctx.fill('evenodd');
  ctx.beginPath();
  q.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
  ctx.closePath();
  ctx.lineWidth = 2; ctx.strokeStyle = '#22c55e'; ctx.stroke();
  q.forEach((p, i) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, i === state.drag ? 16 : 12, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(34,197,94,.35)'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
  });
}

function editPoint(e) {
  const r = $('#editCanvas').getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}
$('#editCanvas').addEventListener('pointerdown', e => {
  const pt = editPoint(e), s = state.editScale;
  let best = -1, bd = 48;
  state.edit.quad.forEach((p, i) => { const d = Math.hypot(p.x * s - pt.x, p.y * s - pt.y); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return;
  state.drag = best;
  e.target.setPointerCapture(e.pointerId);
  e.preventDefault();
  drawEdit();
});
$('#editCanvas').addEventListener('pointermove', e => {
  if (state.drag < 0) return;
  const pt = editPoint(e), s = state.editScale, img = state.editImg;
  state.edit.quad[state.drag] = {
    x: Math.min(img.naturalWidth, Math.max(0, pt.x / s)),
    y: Math.min(img.naturalHeight, Math.max(0, pt.y / s)),
  };
  drawEdit();
});
const endDrag = () => { if (state.drag >= 0) { state.drag = -1; drawEdit(); } };
$('#editCanvas').addEventListener('pointerup', endDrag);
$('#editCanvas').addEventListener('pointercancel', endDrag);
window.addEventListener('resize', () => { if (current === 'edit') drawEdit(); });

$('#btnRotate').onclick = () => {
  state.edit.rot = (state.edit.rot + 1) % 4;
  $('#rotLabel').textContent = state.edit.rot * 90 + '°';
};
$('#btnEditApply').onclick = async () => {
  const p = state.pages[state.editIndex];
  p.quad = orderQuad(state.edit.quad);
  p.mode = $('#editMode').value;
  p.rot = state.edit.rot;
  $('#btnEditApply').disabled = true;
  try {
    await renderPage(p, state.editImg);
    if (state.editIndex === 0) startOcr();
  } finally {
    $('#btnEditApply').disabled = false;
  }
  renderThumbs(); renderFinishPages();
  history.back();
};
$('#btnEditDelete').onclick = () => {
  if (!confirm('Diese Seite löschen?')) return;
  const [p] = state.pages.splice(state.editIndex, 1);
  URL.revokeObjectURL(p.url);
  if (state.editIndex === 0) startOcr();
  renderThumbs(); renderFinishPages();
  history.back();
};
$('#btnEditBack').onclick = () => history.back();

/* ---------- Texterkennung & Dateiname ---------- */

const TYPES = [
  ['Mahnung', /mahnung|zahlungserinnerung/i],
  ['Gutschrift', /gutschrift/i],
  ['Lohnabrechnung', /lohnabrechnung|gehaltsabrechnung|entgeltabrechnung|verdienstabrechnung/i],
  ['Kontoauszug', /kontoauszug/i],
  ['Steuerbescheid', /steuerbescheid|bescheid für \d{4} über/i],
  ['Kündigung', /kündigung|kuendigung/i],
  ['Auftragsbestätigung', /auftragsbestätigung|bestellbestätigung/i],
  ['Angebot', /\bangebot\b|kostenvoranschlag/i],
  ['Lieferschein', /lieferschein/i],
  ['Rechnung', /rechnung|invoice/i],
  ['Bescheid', /bescheid/i],
  ['Vertrag', /\bvertrag\b|vereinbarung/i],
  ['Quittung', /quittung|kassenbon|kassenbeleg|\bbon\b/i],
  ['Versicherung', /versicherungsschein|\bpolice\b|versicherung/i],
  ['Bescheinigung', /bescheinigung|nachweis/i],
  ['Arztbrief', /arztbrief|befund|diagnose/i],
  ['Brief', /sehr geehrte|freundlichen grüßen/i],
];

const MONTHS = { jan: 1, feb: 2, mär: 3, mar: 3, mrz: 3, apr: 4, mai: 5, jun: 6, jul: 7, aug: 8, sep: 9, okt: 10, nov: 11, dez: 12 };

function findDate(text) {
  const now = new Date(), cands = [];
  const add = (d, m, y, idx) => {
    if (y < 100) y += 2000;
    if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > now.getFullYear() + 1) return;
    const before = text.slice(Math.max(0, idx - 40), idx);
    const score = /datum|vom|date|stand/i.test(before) ? 10 : 0;
    cands.push({ iso: `${y}-${pad(m)}-${pad(d)}`, score, idx });
  };
  let m;
  const re1 = /\b(\d{1,2})\s?[./-]\s?(\d{1,2})\s?[./-]\s?(\d{4}|\d{2})\b/g;
  while ((m = re1.exec(text))) add(+m[1], +m[2], +m[3], m.index);
  const re2 = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
  while ((m = re2.exec(text))) add(+m[3], +m[2], +m[1], m.index);
  const re3 = /\b(\d{1,2})\.?\s+(jan|feb|mär|mar|mrz|apr|mai|jun|jul|aug|sep|okt|nov|dez)[a-zä]*\.?\s+(\d{4})\b/gi;
  while ((m = re3.exec(text))) add(+m[1], MONTHS[m[2].toLowerCase()], +m[3], m.index);
  cands.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return cands.length ? cands[0].iso : null;
}

const LEGAL = /\b(gmbh\s*&\s*co\.?\s*kg|gmbh|mbh|ag|kg|ohg|gbr|ug|e\.\s?k\.?|e\.\s?v\.?|se|ltd\.?|inc\.?|llc)\b/i;
const INSTITUTION = /\b(finanzamt|sparkasse|volksbank|bank|stadtwerke|krankenkasse|aok|barmer|dak|versicherung|amt|stadt|gemeinde|rentenversicherung|agentur für arbeit|jobcenter)\b/i;

function findSender(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 2).slice(0, 30);
  for (const l of lines) {
    const m = l.match(LEGAL);
    if (m) {
      const words = l.slice(0, m.index).replace(/^.*?(absender|von)\s*:?\s*/i, '').split(/[\s,·|•]+/).filter(Boolean);
      const name = words.slice(-4).join(' ').replace(/[^\p{L}\p{N}&.\- ]/gu, '').trim();
      if (name.length >= 2) return name;
    }
  }
  for (const l of lines) {
    if (INSTITUTION.test(l) && l.length < 50) return l.replace(/[^\p{L}\p{N}&.\- ]/gu, '').trim();
  }
  for (const l of lines.slice(0, 6)) {
    const letters = (l.match(/\p{L}/gu) || []).length;
    if (letters >= 4 && letters / l.length > 0.7 && l.length < 40 && !/rechnung|datum|seite|tel|fax|www|@|straße|str\./i.test(l)) {
      return l.replace(/[^\p{L}\p{N}&.\- ]/gu, '').trim();
    }
  }
  return null;
}

function analyzeText(text) {
  const head = text.slice(0, 1500);
  const type = (TYPES.find(([, re]) => re.test(head)) || TYPES.find(([, re]) => re.test(text)) || ['Dokument'])[0];
  return { date: findDate(text), type, sender: findSender(text) };
}

function buildName(a) {
  const parts = [a.date || isoDate(new Date()), a.type, a.sender].filter(Boolean)
    .map(p => sanitize(p).replace(/\s+/g, '-'));
  return parts.join('_');
}

function startOcr() {
  const first = state.pages[0];
  if (!first) { state.ocr = null; return; }
  const job = { page: first, result: null, error: null };
  state.ocr = job;
  job.promise = (async () => {
    try {
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(first.out);
      job.result = analyzeText(data.text || '');
    } catch (e) {
      job.error = e;
    }
    if (state.ocr === job && current === 'finish') applyOcr();
  })();
}

function applyOcr() {
  const job = state.ocr, st = $('#ocrStatus');
  if (!job) { st.textContent = ''; return; }
  if (job.error) { st.textContent = '⚠ Texterkennung fehlgeschlagen – bitte Namen selbst eingeben'; return; }
  if (!job.result) { st.textContent = '🔎 Text wird erkannt …'; return; }
  const a = job.result;
  st.textContent = '✓ Erkannt: ' + [a.type, a.sender, a.date].filter(Boolean).join(' · ');
  if (!state.nameTouched) $('#fileName').value = buildName(a);
  if (!state.folderPicked) {
    const fav = suggestFolder(a);
    if (fav) { state.folder = fav; renderFolder(); }
  }
}

// Wählt aus den gemerkten Ordnern den passenden (z. B. „Rechnungen“ für eine Rechnung).
function suggestFolder(a) {
  const favs = LS.get('folders', []);
  const type = a.type.toLowerCase().slice(0, 6);
  const sender = (a.sender || '').toLowerCase();
  return favs.find(f => f.name.toLowerCase().includes(type))
    || favs.find(f => sender && f.name.length > 2 && sender.includes(f.name.toLowerCase()))
    || null;
}

/* ---------- Speichern-Bildschirm ---------- */

function initFinish() {
  renderFinishPages();
  if (!$('#fileName').value) $('#fileName').value = 'Scan_' + stamp();
  applyOcr();
  renderFolder();
  $('#uploadStatus').textContent = '';
}

function renderFinishPages() {
  $('#finishPages').replaceChildren(...state.pages.map((p, i) => {
    const fig = document.createElement('figure');
    const img = new Image();
    img.src = p.url;
    img.onclick = () => openEdit(i);
    const cap = document.createElement('figcaption');
    cap.textContent = i + 1;
    fig.append(img, cap);
    return fig;
  }));
}

function renderFolder() {
  $('#folderLabel').textContent = state.folder ? state.folder.path : 'Ordner wählen';
  const favs = LS.get('folders', []);
  $('#folderChips').replaceChildren(...favs.map(f => {
    const b = document.createElement('button');
    b.textContent = f.name;
    b.title = f.path;
    b.classList.toggle('sel', !!state.folder && state.folder.id === f.id);
    b.onclick = () => { state.folder = f; state.folderPicked = true; renderFolder(); };
    b.oncontextmenu = e => {
      e.preventDefault();
      if (confirm(`„${f.name}“ aus den Favoriten entfernen?`)) {
        LS.set('folders', LS.get('folders', []).filter(x => x.id !== f.id));
        renderFolder();
      }
    };
    return b;
  }));
}

function addFavorite(f) {
  const favs = LS.get('folders', []).filter(x => x.id !== f.id);
  favs.unshift(f);
  LS.set('folders', favs.slice(0, 8));
}

$('#fileName').addEventListener('input', () => { state.nameTouched = true; });

/* ---------- Google Drive ---------- */

function ensureToken() {
  const t = state.token;
  if (t && t.exp > Date.now() + 60000) return Promise.resolve(t.value);
  const { clientId } = settings();
  if (!clientId) return Promise.reject(new Error('Bitte zuerst die Google Client-ID in den Einstellungen eintragen.'));
  return loadGsi().then(() => new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: r => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        state.token = { value: r.access_token, exp: Date.now() + r.expires_in * 1000 };
        LS.set('token', state.token);
        LS.set('consented', true);
        resolve(r.access_token);
      },
      error_callback: e => reject(new Error(e.type === 'popup_closed' ? 'Anmeldung abgebrochen' : (e.message || e.type))),
    });
    client.requestAccessToken({ prompt: LS.get('consented', false) ? '' : 'consent' });
  }));
}

async function driveFetch(url, opts = {}) {
  const token = await ensureToken();
  const r = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token } });
  if (r.status === 401) {
    state.token = null; LS.set('token', null);
    throw new Error('Google-Anmeldung abgelaufen – bitte nochmal versuchen');
  }
  if (!r.ok) throw new Error('Google Drive: ' + r.status + ' ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function openFolderDlg() {
  try { await ensureToken(); } catch (e) { alert(e.message); return; }
  state.fstack = [{ id: 'root', name: 'Meine Ablage' }];
  $('#folderDlg').showModal();
  loadFolderList();
}

async function loadFolderList() {
  const cur = state.fstack[state.fstack.length - 1];
  $('#folderPath').textContent = state.fstack.map(f => f.name).join(' / ');
  $('#btnFolderUp').disabled = state.fstack.length < 2;
  const list = $('#folderList');
  list.innerHTML = '<li class="muted">Lade …</li>';
  try {
    const q = `'${cur.id}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const r = await driveFetch('https://www.googleapis.com/drive/v3/files?pageSize=300&orderBy=name&fields=files(id,name)&q=' + encodeURIComponent(q));
    if (!r.files.length) { list.innerHTML = '<li class="muted">Keine Unterordner</li>'; return; }
    list.replaceChildren(...r.files.map(f => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.textContent = '📁 ' + f.name;
      b.onclick = () => { state.fstack.push({ id: f.id, name: f.name }); loadFolderList(); };
      li.append(b);
      return li;
    }));
  } catch (e) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: '⚠ ' + e.message }));
  }
}

$('#btnPickFolder').onclick = openFolderDlg;
$('#btnFolderClose').onclick = () => $('#folderDlg').close();
$('#btnFolderUp').onclick = () => { if (state.fstack.length > 1) { state.fstack.pop(); loadFolderList(); } };
$('#btnFolderChoose').onclick = () => {
  const cur = state.fstack[state.fstack.length - 1];
  state.folder = { id: cur.id, name: cur.name, path: state.fstack.map(f => f.name).join(' / ') };
  state.folderPicked = true;
  addFavorite(state.folder);
  $('#folderDlg').close();
  renderFolder();
};
$('#btnFolderNew').onclick = async () => {
  const name = prompt('Name des neuen Ordners:');
  if (!name || !name.trim()) return;
  const cur = state.fstack[state.fstack.length - 1];
  try {
    await driveFetch('https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), mimeType: 'application/vnd.google-apps.folder', parents: [cur.id] }),
    });
    loadFolderList();
  } catch (e) { alert(e.message); }
};

async function buildPdf() {
  const { jsPDF } = window.jspdf;
  let doc = null;
  for (const p of state.pages) {
    // Längere Seite = 297 mm (A4-Höhe), Seitenverhältnis bleibt erhalten
    let w, h;
    if (p.h >= p.w) { h = 297; w = 297 * p.w / p.h; } else { w = 297; h = 297 * p.h / p.w; }
    const o = w > h ? 'l' : 'p';
    if (!doc) doc = new jsPDF({ orientation: o, unit: 'mm', format: [w, h], compress: true });
    else doc.addPage([w, h], o);
    doc.addImage(await blobToDataUrl(p.out), 'JPEG', 0, 0, w, h, undefined, 'FAST');
  }
  return doc.output('blob');
}

async function upload() {
  const st = $('#uploadStatus'), btn = $('#btnUpload');
  if (!state.pages.length) return;
  if (!state.folder) { st.textContent = 'Bitte zuerst einen Ordner wählen.'; return; }
  const name = (sanitize($('#fileName').value) || 'Scan_' + stamp()).replace(/\.pdf$/i, '') + '.pdf';
  btn.disabled = true;
  try {
    st.textContent = 'Anmelden …';
    await ensureToken();
    st.textContent = 'PDF wird erstellt …';
    const pdf = await buildPdf();
    st.textContent = 'Wird hochgeladen …';
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({ name, mimeType: 'application/pdf', parents: [state.folder.id] })], { type: 'application/json' }));
    form.append('file', pdf, name);
    const f = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
      method: 'POST', body: form,
    });

    addFavorite(state.folder);
    LS.set('lastFolder', state.folder);
    const recent = LS.get('recent', []);
    recent.unshift({ name: f.name, link: f.webViewLink, folder: state.folder.path, date: new Date().toISOString() });
    LS.set('recent', recent.slice(0, 15));

    st.textContent = '✓ Gespeichert in ' + state.folder.path;
    if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
    await sleep(1200);
    resetScan();
    history.go(-2);   // Speichern → Kamera → Start
  } catch (e) {
    st.textContent = '⚠ ' + e.message;
  } finally {
    btn.disabled = false;
  }
}
$('#btnUpload').onclick = upload;

function resetScan() {
  state.pages.forEach(p => URL.revokeObjectURL(p.url));
  state.pages = [];
  state.ocr = null;
  state.nameTouched = false;
  state.folderPicked = false;
  state.folder = LS.get('lastFolder', null);
  $('#fileName').value = '';
  $('#ocrStatus').textContent = '';
}

/* ---------- Start & Einstellungen ---------- */

function renderHome() {
  const s = settings();
  const lines = [
    s.clientId ? '✓ Google Drive ist eingerichtet' : '⚠ Google Drive noch nicht eingerichtet → ⚙ Einstellungen',
  ];
  $('#status').replaceChildren(...lines.map(t => Object.assign(document.createElement('span'), { textContent: t })));
  const recent = LS.get('recent', []);
  const list = $('#recentList');
  if (!recent.length) {
    list.replaceChildren(Object.assign(document.createElement('li'), { className: 'muted', textContent: 'Noch nichts hochgeladen.' }));
    return;
  }
  list.replaceChildren(...recent.map(r => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = r.link || '#'; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = r.name;
    const sm = document.createElement('small');
    sm.textContent = r.folder + ' · ' + new Date(r.date).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
    a.append(sm); li.append(a);
    return li;
  }));
}

function openSettings() {
  const s = settings();
  $('#setClientId').value = s.clientId;
  $('#setMode').value = s.mode;
  $('#setAuto').checked = s.auto;
  $('#originHint').textContent = location.origin;
  show('settings');
}

$('#btnSettings').onclick = openSettings;
$('#btnSettingsBack').onclick = () => history.back();
$('#btnSettingsSave').onclick = () => {
  LS.set('clientId', $('#setClientId').value.trim());
  LS.set('mode', $('#setMode').value);
  LS.set('auto', $('#setAuto').checked);
  if (settings().clientId) loadGsi().catch(() => {});
  history.back();
};
$('#btnLogout').onclick = () => {
  if (state.token && window.google && google.accounts) google.accounts.oauth2.revoke(state.token.value, () => {});
  state.token = null;
  LS.set('token', null);
  LS.set('consented', false);
  alert('Abgemeldet.');
};

$('#btnNewScan').onclick = () => { resetScan(); show('camera'); };
$('#btnCamClose').onclick = () => {
  if (state.pages.length && !confirm('Scan verwerfen?')) return;
  resetScan();
  history.back();
};
$('#btnShutter').onclick = () => capture();
$('#btnDone').onclick = () => show('finish');
$('#btnAuto').onclick = () => {
  state.auto = !state.auto;
  LS.set('auto', state.auto);
  $('#btnAuto').classList.toggle('on', state.auto);
  state.stableSince = 0;
};
$('#btnTorch').onclick = () => {
  if (!state.track) return;
  state.torch = !state.torch;
  state.track.applyConstraints({ advanced: [{ torch: state.torch }] }).catch(() => {});
};
$('#btnFinishBack').onclick = () => history.back();
$('#btnAddPage').onclick = () => history.back();

renderHome();
if (settings().clientId) loadGsi().catch(() => {});
// Erkennung im Hintergrund vorladen, damit die Kamera schneller bereit ist
setTimeout(() => loadCv().catch(() => {}), 1500);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
