import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { extractPdfImages } from '../src/services/pdf-images';
import { cleanItems } from '../src/bots/catalog-import';

// A fake JPEG: the right magic bytes and enough length; the extractor never decodes pixels.
const jpeg = (seed: number, size = 4000) => { const b = new Uint8Array(size); b[0] = 0xff; b[1] = 0xd8; for (let i = 2; i < size; i++) b[i] = (i * seed) % 251; return b; };

function ascii85(bytes: Uint8Array) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = [bytes[i], bytes[i + 1] ?? 0, bytes[i + 2] ?? 0, bytes[i + 3] ?? 0];
    let n = ((chunk[0] << 24) >>> 0) + (chunk[1] << 16) + (chunk[2] << 8) + chunk[3];
    const len = Math.min(4, bytes.length - i);
    if (n === 0 && len === 4) { out += 'z'; continue; }
    const c: string[] = [];
    for (let k = 0; k < 5; k++) { c.unshift(String.fromCharCode((n % 85) + 33)); n = Math.floor(n / 85); }
    out += c.slice(0, len + 1).join('');
  }
  return `${out}~>`;
}

function pdfWith(streams: { dict: string; data: Uint8Array }[]) {
  const parts: Buffer[] = [Buffer.from('%PDF-1.4\n')];
  streams.forEach((s, i) => parts.push(Buffer.from(`${i + 1} 0 obj\n<< ${s.dict} /Length ${s.data.length} >>\nstream\n`, 'latin1'), Buffer.from(s.data), Buffer.from('\nendstream\nendobj\n')));
  parts.push(Buffer.from('%%EOF'));
  const b = Buffer.concat(parts);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

test('pdf photos: JPEGs are pulled out raw, from ASCII85 and Flate wrappers too; tiny and non-JPEG images are skipped', async () => {
  const a = jpeg(3), b = jpeg(7), c = jpeg(11);
  const pdf = pdfWith([
    { dict: '/Type /XObject /Subtype /Image /Width 600 /Height 600 /Filter /DCTDecode', data: a },
    { dict: '/Type /XObject /Subtype /Image /Width 600 /Height 600 /Filter [ /ASCII85Decode /DCTDecode ]', data: Buffer.from(ascii85(b), 'latin1') },
    { dict: '/Type /XObject /Subtype /Image /Width 400 /Height 400 /Filter [ /FlateDecode /DCTDecode ]', data: deflateSync(c) },
    { dict: '/Type /XObject /Subtype /Image /Width 32 /Height 32 /Filter /DCTDecode', data: jpeg(5) }, // an icon
    { dict: '/Type /XObject /Subtype /Image /Width 600 /Height 600 /Filter /FlateDecode', data: deflateSync(Buffer.alloc(5000)) }, // raw pixels
    { dict: '/Length1 10 /Filter /FlateDecode', data: deflateSync(Buffer.from('BT (Jollof 2500) Tj ET')) }, // text, not an image
  ]);
  const imgs = await extractPdfImages(pdf);
  assert.equal(imgs.length, 3);
  assert.deepEqual([...imgs[0].bytes], [...a]);
  assert.deepEqual([...imgs[1].bytes], [...b], 'ASCII85 undone');
  assert.deepEqual([...imgs[2].bytes], [...c], 'Flate undone');
  assert.deepEqual([imgs[2].width, imgs[2].height], [400, 400]);
});

test('pdf photos: each photo goes to at most one item, and bad indexes are ignored', () => {
  const urls = ['u1', 'u2', 'u3'];
  const { items } = cleanItems([
    { name: 'Coat', price: 18500, category: 'Clothing', image: 1 },
    { name: 'Hoodie', price: 7500, category: 'Clothing', image: 1 }, // already used
    { name: 'Boots', price: 28000, category: 'Shoes', image: 9 },    // no such photo
    { name: 'Bag', price: 9000, category: 'Bags', image: 3 },
    { name: 'Belt', price: 4000, category: 'Accessories', image: null },
  ], 'Products', urls);
  assert.deepEqual(items.map(i => [i.name, i.imageUrl]), [['Coat', 'u1'], ['Hoodie', null], ['Boots', null], ['Bag', 'u3'], ['Belt', null]]);
});
