/* A/B app: your mix against up to six references, level-matched, with a balance EQ on the mix. */
(() => {
'use strict';
const $ = id => document.getElementById(id);
const D = window.ABDSP, X = window.ABExport;
const MAX_REFS = 6, FREQS = D.grid(160);
const PLAT = {
  spotify: { name: 'Spotify', short: 'Spotify −14', target: -14, up: true },
  apple: { name: 'Apple Music', short: 'Apple −16', target: -16, up: true },
  youtube: { name: 'YouTube', short: 'YouTube −14', target: -14, up: false },
  tidal: { name: 'Tidal', short: 'Tidal −14', target: -14, up: false },
  amazon: { name: 'Amazon', short: 'Amazon −14', target: -14, up: false },
  sc: { name: 'SoundCloud', short: 'SoundCloud 0', target: null, up: false },
};
const S = {
  mix: null, refs: [], sel: 0, side: 'mix',
  playing: false, startAt: 0, offsetAt: 0, loop: true, cue: false, blind: false, blindMap: { X: 'mix', Y: 'ref' },
  mode: 'match', plat: 'spotify', codec: 'off', mon: 'full', loopIn: 0, loopOut: null,
  eq: { on: true, bands: D.DEFAULT_BANDS(), sel: 2, amount: 0.75, fit: null },
};
let ctx = null, monIn = null, monNodes = [], analyser = null, meterBuf = null, peakHold = 0;
let srcs = [], gains = new Map(), eqNodes = [], raf = 0, encToken = 0, uid = 0;

// ---------------------------------------------------------------- helpers
const db = v => v > 0 ? 20 * Math.log10(v) : -Infinity;
const nf = v => (v < 0 ? '−' : '') + Math.abs(v).toFixed(1);
const sgn = v => (v > 0.05 ? '+' : (v < -0.05 ? '−' : '')) + Math.abs(v).toFixed(1);
const fmt = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = Math.floor(t % 60); return m + ':' + String(s).padStart(2, '0'); };
const fmt10 = t => { t = Math.max(0, t); const m = Math.floor(t / 60), s = (t % 60); return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); };
const fmtF = f => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + 'k' : Math.round(f) + '';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const yieldUI = () => new Promise(r => setTimeout(r, 0));
const ref = () => S.refs[S.sel] || null;
const tracks = () => [S.mix, ...S.refs].filter(Boolean);
const ready = () => !!(S.mix && S.mix.st && ref() && ref().st);
const tdur = t => t ? (t.duration || 0) : 0;
const dur = () => Math.max(tdur(S.mix), tdur(ref()));
const endPt = () => S.loopOut == null ? dur() : S.loopOut;
const hasEnc = t => S.codec !== 'off' && t.enc && t.enc.kbps === S.codec;
const stOf = t => hasEnc(t) ? t.enc.st : t.st;
const playBuf = t => hasEnc(t) ? t.enc.buf : t.buf;
const offOf = t => hasEnc(t) ? t.enc.off : 0;
const audible = () => S.side === 'mix' ? S.mix : ref();
const padSide = p => S.blind ? S.blindMap[p === 'L' ? 'X' : 'Y'] : (p === 'L' ? 'mix' : 'ref');
function setStatus(t, p) { $('status').textContent = t || ''; const b = $('bar'); b.hidden = (p == null); if (p != null) $('barFill').style.width = Math.round(p * 100) + '%'; }
let statusTimer = 0; function flash(t, ms = 3500) { setStatus(t); clearTimeout(statusTimer); statusTimer = setTimeout(() => { if ($('status').textContent === t) setStatus(''); }, ms); }

// EQ loudness change on the mix, cached per band state
let eqKey = '', eqLU = 0;
function eqDelta() {
  if (!S.eq.on || !S.mix || !S.mix.spec) return 0;
  const k = JSON.stringify(S.eq.bands.map(b => [b.f, b.g, b.q]));
  if (k !== eqKey) { eqKey = k; eqLU = D.loudnessDelta(S.mix.spec, S.eq.bands, ctx ? ctx.sampleRate : 48000); }
  return eqLU;
}
const effLufs = t => { const s = stOf(t); return s ? s.lufs + (t === S.mix ? eqDelta() : 0) : -Infinity; };
function platGainDb(lufs, tp, p) {
  const P = PLAT[p]; if (!isFinite(lufs) || P.target == null) return 0;
  const d = P.target - lufs; if (d <= 0) return d; if (!P.up) return 0;
  return Math.max(0, Math.min(d, -1 - db(tp)));
}
function gainDb(t) {
  if (!t || !t.st || S.mode === 'orig') return 0;
  if (S.mode === 'plat') return platGainDb(effLufs(t), stOf(t).tp, S.plat);
  const all = tracks().filter(x => x.st).map(effLufs).filter(isFinite);
  if (!all.length || !isFinite(effLufs(t))) return 0;
  return Math.min(...all) - effLufs(t);
}

// ---------------------------------------------------------------- audio graph
function ensureCtx() {
  try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) {}
  if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); monIn = ctx.createGain(); analyser = ctx.createAnalyser(); analyser.fftSize = 1024; buildMonitor(); }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}
function bq(type, f, q, g) { const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = f; n.Q.value = q; if (g != null) n.gain.value = g; return n; }
function buildMonitor() {
  if (!ctx) return;
  monIn.disconnect(); monNodes.forEach(n => n.disconnect()); monNodes = [];
  monIn.connect(analyser);
  if (S.mon === 'full') { monIn.connect(ctx.destination); return; }
  const m = ctx.createGain(); m.channelCount = 1; m.channelCountMode = 'explicit'; m.channelInterpretation = 'speakers';
  monIn.connect(m); monNodes.push(m); let last = m;
  if (S.mon === 'phone') [bq('highpass', 350, 0.7), bq('highpass', 350, 0.7), bq('peaking', 2500, 1, 4), bq('lowpass', 9000, 0.7)].forEach(n => { last.connect(n); last = n; monNodes.push(n); });
  last.connect(ctx.destination);
}
const NODE_TYPE = { ls: 'lowshelf', pk: 'peaking', hs: 'highshelf' };
function setEqNodes(ramp) {
  if (!ctx) return; const t = ctx.currentTime;
  eqNodes.forEach((n, i) => { const b = S.eq.bands[i]; if (!b) return;
    const set = (p, v) => { p.cancelScheduledValues(t); if (ramp) p.setTargetAtTime(v, t, 0.01); else p.setValueAtTime(v, t); };
    set(n.frequency, b.f); set(n.gain, S.eq.on ? b.g : 0); if (b.type === 'pk') set(n.Q, b.q); });
}
function now() { return S.playing ? S.offsetAt + (ctx.currentTime - S.startAt) : S.offsetAt; }
function applyGains(ramp) {
  if (!ctx) return; const aud = audible(), t = ctx.currentTime;
  for (const tr of tracks()) { const g = gains.get(tr.id); if (!g) continue;
    const v = tr === aud ? Math.pow(10, gainDb(tr) / 20) : 0;
    g.gain.cancelScheduledValues(t); if (ramp) g.gain.setTargetAtTime(v, t, 0.004); else g.gain.setValueAtTime(v, t); }
}
function start(at) {
  ensureCtx(); stop(true);
  if (at >= endPt() || at < 0) at = S.loopIn;
  S.offsetAt = at; S.startAt = ctx.currentTime + 0.05; eqNodes = [];
  for (const t of tracks()) {
    const b = playBuf(t); if (!b) continue;
    const src = ctx.createBufferSource(); src.buffer = b;
    const g = ctx.createGain(); src.connect(g);
    if (t === S.mix) { let last = g; for (const band of S.eq.bands) { const n = ctx.createBiquadFilter(); n.type = NODE_TYPE[band.type]; last.connect(n); last = n; eqNodes.push(n); } last.connect(monIn); setEqNodes(false); }
    else g.connect(monIn);
    gains.set(t.id, g);
    const o = at + offOf(t); if (o < b.duration) src.start(S.startAt, Math.max(0, o));
    srcs.push(src);
  }
  S.playing = true; applyGains(false); tick(); render();
}
function stop(keep) {
  if (S.playing && ctx) S.offsetAt = now();
  srcs.forEach(s => { try { s.stop(); } catch (e) {} s.disconnect && s.disconnect(); }); srcs = []; gains = new Map(); eqNodes = [];
  S.playing = false; cancelAnimationFrame(raf);
  if (!keep) render();
}
function tick() {
  const t = now();
  if (t >= endPt()) { if (S.loop) { start(S.loopIn); return; } stop(); S.offsetAt = S.loopIn; render(); return; }
  updateClock(); drawScope(); updateMeter();
  if (S.playing) raf = requestAnimationFrame(tick);
}
function restartIfPlaying() { if (S.playing) start(now()); else render(); }
function select(side) {
  if (!ready()) return; ensureCtx();
  const changed = side !== S.side; S.side = side;
  if (!S.playing) start(S.cue ? S.loopIn : S.offsetAt);
  else if (S.cue) start(S.loopIn);
  else if (changed) applyGains(true);
  render();
}
function selectRef(i) {
  if (i < 0 || i >= S.refs.length) return;
  S.sel = i; S.side = 'ref';
  if (S.playing) { if (S.cue) start(S.loopIn); else applyGains(true); }
  render(); drawEq();
}

