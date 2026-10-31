/* DSP for the A/B app. Pure functions, no DOM, so they run in the browser and under Node for tests.
   - measure(): BS.1770-4 integrated loudness, short-term max, LRA, sample and 4x true peak, in one streaming pass.
     Memory is O(length / 100 ms), so long tracks do not exhaust a phone (the old version allocated ~400 MB per song).
   - ltas(): long-term average power spectrum (mono), used for the EQ match.
   - EQ: RBJ biquads identical to the Web Audio spec (peaking, and shelves with S = 1), responses, loudness delta, auto-fit. */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- loudness
  function kCoeffs(fs) {
    let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    let K = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416), a0 = 1 + K / Q + K * K;
    const s1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
    f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / fs); a0 = 1 + K / Q + K * K;
    const s2 = [1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
    return [s1, s2];
  }
  // 4x oversampling interpolator (windowed sinc, 12 taps per phase)
  const TPC = (() => { const c = []; for (let p = 1; p < 4; p++) { const t = p / 4, row = []; for (let j = -5; j <= 6; j++) { const d = t - j; const s = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d); const w = 0.5 + 0.5 * Math.cos(Math.PI * d / 6.5); row.push(s * w); } c.push(row); } return c; })();
  const Lz = z => -0.691 + 10 * Math.log10(z);

  /* buf: {sampleRate, length, numberOfChannels, getChannelData(c)} */
  function measure(buf) {
    const fs = buf.sampleRate, n = buf.length, nch = Math.min(buf.numberOfChannels, 2);
    const sub = Math.max(1, Math.round(0.1 * fs)), nSub = Math.floor(n / sub);
    const subE = new Float64Array(Math.max(1, nSub));
    const [s1, s2] = kCoeffs(fs);
    let sp = 0, tp = 0, tailE = 0, tailN = 0;
    for (let c = 0; c < nch; c++) {
      const d = buf.getChannelData(c);
      let p = 0; for (let i = 0; i < n; i++) { const v = d[i] < 0 ? -d[i] : d[i]; if (v > p) p = v; }
      if (p > sp) sp = p;
      let t = p; const thr = p * 0.5;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, z1 = 0, z2 = 0, acc = 0, k = 0, cnt = 0;
      const [a0, a1, a2, a3, a4] = s1, [b3, b4] = [s2[3], s2[4]];
      for (let i = 0; i < n; i++) {
        const xi = d[i];
        const yi = a0 * xi + a1 * x1 + a2 * x2 - a3 * y1 - a4 * y2; x2 = x1; x1 = xi; y2 = y1; y1 = yi;
        const zi = yi - 2 * u1 + u2 - b3 * z1 - b4 * z2; u2 = u1; u1 = yi; z2 = z1; z1 = zi;
        acc += zi * zi;
        if (++cnt === sub) { if (k < nSub) subE[k] += acc; k++; acc = 0; cnt = 0; }
        if (i >= 5 && i < n - 6) {
          const av = xi < 0 ? -xi : xi, bv = d[i + 1] < 0 ? -d[i + 1] : d[i + 1];
          if (av >= thr || bv >= thr) {
            for (let q = 0; q < 3; q++) { const r = TPC[q]; let y = 0; for (let j = 0; j < 12; j++) y += d[i - 5 + j] * r[j]; if (y < 0) y = -y; if (y > t) t = y; }
          }
        }
      }
      if (t > tp) tp = t;
      tailE += acc; tailN = cnt;
    }
    // gated blocks built from 100 ms sub-blocks: 400 ms (momentary, 75% overlap) and 3 s (short-term)
    const blocks = (m) => { const out = []; if (nSub < m) return out; let s = 0; for (let j = 0; j < m; j++) s += subE[j]; out.push(s / (m * sub));
      for (let j = m; j < nSub; j++) { s += subE[j] - subE[j - m]; out.push(s / (m * sub)); } return out; };
    let mz = blocks(4);
    if (!mz.length) { let s = 0; for (let j = 0; j < nSub; j++) s += subE[j]; s += tailE; mz = [s / Math.max(1, n)]; }
    const abs = mz.filter(z => Lz(z) > -70);
    let lufs = -Infinity;
    if (abs.length) { const m = abs.reduce((a, b) => a + b, 0) / abs.length; const rel = abs.filter(z => Lz(z) > Lz(m) - 10); lufs = Lz(rel.reduce((a, b) => a + b, 0) / rel.length); }
    const sz = blocks(30);
    let st = -Infinity; for (const z of sz) { const v = Lz(z); if (v > st) st = v; }
    let lra = null; const sa = sz.filter(z => Lz(z) > -70);
    if (sa.length > 1) { const m = sa.reduce((a, b) => a + b, 0) / sa.length; const r = sa.filter(z => Lz(z) > Lz(m) - 20).map(Lz).sort((a, b) => a - b);
      if (r.length > 1) { const q = f => r[Math.min(r.length - 1, Math.max(0, Math.round(f * (r.length - 1))))]; lra = q(0.95) - q(0.10); } }
    if (!isFinite(st)) st = lufs;
    return { lufs, sp, tp, st, lra };
  }

  function envelope(buf, cols = 1200) {
    const n = buf.length, nch = Math.min(2, buf.numberOfChannels), mn = new Float32Array(cols), mx = new Float32Array(cols);
    const d0 = buf.getChannelData(0), d1 = nch > 1 ? buf.getChannelData(1) : d0;
    for (let c = 0; c < cols; c++) {
      const s = Math.floor(c * n / cols), e = Math.max(s + 1, Math.floor((c + 1) * n / cols)); let lo = 0, hi = 0;
      for (let i = s; i < e; i++) { const v = (d0[i] + d1[i]) * 0.5; if (v < lo) lo = v; if (v > hi) hi = v; }
      mn[c] = lo; mx[c] = hi;
    }
    return { mn, mx, cols, dur: buf.duration };
  }

  // ---------------------------------------------------------------- spectrum
  function makeFFT(N) {
    const lev = Math.log2(N) | 0, rev = new Uint32Array(N), cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < lev; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = Math.sin(2 * Math.PI * i / N); }
    return function (re, im) {
      for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half, tr = re[l] * cos[k] + im[l] * sin[k], ti = -re[l] * sin[k] + im[l] * cos[k];
          re[l] = re[j] - tr; im[l] = im[j] - ti; re[j] += tr; im[j] += ti;
        }
      }
    };
  }
  /* Long-term average power spectrum of the mono sum. Async so the UI stays responsive. */
  async function ltas(buf, opts = {}) {
    const N = opts.N || 8192, maxFrames = opts.frames || 320, yieldEvery = opts.yieldEvery || 24;
    const fs = buf.sampleRate, n = buf.length, nch = Math.min(2, buf.numberOfChannels);
    const d0 = buf.getChannelData(0), d1 = nch > 1 ? buf.getChannelData(1) : d0;
    const fft = makeFFT(N), win = new Float64Array(N), re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    const pow = new Float64Array(N / 2 + 1);
    const avail = Math.max(1, Math.floor((n - N) / (N / 2)));
    const count = Math.min(maxFrames, avail), stride = (n - N) / Math.max(1, count);
    let used = 0;
    for (let f = 0; f < count; f++) {
      const s = Math.max(0, Math.floor(f * stride)); let e = 0;
      for (let i = 0; i < N; i++) { const v = (s + i < n) ? (d0[s + i] + d1[s + i]) * 0.5 : 0; e += v * v; re[i] = v * win[i]; im[i] = 0; }
      if (e / N < 1e-5) continue; // skip near-silence (below about -50 dBFS RMS)
      fft(re, im); used++;
      for (let k = 0; k <= N / 2; k++) pow[k] += re[k] * re[k] + im[k] * im[k];
      if (opts.onProgress && f % yieldEvery === 0) { opts.onProgress(f / count); await new Promise(r => setTimeout(r, 0)); }
    }
    if (used) for (let k = 0; k <= N / 2; k++) pow[k] /= used;
    return { fs, N, pow, frames: used };
  }
  /* Log-spaced analysis grid, 20 Hz to 20 kHz. */
  function grid(points = 160, lo = 20, hi = 20000) { const g = new Float64Array(points); for (let i = 0; i < points; i++) g[i] = lo * Math.pow(hi / lo, i / (points - 1)); return g; }
  /* Fractional-octave smoothing of a power spectrum onto a grid, in dB. */
  function smoothDb(spec, freqs, frac = 1 / 3) {
    const { fs, N, pow } = spec, out = new Float64Array(freqs.length), hz = fs / N;
    for (let i = 0; i < freqs.length; i++) {
      const f = freqs[i], lo = f * Math.pow(2, -frac / 2), hi = f * Math.pow(2, frac / 2);
      let a = Math.max(1, Math.floor(lo / hz)), b = Math.min(N / 2, Math.ceil(hi / hz)); if (b < a) b = a;
      let s = 0, c = 0; for (let k = a; k <= b; k++) { s += pow[k]; c++; }
      out[i] = 10 * Math.log10(s / Math.max(1, c) + 1e-20);
    }
    return out;
  }

  // ---------------------------------------------------------------- EQ
  // Band types: 'ls' low shelf, 'pk' peaking, 'hs' high shelf. Gains in dB.
  function rbj(type, f0, gain, Q, fs) {
    const A = Math.pow(10, gain / 40), w0 = 2 * Math.PI * Math.min(f0, fs * 0.49) / fs, cw = Math.cos(w0), sw = Math.sin(w0);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'pk') {
      const al = sw / (2 * Q);
      b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A;
    } else {
      const al = sw / 2 * Math.SQRT2, sA = 2 * Math.sqrt(A) * al; // shelf slope S = 1, as in the Web Audio spec
      if (type === 'ls') {
        b0 = A * ((A + 1) - (A - 1) * cw + sA); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - sA);
        a0 = (A + 1) + (A - 1) * cw + sA; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - sA;
      } else {
        b0 = A * ((A + 1) + (A - 1) * cw + sA); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - sA);
        a0 = (A + 1) - (A - 1) * cw + sA; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - sA;
      }
    }
    return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
  }
  function magSq(c, f, fs) {
    const w = 2 * Math.PI * f / fs, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
    const nr = c[0] + c[1] * c1 + c[2] * c2, ni = -(c[1] * s1 + c[2] * s2);
    const dr = 1 + c[3] * c1 + c[4] * c2, di = -(c[3] * s1 + c[4] * s2);
    return (nr * nr + ni * ni) / (dr * dr + di * di);
  }
  function bandDb(b, freqs, fs) { const c = rbj(b.type, b.f, b.g, b.q, fs), out = new Float64Array(freqs.length); for (let i = 0; i < freqs.length; i++) out[i] = 10 * Math.log10(magSq(c, freqs[i], fs)); return out; }
  function eqDb(bands, freqs, fs) { const out = new Float64Array(freqs.length); for (const b of bands) { if (!b.g) continue; const r = bandDb(b, freqs, fs); for (let i = 0; i < out.length; i++) out[i] += r[i]; } return out; }

  /* Loudness change (LU) from applying the EQ to a track with this average spectrum, K-weighted. */
  function loudnessDelta(spec, bands, fsEq) {
    if (!spec || !bands.some(b => b.g)) return 0;
    const { fs, N, pow } = spec, [k1, k2] = kCoeffs(fs), cs = bands.filter(b => b.g).map(b => rbj(b.type, b.f, b.g, b.q, fsEq || fs));
    let base = 0, eq = 0;
    for (let k = 1; k < N / 2; k++) {
      const f = k * fs / N, w = pow[k] * magSq(k1, f, fs) * magSq(k2, f, fs); let h = 1;
      for (const c of cs) h *= magSq(c, f, fsEq || fs);
      base += w; eq += w * h;
    }
    return base > 0 ? 10 * Math.log10(eq / base) : 0;
  }

  const DEFAULT_BANDS = () => [
    { id: 'LS', type: 'ls', f: 90, g: 0, q: 0.71, lo: 30, hi: 300 },
    { id: '1', type: 'pk', f: 250, g: 0, q: 1.0, lo: 60, hi: 800 },
    { id: '2', type: 'pk', f: 1000, g: 0, q: 1.0, lo: 300, hi: 4000 },
    { id: '3', type: 'pk', f: 3500, g: 0, q: 1.0, lo: 1500, hi: 9000 },
    { id: 'HS', type: 'hs', f: 9000, g: 0, q: 0.71, lo: 3000, hi: 16000 },
  ];

  /* Fit the 5 bands to a target curve (dB on freqs). weights: same length. Returns new bands, gains clamped to +-maxG. */
  function fitEQ(target, freqs, fs, opts = {}) {
    const maxG = opts.maxG || 9, w = opts.weights || freqs.map(f => (f < 35 || f > 15000) ? 0.15 : (f < 60 || f > 11000 ? 0.5 : 1));
    const bands = (opts.start || DEFAULT_BANDS()).map(b => ({ ...b, g: 0 }));
    const err = (resp) => { let e = 0; for (let i = 0; i < freqs.length; i++) { const d = target[i] - resp[i]; e += w[i] * d * d; } return e; };
    const others = (skip) => { const out = new Float64Array(freqs.length); bands.forEach((b, j) => { if (j === skip || !b.g) return; const r = bandDb(b, freqs, fs); for (let i = 0; i < out.length; i++) out[i] += r[i]; }); return out; };
    const bestGain = (cand, rest) => { // 1-D: shape at +1 dB is close to linear in gain; refine once with the exact response
      const u = bandDb({ ...cand, g: 1 }, freqs, fs); let num = 0, den = 0;
      for (let i = 0; i < freqs.length; i++) { num += w[i] * u[i] * (target[i] - rest[i]); den += w[i] * u[i] * u[i]; }
      let g = den > 0 ? num / den : 0; g = Math.max(-maxG, Math.min(maxG, g));
      return g;
    };
    const qs = [0.5, 0.7, 1.0, 1.4, 2.0];
    for (let pass = 0; pass < 5; pass++) {
      bands.forEach((b, j) => {
        const rest = others(j); let best = { e: Infinity };
        const steps = 14, fl = Math.log(b.lo), fh = Math.log(b.hi);
        for (let s = 0; s <= steps; s++) {
          const f = Math.exp(fl + (fh - fl) * s / steps);
          for (const q of (b.type === 'pk' ? qs : [0.71])) {
            const cand = { ...b, f, q }; cand.g = bestGain(cand, rest);
            const r = bandDb(cand, freqs, fs), tot = new Float64Array(freqs.length); for (let i = 0; i < tot.length; i++) tot[i] = rest[i] + r[i];
            const e = err(tot); if (e < best.e) best = { e, f, q, g: cand.g };
          }
        }
        b.f = best.f; b.q = best.q; b.g = best.g;
      });
    }
    bands.forEach(b => { b.f = Math.round(b.f); b.g = Math.round(b.g * 10) / 10; b.q = Math.round(b.q * 100) / 100; });
    // keep the three bells in frequency order so band 1 is always the lowest
    const pk = bands.filter(b => b.type === 'pk').sort((x, y) => x.f - y.f), base = DEFAULT_BANDS();
    let k = 0; return bands.map((b, i) => b.type === 'pk' ? { ...pk[k++], id: base[i].id, lo: base[i].lo, hi: base[i].hi } : b);
  }

  /* Difference target: reference minus mix, both normalised to equal loudness via their integrated LUFS. */
  function matchTarget(mixDb, refDb, mixLufs, refLufs) {
    const t = new Float64Array(mixDb.length);
    for (let i = 0; i < t.length; i++) t[i] = (refDb[i] - refLufs) - (mixDb[i] - mixLufs);
    // remove the K-weighted average so the curve describes tone, not level
    let s = 0, c = 0; for (let i = 0; i < t.length; i++) { s += t[i]; c++; } const m = s / c;
    for (let i = 0; i < t.length; i++) t[i] -= m;
    return t;
  }

  root.ABDSP = { measure, envelope, ltas, grid, smoothDb, rbj, magSq, bandDb, eqDb, loudnessDelta, fitEQ, matchTarget, DEFAULT_BANDS, kCoeffs, makeFFT };
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
