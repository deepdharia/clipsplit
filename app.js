'use strict';
/* =========================================================================
 * ClipSplit — free online video splitter (100% client-side, powered by Mediabunny)
 *
 * Two engines:
 *  1. FAST PATH ("Original" format): stream-copy. Packets are routed from an
 *     EncodedPacketSink straight into EncodedVideoPacketSource /
 *     EncodedAudioPacketSource. No re-encode => lossless & very fast.
 *     Cuts snap to the nearest keyframe at/before the requested point.
 *  2. RE-ENCODE ("9:16 crop", "9:16 blur bg", "1:1"): decode each frame with
 *     VideoSampleSink, composite on canvas, encode H.264 via CanvasSource.
 *     Audio is still stream-copied untouched.
 * ========================================================================= */

const MB_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.0/dist/bundles/mediabunny.min.mjs';
const JSZIP_URL = 'https://cdn.jsdelivr.net/npm/jszip@3.10.2/dist/jszip.min.js';
const REORDER_GRACE = 2; // seconds past a segment end to keep scanning, so trailing B-frames aren't lost

const $ = (id) => document.getElementById(id);

const state = {
  MB: null,
  file: null,
  input: null,
  vTrack: null,
  aTrack: null,
  vCodec: null,
  aCodec: null,
  vDecCfg: null,
  aDecCfg: null,
  duration: 0,      // seconds of content
  t0: 0,            // first timestamp of the video track
  dispW: 0, dispH: 0,
  codedW: 0, codedH: 0,
  rotation: 0,
  mode: 'every',
  everySec: 30,
  cuts: [],
  format: 'original',
  quality: 'medium',
  clips: [],
  thumbSink: null,
  videoURL: null,
  splitting: false,
};

/* ---------------- helpers ---------------- */
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const even = (n) => Math.max(2, Math.round(n / 2) * 2);