// ---------------------------------------------------------------- loading and analysis
function decode(ab) { ensureCtx(); return new Promise((res, rej) => { const p = ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); }); }
function newTrack(name, file) { return { id: ++uid, name, file: file || null, duration: 0, sr: 0, nch: 0, buf: null, st: null, peaks: null, spec: null, sdb: null, sdb3: null, enc: null, loading: true, err: false }; }
async function analyze(t) {
  t.duration = t.buf.duration; t.sr = t.buf.sampleRate; t.nch = t.buf.numberOfChannels;
  t.peaks = D.envelope(t.buf); render();
  setStatus('Measuring ' + t.name); await yieldUI();
  t.st = D.measure(t.buf); t.loading = false; render();
  t.spec = await D.ltas(t.buf, { onProgress: p => setStatus('Reading tone of ' + t.name, p) });
  t.sdb = D.smoothDb(t.spec, FREQS, 1 / 6); t.sdb3 = D.smoothDb(t.spec, FREQS, 1 / 3);
  setStatus(''); eqKey = '';
  if (S.codec !== 'off') { try { await encodeTrack(t, encToken, p => setStatus('MP3 ' + S.codec + ' kbps · ' + t.name, p)); } catch (e) {} setStatus(''); }
  render(); drawEq();
}
async function loadInto(t, file) {
  try { t.buf = await decode(await file.arrayBuffer()); await analyze(t); }
  catch (e) { t.err = true; t.loading = false; setStatus(''); render(); }
}
async function loadMix(file) {
  if (!file) return; const was = S.playing, at = now(); stop(true);
  const t = newTrack(file.name, file); S.mix = t; S.offsetAt = 0; S.loopIn = 0; S.loopOut = null; render();
  await loadInto(t, file);
  if (was && ready()) start(Math.min(at, endPt() - 0.1)); else render();
}
async function addRefs(files) {
  const list = [...files].slice(0, MAX_REFS - S.refs.length);
  if (files.length > list.length) flash('Up to ' + MAX_REFS + ' references. Remove one to add another.');
  for (const file of list) {
    const was = S.playing, at = now(); stop(true);
    const t = newTrack(file.name, file); S.refs.push(t); if (S.refs.length === 1) S.sel = 0; render();
    await loadInto(t, file);
    if (was && ready()) start(at); else render();
  }
}
function removeRef(i) {
  const was = S.playing, at = now(); stop(true);
  S.refs.splice(i, 1);
  if (S.sel >= S.refs.length) S.sel = Math.max(0, S.refs.length - 1);
  if (!S.refs.length) S.side = 'mix';
  if (was && ready()) start(at); else render();
  drawEq();
}
$('fileMix').addEventListener('change', e => { loadMix(e.target.files[0]); e.target.value = ''; });
$('fileRefs').addEventListener('change', e => { addRefs(e.target.files); e.target.value = ''; });

// ---------------------------------------------------------------- MP3 preview (worker)
/* One short-lived worker per encode, several at once. */
const POOL = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 2) - 1));
function encodeInWorker(msg, onProg) {
  return new Promise((res, rej) => {
    let w; try { w = new Worker('js/mp3-worker.js'); } catch (e) { rej(e); return; }
    w.onmessage = e => { if (e.data.progress != null) { onProg(e.data.progress); return; } w.terminate(); e.data.error ? rej(new Error(e.data.error)) : res(e.data.mp3); };
    w.onerror = e => { w.terminate(); rej(new Error('encoder failed to start')); };
    w.postMessage(msg, msg.r ? [msg.l.buffer, msg.r.buffer] : [msg.l.buffer]);
  });
}
function toI16(f) { const o = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { let v = f[i]; v = v > 1 ? 1 : (v < -1 ? -1 : v); o[i] = v < 0 ? v * 0x8000 : v * 0x7fff; } return o; }
async function resample(buf, rate) { const oc = new OfflineAudioContext(Math.min(2, buf.numberOfChannels), Math.ceil(buf.duration * rate), rate);
  const s = oc.createBufferSource(); s.buffer = buf; s.connect(oc.destination); s.start(); return oc.startRendering(); }
/* MP3 encoding plus decoding adds a fixed delay (about 1105 samples with LAME, or 576 if the decoder trims its part).
   Find it by correlating transients (first difference), summed over several loud windows, within 0 to 2000 samples. */
