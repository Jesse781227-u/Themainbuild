// Pulls product photos out of a PDF catalogue, without rendering it: photos in PDFs are almost always
// JPEG streams (/DCTDecode), sometimes wrapped in /ASCII85Decode, /ASCIIHexDecode or /FlateDecode.
// Those wrappers are undone here and the JPEG bytes returned as-is. Other image kinds (raw pixels,
// JPEG 2000) are skipped. Tiny images (logos, icons) are skipped too.
export interface PdfImage { bytes: Uint8Array; mimeType: 'image/jpeg'; width: number; height: number }

const MIN_SIDE = 120;
const MIN_BYTES = 3_000;

function ascii85(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  const s = new TextDecoder('latin1').decode(input).replace(/^<~/, '').replace(/~>[\s\S]*$/, '');
  const flush = (len: number) => {
    while (group.length < 5) group.push(84); // pad with 'u'
    let n = 0;
    for (const c of group) n = n * 85 + c;
    const bytes = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    out.push(...bytes.slice(0, len - 1));
    group = [];
  };
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code <= 32) continue;
    if (ch === 'z' && group.length === 0) { out.push(0, 0, 0, 0); continue; }
    if (code < 33 || code > 117) continue;
    group.push(code - 33);
    if (group.length === 5) flush(5);
  }
  if (group.length) flush(group.length);
  return new Uint8Array(out);
}

function asciiHex(input: Uint8Array): Uint8Array {
  const hex = new TextDecoder('latin1').decode(input).replace(/>[\s\S]*$/, '').replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.ceil(hex.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt((hex.slice(i * 2, i * 2 + 2) + '0').slice(0, 2), 16);
  return out;
}

async function inflate(input: Uint8Array): Promise<Uint8Array> {
  // Copied into a plain ArrayBuffer-backed array for Blob.
  const stream = new Blob([new Uint8Array(input)]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const num = (dict: string, key: string) => Number((new RegExp(`/${key}\\s+(\\d+)`).exec(dict) ?? [])[1] ?? 0);

export async function extractPdfImages(pdf: ArrayBuffer, max = 40): Promise<PdfImage[]> {
  const bytes = new Uint8Array(pdf);
  const text = new TextDecoder('latin1').decode(bytes); // one char per byte, so indexes match
  const out: PdfImage[] = [];
  const objRe = /\d+\s+\d+\s+obj\s*<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = objRe.exec(text)) && out.length < max) {
    const dict = m[1];
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue;
    const width = num(dict, 'Width'), height = num(dict, 'Height');
    if (width && height && (width < MIN_SIDE || height < MIN_SIDE)) continue;
    const filters = (/\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(dict)?.[1] ?? '').match(/\/\w+/g)?.map(f => f.slice(1)) ?? [];
    if (filters[filters.length - 1] !== 'DCTDecode') continue;
    const start = m.index + m[0].length;
    const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const end = direct ? start + Number(direct[1]) : text.indexOf('endstream', start);
    if (end <= start) continue;
    let data: Uint8Array = bytes.slice(start, end);
    try {
      for (const f of filters.slice(0, -1)) {
        if (f === 'ASCII85Decode' || f === 'A85') data = ascii85(data);
        else if (f === 'ASCIIHexDecode' || f === 'AHx') data = asciiHex(data);
        else if (f === 'FlateDecode' || f === 'Fl') data = await inflate(data);
        else throw new Error(`unsupported ${f}`);
      }
    } catch { continue; }
    if (data.length < MIN_BYTES || data[0] !== 0xff || data[1] !== 0xd8) continue; // not a JPEG
    out.push({ bytes: data, mimeType: 'image/jpeg', width, height });
  }
  return out;
}
