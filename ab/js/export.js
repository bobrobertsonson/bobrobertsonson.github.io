/* Preset export.
   Pro-Q: FabFilter Pro-Q 3 preset (.ffp, "FQ3p" v4, 334 little-endian float32 params: 24 bands x 13 + 22 globals).
   Layout verified against a real Pro-Q 3 file and github.com/raoulsh/preset-toolkit. Pro-Q 4 loads Pro-Q 3 .ffp
   presets through its own preset browser (FabFilter forum, topic 7908).
   Logic Channel EQ: its .pst format is undocumented, so we produce the exact settings to dial in instead. */
(function (root) {
  'use strict';
  const TYPE = { pk: 0, ls: 1, hs: 3 };                       // Pro-Q filter shapes: Bell, Low Shelf, High Shelf
  const UNUSED = [0, 1, Math.log2(1000), 0, 0, 1, 1, 0.5, 0, 1, 2, 1, 0];   // empty band, copied from a factory preset
  const GLOBALS = [0, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, -1, 1, 2, 2, 3, 0, 1, 1, 2, 0, 0];
  const qConv = q => Math.log10(q) * 0.312098175 + 0.5;

  function proQ3(bands) {
    const used = bands.filter(b => Math.abs(b.g) >= 0.05);
    const buf = new ArrayBuffer(12 + 334 * 4), dv = new DataView(buf);
    'FQ3p'.split('').forEach((c, i) => dv.setUint8(i, c.charCodeAt(0)));
    dv.setInt32(4, 4, true); dv.setInt32(8, 334, true);
    let o = 12; const put = v => { dv.setFloat32(o, v, true); o += 4; };
    for (let i = 0; i < 24; i++) {
      const b = used[i];
      if (!b) { UNUSED.forEach(put); continue; }
      [1, 1, Math.log2(b.f), b.g, 0, 1, 1, qConv(b.q), TYPE[b.type], 1, 2, 1, 0].forEach(put);
    }
    GLOBALS.forEach(put);
    return new Uint8Array(buf);
  }

  // Logic Channel EQ: band 1 low cut, 2 low shelf, 3 to 6 bells, 7 high shelf, 8 high cut.
  function channelEq(bands) {
    const bells = bands.filter(b => b.type === 'pk').sort((a, b) => a.f - b.f);
    const rows = [];
    const ls = bands.find(b => b.type === 'ls'), hs = bands.find(b => b.type === 'hs');
    const fmtF = f => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + ' kHz' : Math.round(f) + ' Hz';
    const fmtG = g => (g > 0 ? '+' : g < 0 ? '−' : '') + Math.abs(g).toFixed(1) + ' dB';
    if (ls) rows.push({ band: 'Band 2 · Low Shelf', on: Math.abs(ls.g) >= 0.05, f: fmtF(ls.f), g: fmtG(ls.g), q: '0.71' });
    bells.forEach((b, i) => rows.push({ band: 'Band ' + (3 + i) + ' · Bell', on: Math.abs(b.g) >= 0.05, f: fmtF(b.f), g: fmtG(b.g), q: b.q.toFixed(2) }));
    if (hs) rows.push({ band: 'Band 7 · High Shelf', on: Math.abs(hs.g) >= 0.05, f: fmtF(hs.f), g: fmtG(hs.g), q: '0.71' });
    const text = ['Logic Channel EQ settings (from A/B)', ...rows.map(r => r.on ? `${r.band}: ${r.f}, ${r.g}, Q ${r.q}` : `${r.band}: off`)].join('\n');
    return { rows, text };
  }

  root.ABExport = { proQ3, channelEq, qConv };
})(typeof window !== 'undefined' ? window : globalThis);