function alignOffset(a, b) {
  const sr = a.sampleRate, n = Math.min(a.length, b.length), W = 8192, maxL = 2000;
  const ma = a.getChannelData(0), mb = b.getChannelData(0);
  const wins = []; for (const f of [0.15, 0.3, 0.45, 0.6, 0.75]) { const p = Math.floor(n * f); if (p > 1 && p + W + maxL < n) { let e = 0; for (let i = 0; i < W; i += 4) { const d = ma[p + i] - ma[p + i - 1]; e += d * d; } wins.push({ p, e }); } }
  wins.sort((x, y) => y.e - x.e); const use = wins.slice(0, 3).filter(w => w.e > 0); if (!use.length) return 1105 / 44100;
  let best = 0, bestC = -Infinity;
  for (let L = 0; L <= maxL; L++) { let c = 0;
    for (const { p } of use) for (let i = 1; i < W; i += 2) c += (ma[p + i] - ma[p + i - 1]) * (mb[p + i + L] - mb[p + i + L - 1]);
    if (c > bestC) { bestC = c; best = L; } }
  return best / sr;
}
async function ensureBuf(t) { if (!t.buf && t.file) t.buf = await decode(await t.file.arrayBuffer()); return !!t.buf; }
async function encodeTrack(t, token, onProg) {
  const kbps = S.codec; if (!(await ensureBuf(t))) return;
  let src = t.buf; if (![32000, 44100, 48000].includes(src.sampleRate)) src = await resample(src, 44100);
  const l = toI16(src.getChannelData(0)), r = src.numberOfChannels > 1 ? toI16(src.getChannelData(1)) : null;
  const mp3 = await encodeInWorker({ l, r, sr: src.sampleRate, kbps: +kbps }, onProg);
  if (token !== encToken || S.codec !== kbps) return;
  const buf = await decode(mp3.buffer);
  if (token !== encToken || S.codec !== kbps) return;
  t.enc = { kbps, buf, st: D.measure(buf), off: alignOffset(t.buf, buf) };
  if (t.file) t.buf = null;   // one decoded copy per track in memory; the file reloads it when the codec goes back to lossless
}
async function encodeMany(list, token, label) {
  const queue = list.slice(), prog = new Map(), total = list.length; let done = 0;
  const show = () => { let s = done; for (const v of prog.values()) s += v; setStatus('MP3 ' + S.codec + ' kbps · ' + label + ' · ' + Math.min(total, done + prog.size) + ' of ' + total, s / Math.max(1, total)); };
  const run = async () => { while (queue.length) { const t = queue.shift(); prog.set(t.id, 0); show();
    await encodeTrack(t, token, p => { prog.set(t.id, p); show(); }); prog.delete(t.id); done++; show(); if (token !== encToken) return; } };
  await Promise.all(Array.from({ length: Math.min(POOL, queue.length) }, run));
}
let codecResume = null;
function resumePlayback() { const r = codecResume; codecResume = null; if (r && r.was && ready()) start(Math.min(r.at, endPt() - 0.05)); else render(); }
async function setCodec(k) {
  const token = ++encToken;
  if (!codecResume) codecResume = { was: S.playing, at: now() };   // survives quick knob turns through several settings
  S.codec = k; stop(true);
  for (const t of tracks()) if (t.enc && t.enc.kbps !== k) t.enc = null;   // one bitrate in memory at a time
  render();
  try {
    if (k === 'off') { await restoreLossless(token); if (token !== encToken) return; setStatus(''); resumePlayback(); return; }
    const first = [S.mix, ref()].filter(Boolean), rest = tracks().filter(t => !first.includes(t));
    await encodeMany(first.filter(t => !t.enc), token, 'mix and ref'); if (token !== encToken) return;
    resumePlayback();                                   // hear the pair you are comparing as soon as it is ready
    if (rest.some(t => !t.enc)) {
      await encodeMany(rest.filter(t => !t.enc), token, 'other refs'); if (token !== encToken) return;
      if (S.playing) start(now());                      // pick up the newly encoded references
    }
    flash('Hearing MP3 ' + k + ' kbps on every track');
  } catch (e) {
    setStatus('MP3 preview failed: ' + e.message); S.codec = 'off'; kCodec.set('off'); await restoreLossless(token); codecResume = null; render();
  }
}
async function restoreLossless(token) {
  const need = tracks().filter(t => !t.buf && t.file);
  for (let i = 0; i < need.length; i++) { setStatus('Reloading lossless · ' + (i + 1) + ' of ' + need.length, i / need.length); await ensureBuf(need[i]); if (token !== encToken) return; }
}

// ---------------------------------------------------------------- 7-segment LED digits
const SEG = (() => { const t = 1, L = 2, Rr = 10, T = 2, M = 10, B = 18;
  const h = (x1, x2, y) => `${x1},${y} ${x1 + t},${y - t} ${x2 - t},${y - t} ${x2},${y} ${x2 - t},${y + t} ${x1 + t},${y + t}`;
  const v = (x, y1, y2) => `${x},${y1} ${x + t},${y1 + t} ${x + t},${y2 - t} ${x},${y2} ${x - t},${y2 - t} ${x - t},${y1 + t}`;
  return { a: h(L + .6, Rr - .6, T), b: v(Rr, T + .6, M - .6), c: v(Rr, M + .6, B - .6), d: h(L + .6, Rr - .6, B), e: v(L, M + .6, B - .6), f: v(L, T + .6, M - .6), g: h(L + .6, Rr - .6, M), p: v(6, M - 3.6, M + 3.6) }; })();
const DIG = { '0': 'abcdef', '1': 'bc', '2': 'abged', '3': 'abgcd', '4': 'fgbc', '5': 'afgcd', '6': 'afgedc', '7': 'abc', '8': 'abcdefg', '9': 'abcfgd', '-': 'g', '+': 'gp', ' ': '' };
function seg7(str, cells) {
  str = String(str).replace(/−/g, '-');
  const cs = []; for (const ch of str) { if (ch === '.' && cs.length) { cs[cs.length - 1].dot = true; continue; } cs.push({ ch, dot: false }); }
  if (cells) { let n = cs.filter(c => c.ch !== ':').length; while (n < cells) { cs.unshift({ ch: ' ', dot: false }); n++; } }
  let x = 0, body = '';
  for (const c of cs) {
    if (c.ch === ':') { body += `<g transform="translate(${x},0)"><circle class="on" cx="2.5" cy="7" r="1.2"/><circle class="on" cx="2.5" cy="14" r="1.2"/></g>`; x += 5; continue; }
    const lit = DIG[c.ch] || ''; let g = '';
    for (const k of 'abcdefg') g += `<polygon class="${lit.includes(k) ? 'on' : 'off'}" points="${SEG[k]}"/>`;
    if (lit.includes('p')) g += `<polygon class="on" points="${SEG.p}"/>`;
    g += `<circle class="${c.dot ? 'on' : 'off'}" cx="12.4" cy="18.2" r="1.1"/>`;
    body += `<g transform="translate(${x},0) skewX(-7)">${g}</g>`; x += 14;
  }
  return `<svg class="seg" viewBox="-1 0 ${x + 2} 20" style="width:${(x + 2) / 20}em" aria-label="${str.trim()}" role="img">${body}</svg>`;
}

// ---------------------------------------------------------------- knobs (61-frame filmstrip)
function Knob(el, { label, options, value, onChange }) {
  const n = options.length, span = n <= 3 ? 60 : (n <= 5 ? 120 : 135);
  const angleOf = i => n === 1 ? 0 : -span + i * (2 * span / (n - 1)), frameOf = a => Math.round((a + 150) / 5);
  el.innerHTML = '<div class="dial" role="slider" tabindex="0" aria-label="' + label + '"><div class="img"></div></div><div class="glass amber"><b class="val"></b></div><span class="lbl">' + label + '</span>';
  const dial = el.querySelector('.dial'), img = el.querySelector('.img'), val = el.querySelector('.val');
  const ticks = options.map((o, i) => { const t = document.createElement('span'); t.className = 'tick'; const a = angleOf(i) * Math.PI / 180, R = 50;
    t.style.transform = 'translate(' + (Math.sin(a) * R) + 'px,' + (-Math.cos(a) * R) + 'px)'; dial.appendChild(t); return t; });
  let idx = Math.max(0, options.findIndex(o => o.v === value));
  const show = () => { img.style.backgroundPosition = '0 ' + (frameOf(angleOf(idx)) / 60 * 100) + '%'; ticks.forEach((t, i) => t.classList.toggle('on', i === idx));
    val.textContent = options[idx].t; dial.setAttribute('aria-valuetext', options[idx].t); dial.setAttribute('aria-valuenow', idx); dial.setAttribute('aria-valuemin', 0); dial.setAttribute('aria-valuemax', n - 1); };
  const set = (i, fire = true) => { i = Math.max(0, Math.min(n - 1, i)); if (i === idx) return; idx = i; show(); if (fire) onChange(options[idx].v); };
  let drag = null;
  dial.addEventListener('pointerdown', e => { dial.setPointerCapture(e.pointerId); drag = { y: e.clientY, x: e.clientX, i: idx, moved: false }; });
  dial.addEventListener('pointermove', e => { if (!drag) return; const d = (drag.y - e.clientY) + (e.clientX - drag.x); if (Math.abs(d) > 6) drag.moved = true; if (drag.moved) set(drag.i + Math.round(d / 28)); });
  dial.addEventListener('pointerup', () => { if (drag && !drag.moved) set(idx === n - 1 ? 0 : idx + 1); drag = null; });
  dial.addEventListener('pointercancel', () => { drag = null; });
  dial.addEventListener('keydown', e => { if (['ArrowUp', 'ArrowRight'].includes(e.key)) { e.preventDefault(); set(idx + 1); } if (['ArrowDown', 'ArrowLeft'].includes(e.key)) { e.preventDefault(); set(idx - 1); } });
  show();
  return { set: v => { const i = options.findIndex(o => o.v === v); if (i >= 0) { idx = i; show(); } } };
}

