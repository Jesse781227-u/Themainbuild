// The picture for a WhatsApp Status post: the product photo on the shop's own colour, with the shop's
// logo and name at the top and the product, price and "Reply to order" underneath. 1080×1920 (the
// Status size), JPEG. No Relay mark (owner's choice). Built with photon (WebAssembly) in the Worker.
import { PhotonImage, Rgba, SamplingFilter, crop, draw_text_with_color, resize, watermark } from '@cf-wasm/photon';

const W = 1080, H = 1920;

export interface StatusImageInput {
  hex: string;                 // the shop's colour, e.g. "0f766e"
  shopName: string;
  title: string;               // the product (or "New in Shoes")
  price: string;               // "₦18,500" or "from ₦8,000"
  photo?: Uint8Array | null;   // the product photo (JPEG/PNG/WebP bytes)
  logo?: Uint8Array | null;    // the shop's profile photo
}

const rgb = (hex: string) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

function solid(w: number, h: number, [r, g, b]: [number, number, number], a = 255) {
  const px = new Uint8Array(w * h * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; }
  return new PhotonImage(px, w, h);
}

// Centre-crop to a square, then resize.
function square(bytes: Uint8Array, size: number) {
  const img = PhotonImage.new_from_byteslice(bytes);
  const w = img.get_width(), h = img.get_height(), s = Math.min(w, h);
  const cut = crop(img, Math.floor((w - s) / 2), Math.floor((h - s) / 2), Math.floor((w - s) / 2) + s, Math.floor((h - s) / 2) + s);
  const out = resize(cut, size, size, SamplingFilter.Lanczos3);
  img.free(); cut.free();
  return out;
}

// Splits text into at most `lines` lines of about `width` characters, cutting at words.
export function wrapText(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.replace(/\s+/g, ' ').trim().split(' ')) {
    if ((cur ? `${cur} ${w}` : w).length > width && cur) { out.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = `${out[lines - 1].slice(0, width - 1).replace(/\s+\S*$/, '')}…`; }
  return out;
}

// photon's font has no ₦ sign: "NGN" reads the same and never shows a box.
const plain = (s: string) => s.replace(/₦\s?/g, 'NGN ').replace(/[^\x20-\x7E]/g, '').trim();

export function statusImage(i: StatusImageInput): Uint8Array {
  const bg = solid(W, H, rgb(i.hex));
  const white = () => new Rgba(255, 255, 255, 255);
  try {
    // Top: logo and shop name.
    let nameX = 60;
    if (i.logo?.byteLength) {
      try { const logo = square(i.logo, 140); watermark(bg, logo, 60n, 90n); logo.free(); nameX = 230; } catch { /* a logo that can't be read is left out */ }
    }
    wrapText(plain(i.shopName), nameX > 60 ? 24 : 30, 2).forEach((l, n) => draw_text_with_color(bg, l, nameX, 110 + n * 64, 54, white()));
    // The product photo, with a light frame.
    if (i.photo?.byteLength) {
      try {
        const frame = solid(980, 980, [255, 255, 255]);
        watermark(bg, frame, 50n, 290n); frame.free();
        const photo = square(i.photo, 960);
        watermark(bg, photo, 60n, 300n); photo.free();
      } catch { /* an unreadable photo: the text alone still makes a post */ }
    }
    // Underneath: what it is, the price, and what to do.
    const lines = wrapText(plain(i.title), 22, 2);
    lines.forEach((l, n) => draw_text_with_color(bg, l, 60, 1340 + n * 92, 84, white()));
    draw_text_with_color(bg, plain(i.price), 60, 1360 + lines.length * 92 + 20, 120, white());
    const pill = solid(560, 120, [255, 255, 255]);
    watermark(bg, pill, 60n, 1730n); pill.free();
    draw_text_with_color(bg, 'Reply to order', 100, 1760, 64, new Rgba(...rgb(i.hex), 255));
    return bg.get_bytes_jpeg(88);
  } finally { bg.free(); }
}
