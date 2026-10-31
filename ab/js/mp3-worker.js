/* MP3 encoding off the main thread. Receives 16-bit PCM, returns the encoded MP3 bytes.
   Runs in a Worker so a long encode cannot freeze the page, and the PCM copies are freed as soon as it finishes. */
importScripts('../vendor/lame.min.js');
self.onmessage = (e) => {
  const { id, l, r, sr, kbps } = e.data;
  try {
    const enc = new lamejs.Mp3Encoder(r ? 2 : 1, sr, kbps), step = 1152 * 32, parts = [];
    let size = 0;
    for (let i = 0, n = 0; i < l.length; i += step, n++) {
      const d = r ? enc.encodeBuffer(l.subarray(i, i + step), r.subarray(i, i + step)) : enc.encodeBuffer(l.subarray(i, i + step));
      if (d.length) { parts.push(new Uint8Array(d)); size += d.length; }
      if (n % 16 === 0) self.postMessage({ id, progress: i / l.length });
    }
    const f = enc.flush(); if (f.length) { parts.push(new Uint8Array(f)); size += f.length; }
    const out = new Uint8Array(size); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
    self.postMessage({ id, mp3: out }, [out.buffer]);
  } catch (err) { self.postMessage({ id, error: String(err && err.message || err) }); }
};