function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m + ':' + String(sec).padStart(2, '0');
}
function fmtTimeMs(s) {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 10);
  return m + ':' + String(sec).padStart(2, '0') + '.' + ms;
}
function parseTime(str) {
  if (str == null) return NaN;
  str = String(str).trim().replace(',', '.');
  if (str === '') return NaN;
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  const parts = str.split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}
function fmtBytes(b) {
  if (b < 1024) return b + ' B';
  const u = ['KB', 'MB', 'GB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < u.length - 1);
  return b.toFixed(b >= 10 ? 0 : 1) + ' ' + u[i];
}
function sanitizeName(n) {
  return n.replace(/\.[^.]+$/, '').replace(/[^\w\-. ]+/g, '_').slice(0, 60) || 'video';
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(s);
  });
}
async function loadMediabunny() {
  if (state.MB) return state.MB;
  try {
    state.MB = await import(/* webpackIgnore: true */ MB_URL);
  } catch (e) {
    throw new Error('Could not load the video engine (network needed once). Check your connection and try again.');
  }
  return state.MB;
}
async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  await loadScript(JSZIP_URL);
  if (!window.JSZip) throw new Error('Could not load the ZIP library. Check your connection and try again.');
  return window.JSZip;
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
function toast(msg, isErr) {
  // Minimal inline error surface: reuse the plan summary box for errors.
  const el = $('planSummary');
  el.innerHTML = `<span style="color:${isErr ? '#b3261e' : 'inherit'}">${msg}</span>`;
  if (isErr) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ---------------- file intake & analysis ---------------- */
function resetState() {
  if (state.input) { try { state.input.dispose(); } catch (_) {} }
  if (state.videoURL) URL.revokeObjectURL(state.videoURL);
  Object.assign(state, {
    file: null, input: null, vTrack: null, aTrack: null,
    vCodec: null, aCodec: null, vDecCfg: null, aDecCfg: null,
    duration: 0, t0: 0, dispW: 0, dispH: 0, codedW: 0, codedH: 0,
    rotation: 0, cuts: [], clips: [], thumbSink: null, videoURL: null,
  });
  $('results').hidden = true;
  $('clipGrid').innerHTML = '';
}

async function handleFile(file) {
  if (!file || state.splitting) return;
  resetState();
  $('dzLoading').hidden = false;
  $('dzLoadingText').textContent = 'Loading video engine…';
  try {
    const MB = await loadMediabunny();
    $('dzLoadingText').textContent = 'Reading your video…';
    state.file = file;
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    state.input = input;

    const vTrack = await input.getPrimaryVideoTrack();
    if (!vTrack) throw new Error('No video track found in this file.');
    state.vTrack = vTrack;
    state.aTrack = await input.getPrimaryAudioTrack();

    if (!(await vTrack.canDecode())) {
      throw new Error('Your browser can\u2019t decode this video\u2019s codec. Try a standard H.264 MP4 file.');
    }
    state.vCodec = await vTrack.getCodec();
    if (!state.vCodec) throw new Error('Could not identify this video\u2019s codec.');
    state.vDecCfg = await vTrack.getDecoderConfig().catch(() => null);
    if (state.aTrack) {
      state.aCodec = await state.aTrack.getCodec();
      state.aDecCfg = await state.aTrack.getDecoderConfig().catch(() => null);
    }

    state.t0 = await vTrack.getFirstTimestamp().catch(() => 0) || 0;
    const dur = await vTrack.computeDuration().catch(() => null);
    state.duration = dur && dur > 0 ? dur - state.t0 : 0;
    if (!(state.duration > 0)) throw new Error('Could not determine this video\u2019s duration.');

    state.codedW = await vTrack.getCodedWidth();
    state.codedH = await vTrack.getCodedHeight();
    state.rotation = await vTrack.getRotation().catch(() => 0);
    // Display dims are post-rotation; fall back to coded dims if unavailable.
    try {
      state.dispW = await vTrack.getDisplayWidth();
      state.dispH = await vTrack.getDisplayHeight();
    } catch (_) { /* fall through */ }
    if (!(state.dispW > 0) || !(state.dispH > 0)) {
      state.dispW = (state.rotation === 90 || state.rotation === 270) ? state.codedH : state.codedW;
      state.dispH = (state.rotation === 90 || state.rotation === 270) ? state.codedW : state.codedH;
    }

    state.thumbSink = new MB.CanvasSink(vTrack);

    // Preview
    state.videoURL = URL.createObjectURL(file);
    const pv = $('previewVideo');
    pv.src = state.videoURL;

    $('fileMeta').textContent =
      `${file.name} · ${fmtTime(state.duration)} · ${state.dispW}×${state.dispH}` +
      (state.aTrack ? ' · with audio' : ' · no audio') +
      ` · ${fmtBytes(file.size)}`;

    $('dropzone').style.display = 'none';
    $('dzError').hidden = true;
    $('editor').hidden = false;
    updatePlanUI();
    $('tool').scrollIntoView({ behavior: 'smooth' });
  } catch (err) {
    console.error(err);
    resetState();
    $('editor').hidden = true;
    $('dropzone').style.display = '';
    const de = $('dzError');
    de.textContent = '⚠️ ' + (err.message || 'Could not read this video.');
    de.hidden = false;
  } finally {
    $('dzLoading').hidden = true;
  }
}

/* ---------------- split plan ---------------- */
function computeBounds() {
  const D = state.duration, t0 = state.t0;
  const end = t0 + D;
  let bounds;
  if (state.mode === 'equal') {
    const n = clamp(Math.round(Number($('equalCount').value) || 4), 2, 200);
    bounds = Array.from({ length: n + 1 }, (_, i) => t0 + (D * i) / n);
  } else if (state.mode === 'every') {
    const custom = parseFloat($('everyCustom').value);
    const sec = custom > 0 ? custom : state.everySec;
    bounds = [t0];
    let t = t0 + sec;
    while (t < end - 0.25) { bounds.push(t); t += sec; }
    bounds.push(end);
  } else if (state.mode === 'custom') {
    const cuts = [...state.cuts].sort((a, b) => a - b).filter((c) => c > t0 + 0.25 && c < end - 0.25);
    bounds = [t0, ...cuts, end];
  } else { // range
    const s = clamp(parseTime($('rangeStart').value), t0, end);
    let e = parseTime($('rangeEnd').value);
    if (!(e > s)) e = Math.min(end, s + 30);
    e = clamp(e, t0, end);
    if (!(e > s)) throw new Error('End time must be after the start time.');
    bounds = [s, e];
  }
  // Merge near-duplicate bounds (avoid zero-length clips)
  const merged = [bounds[0]];
  for (let i = 1; i < bounds.length; i++) {
    if (bounds[i] - merged[merged.length - 1] > 0.25) merged.push(bounds[i]);
  }
  return merged;
}

function updatePlanUI() {
  if (!state.file) return;
  let html = '';
  try {
    const bounds = computeBounds();
    const n = bounds.length - 1;
    const avg = state.duration / n;
    html = `<strong>${n} clip${n === 1 ? '' : 's'}</strong> · avg ${fmtTime(avg)} each` +
      (state.format === 'original'
        ? ' · <strong>lossless</strong>, cuts snap to keyframes'
        : ` · re-encoded ${state.format === 'square' ? '1:1' : '9:16'} (${state.quality} quality)`);
    if (state.mode === 'equal') $('equalHint').textContent = `Each part ≈ ${fmtTime(avg)}.`;
    if (state.mode === 'every') $('everyHint').textContent = `${n} clips of ≈ ${fmtTime(avg)} (last may be shorter).`;
    if (state.mode === 'range') $('rangeHint').textContent = `One clip of ${fmtTime(bounds[1] - bounds[0])}.`;
    renderTimeline(bounds);
  } catch (err) {
    html = `<span style="color:#b3261e">${err.message}</span>`;
  }
  $('planSummary').innerHTML = html;
}

/* ---------------- timeline ---------------- */
function renderTimeline(bounds) {
  const D = state.duration, t0 = state.t0;
  const box = $('timelineMarkers');
  box.innerHTML = '';
  $('tDur').textContent = fmtTime(D);
  const cuts = state.mode === 'custom'
    ? [...state.cuts].sort((a, b) => a - b)
    : bounds.slice(1, -1);
  for (const c of cuts) {
    const m = document.createElement('div');
    m.className = 'cut-marker';
    m.style.left = ((c - t0) / D * 100) + '%';
    m.title = fmtTimeMs(c - t0) + (state.mode === 'custom' ? ' — click to remove' : '');
    if (state.mode === 'custom') {
      m.addEventListener('click', (ev) => {
        ev.stopPropagation();
        state.cuts = state.cuts.filter((x) => Math.abs(x - c) > 0.001);
        updatePlanUI();
      });
    }
    box.appendChild(m);
  }
  const chips = $('cutChips');
  chips.innerHTML = '';
  if (state.mode === 'custom') {
    for (const c of cuts) {
      const chip = document.createElement('span');
      chip.className = 'cut-chip';
      chip.innerHTML = `${fmtTimeMs(c - t0)} <button aria-label="Remove cut at ${fmtTime(c - t0)}">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => {
        state.cuts = state.cuts.filter((x) => Math.abs(x - c) > 0.001);
        updatePlanUI();
      });
      chips.appendChild(chip);
    }
    if (!cuts.length) chips.innerHTML = '<span class="hint">No cuts yet — click the timeline or add one above.</span>';
  }
}

/* ---------------- fast path: lossless stream copy ---------------- */
async function splitFastSegment(seg, onTick) {
  const MB = state.MB;
  const { vTrack, aTrack, vCodec, aCodec, vDecCfg, aDecCfg } = state;
  const vSink = new MB.EncodedPacketSink(vTrack);
  const aSink = aTrack ? new MB.EncodedPacketSink(aTrack) : null;

  // Snap the start to the nearest keyframe at/before the requested start.
  let startKey = await vSink.getKeyPacket(seg.start, { verifyKeyPackets: true }).catch(() => null);
  if (!startKey || startKey.timestamp > seg.start) startKey = await vSink.getFirstPacket();
  if (!startKey) throw new Error('Could not read video packets.');
  const actualStart = startKey.timestamp;

  const out = new MB.Output({
    format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new MB.BufferTarget(),
  });
  const vSrc = new MB.EncodedVideoPacketSource(vCodec);
  const vMeta = { ...(vDecCfg ? { decoderConfig: vDecCfg } : {}), ...(state.rotation ? { rotation: state.rotation } : {}) };
  out.addVideoTrack(vSrc, vMeta);
  let aSrc = null;
  if (aTrack && aCodec) {
    aSrc = new MB.EncodedAudioPacketSource(aCodec);
    out.addAudioTrack(aSrc, aDecCfg ? { decoderConfig: aDecCfg } : undefined);
  }
  await out.start();

  let actualEnd = actualStart;
  let firstV = true, firstA = true;
  let vMetaSent = false;

  for await (const p of vSink.packets(startKey)) {
    if (!firstV && p.type === 'key' && p.timestamp >= seg.end + REORDER_GRACE) break;
    firstV = false;
    if (p.timestamp < actualStart || p.timestamp >= seg.end) continue; // startKey itself has ts === actualStart
    const meta = !vMetaSent && vDecCfg ? { decoderConfig: vDecCfg } : undefined;
    vMetaSent = true;
    await vSrc.add(p.clone({ timestamp: p.timestamp - actualStart }), meta);
    const e = p.timestamp + p.duration;
    if (e > actualEnd) actualEnd = e;
    if (onTick) onTick();
  }

  if (aSink && aSrc) {
    let aStart = await aSink.getPacket(seg.start).catch(() => null);
    if (!aStart) aStart = await aSink.getFirstPacket();
    if (aStart) {
      for await (const p of aSink.packets(aStart)) {
        if (p.timestamp >= seg.end) break; // audio packets are in presentation order
        if (p.timestamp + p.duration <= actualStart) continue;
        const meta = firstA && aDecCfg ? { decoderConfig: aDecCfg } : undefined;
        firstA = false;
        await aSrc.add(p.clone({ timestamp: Math.max(0, p.timestamp - actualStart) }), meta);
        const e = p.timestamp + p.duration;
        if (e > actualEnd) actualEnd = e;
      }
    }
  }

  vSrc.close();
  if (aSrc) aSrc.close();
  await out.finalize();
  const buf = out.target.buffer;
  if (!buf) throw new Error('Encoding produced no data.');
  return { blob: new Blob([buf], { type: 'video/mp4' }), actualStart, actualEnd };
}

/* ---------------- re-encode path: 9:16 / 1:1 / quality ---------------- */
function outputLayout() {
  const { dispW: dw, dispH: dh, format } = state;
  if (format === 'v-crop') {
    let ow = even(dh * 9 / 16), oh = dh;
    if (ow > dw) { ow = dw; oh = even(dw * 16 / 9); }
    return { ow, oh, kind: 'crop' };
  }
  if (format === 'v-blur') return { ow: 720, oh: 1280, kind: 'blur' };
  if (format === 'square') {
    const s = even(Math.min(dw, dh));
    return { ow: s, oh: s, kind: 'crop' };
  }
  return { ow: dw, oh: dh, kind: 'copy' };
}

// Draw one decoded frame into the output canvas per the chosen layout.
function drawFrame(outCtx, dispCanvas, layout) {
  const { ow, oh, kind } = layout;
  const dw = dispCanvas.width, dh = dispCanvas.height;
  outCtx.save();
  outCtx.clearRect(0, 0, ow, oh);
  if (kind === 'crop') {
    const scale = Math.max(ow / dw, oh / dh);
    const sw = ow / scale, sh = oh / scale;
    outCtx.drawImage(dispCanvas, (dw - sw) / 2, (dh - sh) / 2, sw, sh, 0, 0, ow, oh);
  } else if (kind === 'blur') {
    // Blurred cover background…
    const cover = Math.max(ow / dw, oh / dh);
    const bw = ow / cover, bh = oh / cover;
    if ('filter' in outCtx) {
      outCtx.filter = 'blur(28px) brightness(0.85)';
      outCtx.drawImage(dispCanvas, (dw - bw) / 2, (dh - bh) / 2, bw, bh, -20, -20, ow + 40, oh + 40);
      outCtx.filter = 'none';
    } else {
      const g = outCtx.createLinearGradient(0, 0, 0, oh);
      g.addColorStop(0, '#1b1530'); g.addColorStop(1, '#0d0a18');
      outCtx.fillStyle = g; outCtx.fillRect(0, 0, ow, oh);
    }
    // …with the sharp frame contained on top.
    const cont = Math.min(ow / dw, oh / dh);
    const fw = dw * cont, fh = dh * cont;
    outCtx.drawImage(dispCanvas, 0, 0, dw, dh, (ow - fw) / 2, (oh - fh) / 2, fw, fh);
  } else {
    outCtx.drawImage(dispCanvas, 0, 0, ow, oh);
  }
  outCtx.restore();
}

async function splitReencodeSegment(seg, onFrame) {
  const MB = state.MB;
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') {
    throw new Error('Your browser doesn\u2019t support video encoding (WebCodecs). Use “Original” format instead, or try Chrome/Edge.');
  }
  const layout = outputLayout();
  const { codedW, codedH, rotation } = state;

  const sampleSink = new MB.VideoSampleSink(state.vTrack);
  const aSink = state.aTrack ? new MB.EncodedPacketSink(state.aTrack) : null;

  // Reused canvases: raw coded frame -> rotation-baked display frame -> output frame.
  const rawCanvas = document.createElement('canvas');
  rawCanvas.width = codedW; rawCanvas.height = codedH;
  const rawCtx = rawCanvas.getContext('2d');
  const dispCanvas = document.createElement('canvas');
  dispCanvas.width = state.dispW; dispCanvas.height = state.dispH;
  const dispCtx = dispCanvas.getContext('2d');
  const outCanvas = document.createElement('canvas');
  outCanvas.width = layout.ow; outCanvas.height = layout.oh;
  const outCtx = outCanvas.getContext('2d');

  const qMap = { high: 'high', medium: 'medium', low: 'low' };
  const canvasSrc = new MB.CanvasSource(outCanvas, {
    codec: 'avc',
    quality: new MB.Quality(qMap[state.quality] || 'medium'),
    keyFrameInterval: 2,
  });
  const out = new MB.Output({
    format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new MB.BufferTarget(),
  });
  out.addVideoTrack(canvasSrc);
  let aSrc = null;
  if (aSink && state.aCodec) {
    aSrc = new MB.EncodedAudioPacketSource(state.aCodec);
    out.addAudioTrack(aSrc, state.aDecCfg ? { decoderConfig: state.aDecCfg } : undefined);
  }
  await out.start();

  let actualEnd = seg.start;
  let frames = 0;
  try {
    for await (const sample of sampleSink.samples(seg.start, seg.end)) {
      try {
        sample.draw(rawCtx, 0, 0, codedW, codedH);
        // Bake rotation into the display canvas.
        dispCtx.save();
        dispCtx.clearRect(0, 0, dispCanvas.width, dispCanvas.height);
        dispCtx.translate(dispCanvas.width / 2, dispCanvas.height / 2);
        dispCtx.rotate((rotation * Math.PI) / 180);
        dispCtx.drawImage(rawCanvas, -codedW / 2, -codedH / 2, codedW, codedH);
        dispCtx.restore();
        drawFrame(outCtx, dispCanvas, layout);
        await canvasSrc.add(Math.max(0, sample.timestamp - seg.start), sample.duration || 1 / 30);
        const e = sample.timestamp + (sample.duration || 0);
        if (e > actualEnd) actualEnd = e;
        frames++;
        if (onFrame && frames % 15 === 0) onFrame(frames);
      } finally {
        sample.close();
      }
    }
  } catch (err) {
    throw new Error('Video decoding/encoding failed: ' + (err.message || err));
  }

  if (aSink && aSrc) {
    let aStart = await aSink.getPacket(seg.start).catch(() => null);
    if (!aStart) aStart = await aSink.getFirstPacket();
    if (aStart) {
      let firstA = true;
      for await (const p of aSink.packets(aStart)) {
        if (p.timestamp >= seg.end) break;
        if (p.timestamp + p.duration <= seg.start) continue;
        const meta = firstA && state.aDecCfg ? { decoderConfig: state.aDecCfg } : undefined;
        firstA = false;
        await aSrc.add(p.clone({ timestamp: Math.max(0, p.timestamp - seg.start) }), meta);
        const e = p.timestamp + p.duration;
        if (e > actualEnd) actualEnd = e;
      }
    }
  }

  canvasSrc.close();
  if (aSrc) aSrc.close();
  await out.finalize();
  const buf = out.target.buffer;
  if (!buf) throw new Error('Encoding produced no data.');
  return { blob: new Blob([buf], { type: 'video/mp4' }), actualStart: seg.start, actualEnd };
}

/* ---------------- thumbnails ---------------- */
async function makeThumbnail(t) {
  try {
    const c = await state.thumbSink.getCanvas(clamp(t, state.t0, state.t0 + state.duration - 0.05));
    if (!c) return null;
    const scale = Math.min(1, 320 / c.width);
    const tc = document.createElement('canvas');
    tc.width = Math.round(c.width * scale); tc.height = Math.round(c.height * scale);
    tc.getContext('2d').drawImage(c, 0, 0, tc.width, tc.height);
    return tc.toDataURL('image/jpeg', 0.72);
  } catch (_) { return null; }
}

/* ---------------- main split run ---------------- */
async function runSplit() {
  if (state.splitting || !state.file) return;
  let bounds;
  try { bounds = computeBounds(); }
  catch (err) { toast('⚠️ ' + err.message, true); return; }

  const MB = await loadMediabunny();
  state.splitting = true;
  $('splitBtn').disabled = true;
  $('results').hidden = true;
  $('clipGrid').innerHTML = '';
  $('progressWrap').hidden = false;
  $('clipStatus').innerHTML = '';
  state.clips = [];

  const fast = state.format === 'original';
  const total = bounds.length - 1;
  const base = sanitizeName(state.file.name);
  const pad = String(total).length;
  const errors = [];

  // Fast path: snap every boundary to a keyframe first (cheap index seeks).
  let segs;
  if (fast) {
    const vSink = new MB.EncodedPacketSink(state.vTrack);
    const snapped = [bounds[0]];
    for (let i = 1; i < bounds.length - 1; i++) {
      const k = await vSink.getKeyPacket(bounds[i], { verifyKeyPackets: true }).catch(() => null);
      snapped.push(k ? Math.min(k.timestamp, bounds[i]) : bounds[i]);
    }
    snapped.push(bounds[bounds.length - 1]);
    // Tile segments edge-to-edge on the SNAPPED boundaries: segment i covers
    // [snapped[i], snapped[i+1]). This guarantees no overlaps and no gaps,
    // even though each snapped start sits slightly before its requested cut.
    segs = [];
    for (let i = 0; i < snapped.length - 1; i++) {
      if (snapped[i + 1] > snapped[i]) segs.push({ start: snapped[i], end: snapped[i + 1] });
    }
    if (!segs.length) { toast('⚠️ Everything snapped to the same keyframe — try longer clips.', true); cleanup(); return; }
  } else {
    segs = bounds.slice(0, -1).map((s, i) => ({ start: s, end: bounds[i + 1] }));
  }

  const statusList = $('clipStatus');
  let done = 0;
  const setProgress = (label) => {
    $('progressLabel').textContent = label;
    const pct = Math.round((done / segs.length) * 100);
    $('progressPct').textContent = pct + '%';
    $('progressFill').style.width = pct + '%';
  };

  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const li = document.createElement('li');
    li.textContent = `⏳ Clip ${i + 1}/${segs.length} (${fmtTime(seg.start - state.t0)} → ${fmtTime(seg.end - state.t0)})…`;
    statusList.appendChild(li);
    setProgress(`Clip ${i + 1} of ${segs.length} — ${fast ? 'cutting (lossless)' : 'rendering frames'}…`);
    try {
      const name = `${base}-clip-${String(i + 1).padStart(pad, '0')}.mp4`;
      const res = fast
        ? await splitFastSegment(seg)
        : await splitReencodeSegment(seg, (f) => { li.textContent = `⏳ Clip ${i + 1}/${segs.length} — ${f} frames…`; });
      const thumb = await makeThumbnail(res.actualStart + Math.min(0.5, (res.actualEnd - res.actualStart) / 2));
      state.clips.push({ name, blob: res.blob, thumb, actualStart: res.actualStart, actualEnd: res.actualEnd });
      li.innerHTML = `<span class="done">✓</span> Clip ${i + 1}/${segs.length} — ${fmtBytes(res.blob.size)}`;
    } catch (err) {
      console.error('Segment failed:', err);
      errors.push(`Clip ${i + 1}: ${err.message || err}`);
      li.innerHTML = `<span style="color:#b3261e">✕</span> Clip ${i + 1} failed — ${err.message || err}`;
      break; // stop: later clips likely hit the same problem
    }
    done++;
    setProgress(`Clip ${i + 1} of ${segs.length} done`);
  }

  setProgress(errors.length ? 'Stopped with an error' : 'All clips ready ✓');
  $('progressFill').style.width = '100%';
  renderResults(fast, errors);
  cleanup();

  function cleanup() {
    state.splitting = false;
    $('splitBtn').disabled = false;
  }
}

function renderResults(fast, errors) {
  const grid = $('clipGrid');
  grid.innerHTML = '';
  const vertical = state.format === 'v-crop' || state.format === 'v-blur';
  state.clips.forEach((c, i) => {
    const card = document.createElement('div');
    card.className = 'clip-card' + (vertical ? ' vertical' : '');
    const dur = c.actualEnd - c.actualStart;
    card.innerHTML = `
      ${c.thumb ? `<img src="${c.thumb}" alt="Thumbnail of ${c.name}" loading="lazy">` : ''}
      <div class="clip-body">
        <div class="clip-name">${c.name}</div>
        <div class="clip-meta">Starts ${fmtTimeMs(c.actualStart - state.t0)} · ${fmtTime(dur)} long · ${fmtBytes(c.blob.size)}</div>
        <button class="btn btn-ghost btn-sm" data-i="${i}">⬇ Download</button>
      </div>`;
    grid.appendChild(card);
  });
  grid.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => {
      const c = state.clips[Number(b.dataset.i)];
      downloadBlob(c.blob, c.name);
    });
  });
  $('clipCount').textContent = `(${state.clips.length})`;
  $('snapNote').textContent = fast
    ? '⚡ Lossless stream copy — no re-encoding. Each cut snapped to the nearest keyframe; exact start times are shown on every clip.'
    : `Re-encoded to ${state.format === 'square' ? '1:1 square' : '9:16 vertical'} with H.264 (${state.quality} quality). Audio was copied untouched.`;
  $('zipBtn').style.display = state.clips.length > 1 ? '' : 'none';
  $('results').hidden = false;
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (errors.length) toast('⚠️ ' + errors[0] + (state.clips.length ? ' — clips finished before the error are still downloadable below.' : ''), true);
}

async function downloadZip() {
  if (!state.clips.length) return;
  const btn = $('zipBtn');
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Preparing ZIP…';
  try {
    const JSZip = await loadJSZip();
    const zip = new JSZip();
    for (const c of state.clips) zip.file(c.name, c.blob);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    downloadBlob(blob, sanitizeName(state.file.name) + '-clips.zip');
  } catch (err) {
    toast('⚠️ ' + (err.message || 'ZIP download failed.'), true);
  } finally {
    btn.disabled = false;
    btn.textContent = orig;
  }
}

/* ---------------- UI wiring ---------------- */
function initUI() {
  const dz = $('dropzone'), fi = $('fileInput');
  dz.addEventListener('click', () => fi.click());
  dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fi.click(); } });
  fi.addEventListener('change', () => handleFile(fi.files[0]));
  ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
  ['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
  dz.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  $('newFileBtn').addEventListener('click', () => {
    resetState();
    $('editor').hidden = true;
    $('dropzone').style.display = '';
    fi.value = '';
  });

  // Preview <-> timeline sync
  const pv = $('previewVideo');
  pv.addEventListener('timeupdate', () => {
    if (!state.duration) return;
    $('timelinePlayhead').style.left = clamp((pv.currentTime - state.t0) / state.duration * 100, 0, 100) + '%';
    $('tCur').textContent = fmtTime(Math.max(0, pv.currentTime - state.t0));
  });
  $('timeline').addEventListener('click', (e) => {
    if (state.mode !== 'custom' || !state.duration) return;
    if (e.target.classList.contains('cut-marker')) return;
    const r = $('timeline').getBoundingClientRect();
    const t = state.t0 + clamp((e.clientX - r.left) / r.width, 0, 1) * state.duration;
    if (state.cuts.some((c) => Math.abs(c - t) < 1)) return; // min 1s apart
    state.cuts.push(t);
    updatePlanUI();
  });

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.mode-tab').forEach((t) => { t.classList.remove('active'); t.setAttribute('aria-selected', 'false'); });
      tab.classList.add('active'); tab.setAttribute('aria-selected', 'true');
      state.mode = tab.dataset.mode;
      document.querySelectorAll('.mode-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === state.mode));
      updatePlanUI();
    });
  });

  // Every-X chips + inputs
  $('everyChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#everyChips .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.everySec = Number(chip.dataset.sec);
    $('everyCustom').value = '';
    updatePlanUI();
  });
  $('everyCustom').addEventListener('input', () => {
    if (parseFloat($('everyCustom').value) > 0) {
      document.querySelectorAll('#everyChips .chip').forEach((c) => c.classList.remove('active'));
    }
    updatePlanUI();
  });
  $('equalCount').addEventListener('input', updatePlanUI);
  $('rangeStart').addEventListener('input', updatePlanUI);
  $('rangeEnd').addEventListener('input', updatePlanUI);

  // Custom cut input
  const addCut = () => {
    const t = parseTime($('cutInput').value);
    if (!(t >= 0) || t <= 0.25 || t >= state.duration - 0.25) { toast('⚠️ Enter a time like 1:30 within the video.', true); return; }
    if (state.cuts.some((c) => Math.abs(c - (state.t0 + t)) < 1)) { toast('⚠️ Too close to an existing cut.', true); return; }
    state.cuts.push(state.t0 + t);
    $('cutInput').value = '';
    updatePlanUI();
  };
  $('addCutBtn').addEventListener('click', addCut);
  $('cutInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCut(); });

  // Format cards
  $('formatCards').addEventListener('click', (e) => {
    const card = e.target.closest('.radio-card');
    if (!card) return;
    document.querySelectorAll('#formatCards .radio-card').forEach((c) => c.classList.remove('active'));
    card.classList.add('active');
    card.querySelector('input').checked = true;
    state.format = card.dataset.format;
    $('formatHint').textContent = state.format === 'original'
      ? 'Original mode copies the video stream untouched — lossless and fastest.'
      : 'This format re-encodes video in your browser (slower than Original). Audio is still copied untouched.';
    updatePlanUI();
  });

  // Quality chips
  $('qualityChips').addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    document.querySelectorAll('#qualityChips .chip').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    state.quality = chip.dataset.q;
    updatePlanUI();
  });

  $('splitBtn').addEventListener('click', runSplit);
  $('zipBtn').addEventListener('click', downloadZip);
}

document.addEventListener('DOMContentLoaded', initUI);