// ---------------------------------------------------------------- scope
const cv = $('cv'), g2 = cv.getContext('2d');
const C = { grid: 'rgba(125,255,162,.08)', rule: 'rgba(125,255,162,.2)', dim: 'rgba(125,255,162,.55)', ink: '#7DFFA2', mix: '#FF6A1A', ref: '#7FB4EA', amber: '#FFB347' };
function sizeCanvas(c) { const r = c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; if (!r.width) return false; c.width = Math.round(r.width * dpr); c.height = Math.round(r.height * dpr); return true; }
function drawScope() {
  const W = cv.width, H = cv.height, dpr = window.devicePixelRatio || 1; if (!W) return;
  g2.clearRect(0, 0, W, H);
  const Dn = dur(), r = ready(), rf = ref();
  $('scopeEmpty').hidden = !!((S.mix && S.mix.peaks) || (rf && rf.peaks));
  g2.lineWidth = 1; g2.strokeStyle = C.grid;
  for (let i = 1; i < 10; i++) { const x = Math.round(W * i / 10) + .5; g2.beginPath(); g2.moveTo(x, 0); g2.lineTo(x, H); g2.stroke(); }
  const lanes = S.blind ? [{ c: 0.5, h: H * 0.46 }, { c: 0.5, h: H * 0.46 }] : [{ c: 0.25, h: H * 0.23 }, { c: 0.75, h: H * 0.23 }];
  lanes.slice(0, S.blind ? 1 : 2).forEach(L => { const y = Math.round(H * L.c) + .5; g2.strokeStyle = C.rule; g2.beginPath(); g2.moveTo(0, y); g2.lineTo(W, y); g2.stroke(); });
  if (!Dn) return;
  if (S.loopIn > 0 || S.loopOut != null) { const x0 = S.loopIn / Dn * W, x1 = endPt() / Dn * W; g2.fillStyle = C.amber; g2.globalAlpha = 0.08; g2.fillRect(x0, 0, x1 - x0, H); g2.globalAlpha = 1;
    g2.strokeStyle = C.amber; g2.lineWidth = dpr; [x0, x1].forEach(x => { g2.beginPath(); g2.moveTo(x, 0); g2.lineTo(x, H); g2.stroke(); }); }
  const env = (t, L, col, alpha, glow) => {
    if (!t || !t.peaks) return; const p = t.peaks, gl = Math.pow(10, gainDb(t) / 20) * (t === S.mix && S.eq.on ? Math.pow(10, eqDelta() / 20) : 1);
    const wpx = p.dur / Dn * W, cy = H * L.c, lim = L.h * 2.15;
    g2.fillStyle = col; g2.globalAlpha = alpha; if (glow) { g2.shadowColor = col; g2.shadowBlur = 10 * dpr; }
    for (let x = 0; x < wpx; x++) { const c = Math.min(p.cols - 1, Math.floor(x / wpx * p.cols));
      const top = Math.max(cy - lim, cy - p.mx[c] * gl * L.h * 2), bot = Math.min(cy + lim, cy - p.mn[c] * gl * L.h * 2); g2.fillRect(x, top, 1, Math.max(1, bot - top)); }
    g2.globalAlpha = 1; g2.shadowBlur = 0;
  };
  const aud = audible();
  if (S.blind) { env(S.mix, lanes[0], C.ink, 0.3); env(rf, lanes[0], C.ink, 0.3); }
  else { env(S.mix, lanes[0], C.mix, (!r || aud === S.mix) ? 0.95 : 0.25, r && aud === S.mix); env(rf, lanes[1], C.ref, (!r || aud === rf) ? 0.95 : 0.25, r && aud === rf); }
  g2.fillStyle = C.dim; g2.font = '700 ' + (11 * dpr) + 'px "Doto", "VT323", monospace'; g2.textBaseline = 'top';
  if (!S.blind) { g2.fillText('MIX', 4 * dpr, 4 * dpr); g2.fillText(rf ? 'REF ' + (S.sel + 1) : 'REF', 4 * dpr, H / 2 + 4 * dpr); }
  g2.textBaseline = 'bottom'; for (let i = 1; i < 10; i += 2) g2.fillText(fmt(Dn * i / 10), W * i / 10 + 3 * dpr, H - 3 * dpr);
  const x = Math.round(Math.min(now(), Dn) / Dn * W) + .5;
  g2.strokeStyle = C.amber; g2.lineWidth = 2 * dpr; g2.shadowColor = C.amber; g2.shadowBlur = 8 * dpr; g2.beginPath(); g2.moveTo(x, 0); g2.lineTo(x, H); g2.stroke(); g2.shadowBlur = 0;
}
let ptr = null;
cv.addEventListener('pointerdown', e => { if (!dur()) return; cv.setPointerCapture(e.pointerId); const r = cv.getBoundingClientRect(); ptr = { x0: e.clientX - r.left, w: r.width, drag: false, x: e.clientX - r.left }; });
cv.addEventListener('pointermove', e => { if (!ptr) return; const r = cv.getBoundingClientRect(); ptr.x = e.clientX - r.left; if (Math.abs(ptr.x - ptr.x0) > 8) ptr.drag = true;
  if (ptr.drag) { const Dn = dur(), a = Math.max(0, Math.min(ptr.x0, ptr.x)) / ptr.w * Dn, b = Math.min(ptr.w, Math.max(ptr.x0, ptr.x)) / ptr.w * Dn; S.loopIn = a; S.loopOut = Math.max(a + 0.25, b); render(); } });
cv.addEventListener('pointerup', () => { if (!ptr) return; const Dn = dur(), t = Math.max(0, Math.min(1, ptr.x / ptr.w)) * Dn;
  if (ptr.drag) { if (S.playing) start(S.loopIn); else S.offsetAt = S.loopIn; }
  else { if (t < S.loopIn || t >= endPt()) { S.loopIn = 0; S.loopOut = null; } if (S.playing) start(t); else S.offsetAt = t; }
  ptr = null; render(); });
cv.addEventListener('pointercancel', () => { ptr = null; });

