// Stand-in pictures for products without a photo, so carousels never show a blank or the same grey
// box: the shop's colour with the product's first letter. Drawn on request as a small PNG (no image
// library: a 5×7 pixel font, scaled up) and cached by the CDN. A real photo replaces it automatically,
// because cards use product.images[0] whenever there is one.
// Name and price are in the card text under the picture, so the picture only needs to look tidy.

// Calm colours that work with white letters (contrast ≥ 4.5:1).
export const SHOP_COLOURS = ['0f766e', '1d4ed8', '7c3aed', 'be185d', 'b45309', '15803d', '334155', 'b91c1c'] as const;

export function shopColour(businessId: string) {
  let h = 0;
  for (const ch of businessId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SHOP_COLOURS[h % SHOP_COLOURS.length];
}

export function initialOf(name: string) {
  const ch = name.normalize('NFD').replace(/[^A-Za-z0-9]/g, '').charAt(0).toUpperCase();
  return ch || 'R';
}

export const placeholderPath = (businessId: string, name: string) => `/ph/${shopColour(businessId)}/${initialOf(name)}.png`;

const FONT: Record<string, string> = {
  A: '01110100011000111111100011000110001', B: '11110100011000111110100011000111110', C: '01110100011000010000100001000101110',
  D: '11100100101000110001100011001011100', E: '11111100001000011110100001000011111', F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111', H: '10001100011000111111100011000110001', I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100', K: '10001100101010011000101001001010001', L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001', N: '10001100011100110101100111000110001', O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000', Q: '01110100011000110001101011001001101', R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110', T: '11111001000010000100001000010000100', U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100', W: '10001100011000110101101011010101010', X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100', Z: '11111000010001000100010001000011111',
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110', 2: '01110100010000100010001000100011111',
  3: '11111000100010000010000011000101110', 4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000', 8: '01110100011000101110100011000101110',
  9: '01110100011000101111000010001001100',
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function zlib(raw: Uint8Array) {
  // "deflate" in the Compression Streams API is the zlib format PNG needs.
  const stream = new Blob([raw.buffer as ArrayBuffer]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const rgb = (hex: string) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16));
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

// A square PNG: the colour, a lighter disc, and the letter in white.
export async function placeholderPng(hex: string, letter: string, size = 600): Promise<Uint8Array> {
  const bg = rgb(hex), disc = mix(bg, [255, 255, 255], 0.14), ink = [255, 255, 255];
  const glyph = FONT[letter] ?? FONT.R;
  const scale = Math.floor(size / 15), gw = 5 * scale, gh = 7 * scale;
  const gx = Math.floor((size - gw) / 2), gy = Math.floor((size - gh) / 2);
  const r = size * 0.36, c = size / 2;
  const row = 1 + size * 3;
  const raw = new Uint8Array(row * size);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0; // no filter
    for (let x = 0; x < size; x++) {
      let px = (x - c) ** 2 + (y - c) ** 2 <= r * r ? disc : bg;
      const fx = x - gx, fy = y - gy;
      if (fx >= 0 && fy >= 0 && fx < gw && fy < gh && glyph[Math.floor(fy / scale) * 5 + Math.floor(fx / scale)] === '1') px = ink;
      raw.set(px, y * row + 1 + x * 3);
    }
  }
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, size); v.setUint32(4, size);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await zlib(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