// ---------------------------------------------------------------- balance EQ
const ecv = $('eqcv'), e2 = ecv.getContext('2d'), EQR = 12, FLO = 20, FHI = 20000;
const xOf = (f, W) => Math.log(f / FLO) / Math.log(FHI / FLO) * W, fOf = (x, W) => FLO * Math.pow(FHI / FLO, Math.max(0, Math.min(1, x / W)));
const yOfG = (g, H) => H / 2 - g / EQR * (H * 0.42), gOfY = (y, H) => (H / 2 - y) / (H * 0.42) * EQR;
function eqTarget() { const m = S.mix, r = ref(); if (!m || !r || !m.sdb3 || !r.sdb3) return null; return D.matchTarget(m.sdb3, r.sdb3, m.st.lufs, r.st.lufs); }
function drawEq() {
  const W = ecv.width, H = ecv.height, dpr = window.devicePixelRatio || 1; if (!W) return;
  e2.clearRect(0, 0, W, H);
  const m = S.mix, r = ref(); $('eqEmpty').hidden = !!((m && m.sdb) || (r && r.sdb));
  // grid: decades and the EQ dB scale
  e2.lineWidth = 1; e2.font = '700 ' + (10 * dpr) + 'px "Doto", monospace'; e2.fillStyle = C.dim;
  [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(f => { const x = Math.round(xOf(f, W)) + .5; e2.strokeStyle = C.grid; e2.beginPath(); e2.moveTo(x, 0); e2.lineTo(x, H); e2.stroke(); e2.textBaseline = 'bottom'; e2.fillText(fmtF(f), x + 3 * dpr, H - 3 * dpr); });
  [-12, -6, 0, 6, 12].forEach(g => { const y = Math.round(yOfG(g, H)) + .5; e2.strokeStyle = g === 0 ? C.rule : C.grid; e2.beginPath(); e2.moveTo(0, y); e2.lineTo(W, y); e2.stroke();
    if (g) { e2.textBaseline = 'middle'; e2.fillText((g > 0 ? '+' : '') + g, 3 * dpr, y); } });
  const fsEq = ctx ? ctx.sampleRate : 48000, eq = S.eq.on ? D.eqDb(S.eq.bands, FREQS, fsEq) : new Float64Array(FREQS.length);
  // spectra (tilted +4.5 dB/oct so balanced music reads flat), level-matched, auto-ranged into the panel
  const tilt = f => 4.5 * Math.log2(f / 1000);
  const curves = [];
  if (r && r.sdb) curves.push({ c: C.ref, fill: true, v: [...r.sdb].map((v, i) => v - r.st.lufs + tilt(FREQS[i])) });
  if (m && m.sdb) curves.push({ c: C.mix, fill: false, v: [...m.sdb].map((v, i) => v - m.st.lufs + eq[i] + tilt(FREQS[i])) });
  if (curves.length) {
    let hi = -Infinity; curves.forEach(cu => cu.v.forEach((v, i) => { if (FREQS[i] > 30 && FREQS[i] < 16000 && v > hi) hi = v; }));
    const lo = hi - 42, yOfS = v => H * 0.06 + (hi - v) / (hi - lo) * H * 0.8;
    curves.forEach(cu => { e2.beginPath(); cu.v.forEach((v, i) => { const x = xOf(FREQS[i], W), y = Math.min(H, yOfS(v)); i ? e2.lineTo(x, y) : e2.moveTo(x, y); });
      if (cu.fill) { e2.save(); e2.lineTo(W, H); e2.lineTo(0, H); e2.closePath(); e2.fillStyle = 'rgba(127,180,234,.13)'; e2.fill(); e2.restore(); e2.beginPath(); cu.v.forEach((v, i) => { const x = xOf(FREQS[i], W), y = Math.min(H, yOfS(v)); i ? e2.lineTo(x, y) : e2.moveTo(x, y); }); }
      e2.strokeStyle = cu.c; e2.globalAlpha = cu.fill ? 0.7 : 0.85; e2.lineWidth = 1.5 * dpr; e2.stroke(); e2.globalAlpha = 1; });
  }
  // target (reference minus mix), on the EQ scale
  const tg = eqTarget();
  if (tg) { e2.setLineDash([4 * dpr, 4 * dpr]); e2.strokeStyle = C.ref; e2.lineWidth = 1.5 * dpr; e2.beginPath();
    tg.forEach((v, i) => { const x = xOf(FREQS[i], W), y = yOfG(Math.max(-EQR, Math.min(EQR, v)), H); i ? e2.lineTo(x, y) : e2.moveTo(x, y); }); e2.stroke(); e2.setLineDash([]); }
  // EQ curve and nodes
  e2.strokeStyle = C.amber; e2.lineWidth = 2.5 * dpr; e2.shadowColor = C.amber; e2.shadowBlur = 6 * dpr; e2.globalAlpha = S.eq.on ? 1 : 0.35; e2.beginPath();
  eq.forEach((v, i) => { const x = xOf(FREQS[i], W), y = yOfG(v, H); i ? e2.lineTo(x, y) : e2.moveTo(x, y); }); e2.stroke(); e2.shadowBlur = 0;
  S.eq.bands.forEach((b, i) => { const x = xOf(b.f, W), y = yOfG(b.g, H), on = i === S.eq.sel, rr = (on ? 11 : 9) * dpr;
    e2.beginPath(); e2.arc(x, y, rr, 0, Math.PI * 2); e2.fillStyle = on ? C.mix : '#1C1408'; e2.fill(); e2.lineWidth = 1.5 * dpr; e2.strokeStyle = on ? '#FF8A3D' : C.amber; e2.stroke();
    e2.fillStyle = on ? '#14110D' : C.amber; e2.textAlign = 'center'; e2.textBaseline = 'middle'; e2.font = '700 ' + (9 * dpr) + 'px "Barlow Condensed", sans-serif'; e2.fillText(b.id, x, y + 0.5 * dpr); e2.textAlign = 'left'; });
  e2.globalAlpha = 1;
}
let eptr = null;
ecv.addEventListener('pointerdown', e => {
  const r = ecv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, x = (e.clientX - r.left) * dpr, y = (e.clientY - r.top) * dpr;
  let best = -1, bd = 30 * dpr; S.eq.bands.forEach((b, i) => { const d = Math.hypot(xOf(b.f, ecv.width) - x, yOfG(b.g, ecv.height) - y); if (d < bd) { bd = d; best = i; } });
  if (best < 0) return; e.preventDefault(); ecv.setPointerCapture(e.pointerId); eptr = { i: best }; S.eq.sel = best; S.eq.fit = null; renderEqUI(); drawEq();
});
ecv.addEventListener('pointermove', e => {
  if (!eptr) return; const r = ecv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1, b = S.eq.bands[eptr.i];
  b.f = Math.round(Math.max(20, Math.min(20000, fOf((e.clientX - r.left) * dpr, ecv.width))));
  b.g = Math.round(Math.max(-EQR, Math.min(EQR, gOfY((e.clientY - r.top) * dpr, ecv.height))) * 10) / 10;
  eqChanged();
});
ecv.addEventListener('pointerup', () => { eptr = null; render(); });
ecv.addEventListener('pointercancel', () => { eptr = null; });
let eqRaf = 0;
function eqChanged() { setEqNodes(true); if (!eqRaf) eqRaf = requestAnimationFrame(() => { eqRaf = 0; applyGains(true); renderEqUI(); drawEq(); drawScope(); renderReadouts(); renderReport(); }); }
const fToS = f => Math.round(Math.log(f / 20) / Math.log(1000) * 1000), sToF = s => Math.round(20 * Math.pow(1000, s / 1000));
const qToS = q => Math.round(Math.log(q / 0.3) / Math.log(4 / 0.3) * 1000), sToQ = s => Math.round(0.3 * Math.pow(4 / 0.3, s / 1000) * 100) / 100;
function renderEqUI() {
  const bands = S.eq.bands, b = bands[S.eq.sel];
  $('bandSel').innerHTML = bands.map((x, i) => `<button role="tab" aria-selected="${i === S.eq.sel}" data-i="${i}">${x.id}<small>${Math.abs(x.g) >= 0.05 ? sgn(x.g) : '0.0'}</small></button>`).join('');
  $('fF').value = fToS(b.f); $('fG').value = Math.round(b.g * 10); $('fQ').value = qToS(b.q); $('fQ').disabled = b.type !== 'pk'; $('rowQ').classList.toggle('off', b.type !== 'pk');
  $('vF').textContent = (b.f >= 1000 ? (b.f / 1000).toFixed(2) + ' kHz' : b.f + ' Hz'); $('vG').textContent = sgn(b.g) + ' dB'; $('vQ').textContent = b.type === 'pk' ? b.q.toFixed(2) : 'shelf';
  $('eqOn').setAttribute('aria-pressed', S.eq.on); $('eqAmt').textContent = Math.round(S.eq.amount * 100) + '%';
  $('eqMatch').disabled = !eqTarget();
  const d = eqDelta(), r = ref();
  $('eqAside').textContent = r ? 'Mix → ' + (S.blind ? 'ref ' + (S.sel + 1) : r.name.replace(/\.[^.]+$/, '')) : 'On your mix';
  const active = bands.filter(x => Math.abs(x.g) >= 0.05).length;
  $('eqInfo').textContent = !S.mix ? 'Load your mix to use the EQ.' : (!active ? 'Flat. Press Match ref, or drag a node.' :
    (S.eq.on ? active + ' bands on your mix · loudness ' + sgn(d) + ' LU' + (S.mode === 'orig' ? '' : ', compensated') : 'EQ bypassed · ' + active + ' bands set'));
}
$('bandSel').addEventListener('click', e => { const t = e.target.closest('button'); if (!t) return; S.eq.sel = +t.dataset.i; renderEqUI(); drawEq(); });
$('fF').addEventListener('input', e => { S.eq.bands[S.eq.sel].f = sToF(+e.target.value); S.eq.fit = null; eqChanged(); });
$('fG').addEventListener('input', e => { S.eq.bands[S.eq.sel].g = +e.target.value / 10; S.eq.fit = null; eqChanged(); });
$('fQ').addEventListener('input', e => { S.eq.bands[S.eq.sel].q = sToQ(+e.target.value); S.eq.fit = null; eqChanged(); });
$('eqOn').addEventListener('click', () => { S.eq.on = !S.eq.on; eqKey = ''; eqChanged(); });
function applyFit() { S.eq.bands = S.eq.fit.map(b => ({ ...b, g: Math.round(b.g * S.eq.amount * 10) / 10 })); S.eq.on = true; eqKey = ''; }
$('eqMatch').addEventListener('click', () => {
  const tg = eqTarget(); if (!tg) return;
  S.eq.fit = D.fitEQ(tg, FREQS, ctx ? ctx.sampleRate : 48000, { maxG: 9 }); applyFit(); eqChanged();
  const big = S.eq.bands.reduce((a, b) => Math.abs(b.g) > Math.abs(a.g) ? b : a);
  flash('Matched to ' + (S.blind ? 'ref ' + (S.sel + 1) : ref().name) + ' · biggest move ' + sgn(big.g) + ' dB at ' + fmtF(big.f) + 'Hz');
});
$('eqAmt').addEventListener('click', () => { S.eq.amount = S.eq.amount >= 1 ? 0.5 : S.eq.amount + 0.25; if (S.eq.fit) applyFit(); eqChanged(); });
$('eqFlat').addEventListener('click', () => { S.eq.bands = D.DEFAULT_BANDS(); S.eq.fit = null; eqKey = ''; eqChanged(); });

// exports
function deliver(bytes, name, type) {
  const file = new File([bytes], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(() => {}); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
const presetName = () => 'AB match' + (ref() ? ' - ' + ref().name.replace(/\.[^.]+$/, '').replace(/[^\w \-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '');
$('expProq').addEventListener('click', () => {
  if (!S.eq.bands.some(b => Math.abs(b.g) >= 0.05)) { flash('Set some EQ first: press Match ref or drag a node.'); return; }
  deliver(X.proQ3(S.eq.bands), presetName() + '.ffp', 'application/octet-stream'); $('howProq').hidden = false;
});
$('expLogic').addEventListener('click', () => {
  const card = $('logicCard'); if (!card.hidden) { card.hidden = true; return; }
  const { rows } = X.channelEq(S.eq.bands);
  $('logicRows').innerHTML = '<tr class="h"><td>Band</td><td>Freq</td><td>Gain</td><td>Q</td></tr>' + rows.map(r => { const o = r.on ? '' : ' class="off"';
    return `<tr><td${o}>${esc(r.band.replace('Band ', '').replace(' · ', ' '))}</td><td${o}>${r.on ? esc(r.f) : 'off'}</td><td${o}>${r.on ? esc(r.g) : ''}</td><td${o}>${r.on ? r.q : ''}</td></tr>`; }).join('');
  card.hidden = false;
});
$('logicCopy').addEventListener('click', () => { const { text } = X.channelEq(S.eq.bands);
  try { navigator.clipboard.writeText(text).then(() => flash('Copied Channel EQ settings'), () => flash('Copy blocked: select the text in the card')); } catch (e) { flash('Copy blocked: select the text in the card'); } });

// ---------------------------------------------------------------- meter
const meterEl = $('meter'), MSEG = 24;
for (let i = 0; i < MSEG; i++) { const s = document.createElement('i'); s.style.setProperty('--c', i < 15 ? 'var(--ok)' : (i < 20 ? 'var(--warn)' : 'var(--alert)')); meterEl.appendChild(s); }
const msegs = [...meterEl.children];
function updateMeter(reset) {
  let lit = 0;
  if (!reset && analyser && S.playing) { if (!meterBuf) meterBuf = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(meterBuf);
    let pk = 0; for (let i = 0; i < meterBuf.length; i++) { const v = Math.abs(meterBuf[i]); if (v > pk) pk = v; }
    lit = Math.max(0, Math.min(MSEG, Math.round(((pk > 0 ? 20 * Math.log10(pk) : -99) + 48) / 48 * MSEG))); peakHold = Math.max(lit, peakHold - 0.25); }
  else peakHold = 0;
  const hold = Math.round(peakHold); msegs.forEach((s, i) => { s.classList.toggle('on', i < lit); s.classList.toggle('pk', hold > 0 && i === hold - 1); });
}

// ---------------------------------------------------------------- render
const hideNames = () => S.blind && ready();
function renderInputs() {
  const m = S.mix;
  $('nameMix').textContent = m ? (m.err ? 'Could not decode. Try WAV or MP3.' : (hideNames() ? 'Hidden for blind test' : m.name)) : 'No mix loaded';
  $('metaMix').textContent = !m ? 'WAV · AIFF · FLAC · MP3' : (m.loading ? 'Measuring…' : (m.duration ? (m.sr / 1000) + ' kHz · ' + m.nch + ' ch · ' + fmt(m.duration) + (m.st ? ' · ' + nf(m.st.lufs) + ' LUFS' : '') : ''));
  $('refCount').textContent = S.refs.length + ' / ' + MAX_REFS;
  $('addRefs').classList.toggle('disabled', S.refs.length >= MAX_REFS); $('fileRefs').disabled = S.refs.length >= MAX_REFS;
  $('refList').innerHTML = S.refs.length ? S.refs.map((t, i) => `<div class="ref">
      <button class="selbtn" data-sel="${i}" aria-pressed="${i === S.sel}" aria-label="Use reference ${i + 1}"><i></i></button>
      <div class="glass amber"><b>${i + 1} · ${t.err ? 'Could not decode' : esc(hideNames() ? 'Reference ' + (i + 1) : t.name)}</b><small>${t.loading ? 'Measuring…' : (t.duration ? fmt(t.duration) + ' · ' + (t.sr / 1000) + ' kHz' : '')}</small></div>
      <div class="lufs">${t.st ? seg7(nf(t.st.lufs), 4) : seg7('', 4)}</div>
      <button class="x" data-rm="${i}" aria-label="Remove reference ${i + 1}">✕</button></div>`).join('')
    : '<div class="glass amber empty-refs">No references yet</div>';
}
$('refList').addEventListener('click', e => { const s = e.target.closest('[data-sel]'), r = e.target.closest('[data-rm]');
  if (s) selectRef(+s.dataset.sel); if (r) removeRef(+r.dataset.rm); });
function renderPads() {
  const r = ready();
  for (const p of ['L', 'R']) {
    const side = padSide(p), t = side === 'mix' ? S.mix : ref(), on = r && S.side === side, b = $('pad' + p);
    b.disabled = !r; b.dataset.on = on ? '1' : '0'; b.classList.toggle('blind', S.blind);
    $('big' + p).textContent = S.blind ? (p === 'L' ? 'X' : 'Y') : (p === 'L' ? 'MIX' : 'REF' + (S.refs.length > 1 ? ' ' + (S.sel + 1) : ''));
    $('g' + p).textContent = r && !S.blind ? sgn(gainDb(t)) + ' dB' : '';
    $('st' + p).textContent = on ? 'On' : (S.blind ? 'Tap' : (p === 'L' ? 'Blade' : 'Body'));
  }
  const ch = $('refChips'); ch.hidden = S.refs.length < 2;
  ch.innerHTML = S.refs.map((t, i) => `<button class="chip" data-chip="${i}" aria-pressed="${i === S.sel}"><i></i><span>${i + 1} · ${esc(hideNames() ? 'Ref' : t.name.replace(/\.[^.]+$/, ''))}</span></button>`).join('');
}
$('refChips').addEventListener('click', e => { const c = e.target.closest('[data-chip]'); if (c) selectRef(+c.dataset.chip); });
function updateClock() { $('clock').innerHTML = seg7(fmt10(Math.min(now(), dur())), 4); $('dur').textContent = fmt(dur()); }
function renderReadouts() {
  const tb = $('ro'), m = S.mix, r = ref(), sa = m && m.st ? stOf(m) : null, sb = r && r.st ? stOf(r) : null;
  $('roAside').textContent = S.codec !== 'off' ? 'After MP3 ' + S.codec + ' kbps' : 'Source files';
  if (hideNames()) { tb.innerHTML = '<tr><td class="m" colspan="5">Hidden during blind test.</td></tr>'; return; }
  const blank = '<td class="v">' + seg7('', 4) + '</td>';
  const rows = [['Integrated', s => s.lufs, 'LUFS', false], ['True peak', s => db(s.tp), 'dBTP', true], ['Short-term max', s => s.st, 'LUFS', false], ['Loudness range', s => s.lra, 'LU', false], ['Peak to loudness', s => db(s.tp) - s.lufs, 'dB', false]];
  const cell = (s, f, hot) => { if (!s) return blank; const v = f(s); if (v == null || !isFinite(v)) return '<td class="v">' + seg7('----', 4) + '</td>'; return '<td class="v' + (hot && v > -1 ? ' hot' : '') + '">' + seg7(nf(v), 4) + '</td>'; };
  let html = rows.map(([lab, f, u, hot]) => { const va = sa ? f(sa) : null, vb = sb ? f(sb) : null, d = (va != null && vb != null && isFinite(va) && isFinite(vb)) ? sgn(vb - va) : '';
    return '<tr><td class="m">' + lab + '</td>' + cell(sa, f, hot) + cell(sb, f, hot) + '<td class="d">' + d + '</td><td class="u">' + u + '</td></tr>'; }).join('');
  const gv = t => t && t.st ? '<td class="v">' + seg7(sgn(gainDb(t)), 4) + '</td>' : blank;
  if (m && m.st && S.eq.on && Math.abs(eqDelta()) >= 0.05) html += '<tr><td class="m">EQ loudness</td><td class="v">' + seg7(sgn(eqDelta()), 4) + '</td>' + blank + '<td class="d"></td><td class="u">LU</td></tr>';
  tb.innerHTML = html + '<tr><td class="m">Gain now</td>' + gv(m) + gv(r) + '<td class="d"></td><td class="u">dB</td></tr>';
}
function renderReport() {
  const tb = $('report');
  if (!ready()) { tb.innerHTML = '<tr><td class="m" colspan="4">Needs your mix and a reference.</td></tr>'; return; }
  if (hideNames()) { tb.innerHTML = '<tr><td class="m" colspan="4">Hidden during blind test.</td></tr>'; return; }
  const m = S.mix, r = ref(), la = effLufs(m), lb = effLufs(r);
  tb.innerHTML = Object.keys(PLAT).map(p => {
    const ga = platGainDb(la, stOf(m).tp, p), gb = platGainDb(lb, stOf(r).tp, p), pa = la + ga, pb = lb + gb, diff = Math.abs(pa - pb);
    const louder = diff < 0.3 ? 'Even' : (pa > pb ? 'Mix' : 'Ref') + ' +' + diff.toFixed(1), cls = v => v < -0.05 ? ' hot' : (v > 0.05 ? ' ok' : '');
    return '<tr class="' + (S.mode === 'plat' && p === S.plat ? 'sel' : '') + '"><td class="m">' + PLAT[p].name + '</td><td class="v' + cls(ga) + '">' + seg7(sgn(ga), 4) + '</td><td class="v' + cls(gb) + '">' + seg7(sgn(gb), 4) + '</td><td class="d">' + louder + '</td></tr>';
  }).join('');
}
function render() {
  const r = ready();
  renderInputs(); renderPads();
  $('play').disabled = !r; $('playLbl').textContent = S.playing ? 'Pause' : 'Play';
  $('loop').setAttribute('aria-pressed', S.loop); $('cue').setAttribute('aria-pressed', S.cue); $('blind').setAttribute('aria-pressed', S.blind);
  const hasRegion = r && (S.loopIn > 0 || S.loopOut != null);
  $('clrLoop').hidden = !hasRegion;
  $('loopInfo').textContent = hasRegion ? 'Loop ' + fmt10(S.loopIn) + ' to ' + fmt10(endPt()) : 'Tap to seek · drag to loop';
  $('scopeAside').textContent = S.blind ? 'Blind: overlaid' : 'At playback gain';
  $('live').classList.toggle('on', S.playing); if (!S.playing) updateMeter(true);
  updateClock(); renderReadouts(); renderReport(); renderEqUI(); drawScope();
}

// ---------------------------------------------------------------- transport and keys
$('padL').addEventListener('click', () => select(padSide('L')));
$('padR').addEventListener('click', () => select(padSide('R')));
$('play').addEventListener('click', () => { S.playing ? stop() : start(S.offsetAt); });
$('loop').addEventListener('click', () => { S.loop = !S.loop; render(); });
$('cue').addEventListener('click', () => { S.cue = !S.cue; render(); });
$('blind').addEventListener('click', () => {
  const w = $('revealWin');
  if (!S.blind) { S.blindMap = Math.random() < 0.5 ? { X: 'mix', Y: 'ref' } : { X: 'ref', Y: 'mix' }; S.blind = true; w.hidden = true; }
  else { S.blind = false; if (ready()) { w.hidden = false; $('reveal').textContent = 'Reveal: X was ' + (S.blindMap.X === 'mix' ? 'your mix' : 'the reference') + ', Y was ' + (S.blindMap.Y === 'mix' ? 'your mix' : 'the reference') + '.'; } }
  if (S.playing) applyGains(true); render(); drawEq();
});
$('clrLoop').addEventListener('click', () => { S.loopIn = 0; S.loopOut = null; render(); });
document.addEventListener('keydown', e => {
  const tag = e.target.tagName; if (tag === 'SELECT' || (tag === 'INPUT' && e.target.type !== 'file') || e.target.getAttribute('role') === 'slider') return;
  if (e.code === 'Space') { e.preventDefault(); if (ready()) select(S.side === 'mix' ? 'ref' : 'mix'); }
  const n = parseInt(e.key, 10); if (n >= 1 && n <= S.refs.length) selectRef(n - 1);
});

const kVol = Knob($('kVol'), { label: 'Volume', value: 'match', options: [{ v: 'orig', t: 'Original' }, { v: 'match', t: 'Matched' }, { v: 'plat', t: 'Platform' }],
  onChange: v => { S.mode = v; if (S.playing) applyGains(true); render(); } });
Knob($('kPlat'), { label: 'Platform', value: 'spotify', options: Object.keys(PLAT).map(k => ({ v: k, t: PLAT[k].short })), onChange: v => { S.plat = v; if (S.playing) applyGains(true); render(); } });
const kCodec = Knob($('kCodec'), { label: 'Codec', value: 'off', options: [{ v: 'off', t: 'Lossless' }, { v: '320', t: 'MP3 320' }, { v: '192', t: 'MP3 192' }, { v: '128', t: 'MP3 128' }, { v: '96', t: 'MP3 96' }], onChange: v => setCodec(v) });
Knob($('kSpk'), { label: 'Speaker', value: 'full', options: [{ v: 'full', t: 'Full range' }, { v: 'mono', t: 'Mono' }, { v: 'phone', t: 'Phone' }], onChange: v => { S.mon = v; ensureCtx(); buildMonitor(); } });

// ---------------------------------------------------------------- collapsible panels
let collapsed = []; try { collapsed = JSON.parse(localStorage.getItem('ab.collapsed') || '[]'); } catch (e) {}
document.querySelectorAll('.panel').forEach(p => {
  const btn = p.querySelector('button.plate'); if (!btn) return;
  const set = c => { p.classList.toggle('collapsed', c); btn.setAttribute('aria-expanded', !c); };
  set(collapsed.includes(p.id));
  btn.addEventListener('click', () => {
    const c = !p.classList.contains('collapsed'); set(c);
    collapsed = collapsed.filter(x => x !== p.id); if (c) collapsed.push(p.id);
    try { localStorage.setItem('ab.collapsed', JSON.stringify(collapsed)); } catch (e) {}
    if (!c) { if (sizeCanvas(cv)) drawScope(); if (sizeCanvas(ecv)) drawEq(); }
  });
});

// ---------------------------------------------------------------- demo: a dull mix and two brighter, louder references
function makeDemo() {
  const fs = 44100, len = Math.round(fs * 12.8), L0 = new Float32Array(len), R0 = new Float32Array(len);
  let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff * 2 - 1; };
  const beat = 0.5;
  for (let i = 0; i < len; i++) {
    const t = i / fs, bt = t % beat, bar = t % (beat * 4), b = Math.floor(t / beat) % 4, phr = Math.floor(t / (beat * 8));
    const kick = Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-bt * 30)) * bt) * Math.exp(-bt * 7) * 0.9;
    const sn = (b === 1 || b === 3) ? rnd() * Math.exp(-bt * 18) * 0.45 + Math.sin(2 * Math.PI * 190 * bt) * Math.exp(-bt * 25) * 0.25 : 0;
    const hat = rnd() * Math.exp(-(t % (beat / 2)) * 60) * 0.12;
    const notes = bar < beat * 2 ? [220, 261.63, 329.63] : [196, 246.94, 293.66];
    let pad = 0; notes.forEach((f, j) => { pad += ((t * f * (1 + 0.002 * j)) % 1 * 2 - 1); }); pad *= phr % 2 ? 0.09 : 0.04;
    const w = 0.25 * Math.sin(2 * Math.PI * 0.3 * t);
    L0[i] = kick + sn + hat * (1 + w) + pad * (1 - w); R0[i] = kick + sn + hat * (1 - w) + pad * (1 + w);
  }
  let pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(L0[i]), Math.abs(R0[i]));
  const g = 0.5 / pk, mk = () => ctx.createBuffer(2, len, fs), mix = mk(), r1 = mk(), r2 = mk();
  for (let c = 0; c < 2; c++) {
    const src = c ? R0 : L0, dm = mix.getChannelData(c), d1 = r1.getChannelData(c), d2 = r2.getChannelData(c);
    let lp = 0, lp2 = 0, prev = 0;
    for (let i = 0; i < len; i++) {
      const x = src[i] * g;
      lp += 0.35 * (x - lp); dm[i] = lp * 0.9 + x * 0.1;                  // mix: dull, rolled-off top
      const bright = x + 0.9 * (x - prev); prev = x;
      d1[i] = Math.tanh(bright * 3.2) * 0.95;                               // ref 1: bright, loud, clipped master
      lp2 += 0.08 * (x - lp2); d2[i] = (x + 0.35 * (x - lp2)) * 0.8;        // ref 2: open, dynamic
    }
  }
  return { mix, r1, r2 };
}
$('demo').addEventListener('click', async () => {
  ensureCtx(); stop(true); encToken++; S.offsetAt = 0; S.loopIn = 0; S.loopOut = null; S.refs = []; S.sel = 0; S.side = 'mix';
  setStatus('Building demo…'); await yieldUI();
  const d = makeDemo();
  const add = async (buf, name, isMix) => { const t = newTrack(name); t.buf = buf; if (isMix) S.mix = t; else S.refs.push(t); render(); await analyze(t); };
  await add(d.mix, 'Demo · my dull mix', true);
  await add(d.r1, 'Demo · loud bright master', false);
  await add(d.r2, 'Demo · open dynamic ref', false);
  flash('Demo loaded: press Match ref in Balance EQ');
});

// ---------------------------------------------------------------- boot
window.addEventListener('resize', () => { sizeCanvas(cv); sizeCanvas(ecv); drawScope(); drawEq(); });
sizeCanvas(cv); sizeCanvas(ecv); render(); drawEq();
window.__ab = { S, tracks, eqDelta, gainDb };   // for tests
})();
