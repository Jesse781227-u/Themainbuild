// The cells of an Excel (.xlsx) file's first sheet, as rows of text. An .xlsx is a zip of XML files:
// this reads the zip directory, inflates the two files it needs (shared strings, first worksheet)
// with the platform's DecompressionStream, and pulls the cell values out of the XML. No library.
// Old binary .xls files aren't supported (the caller asks for .xlsx or CSV instead).

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

interface Entry { name: string; method: number; size: number; offset: number }

function entries(b: Uint8Array): Entry[] {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) if (u32(b, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('XLSX_NOT_A_ZIP');
  const count = u16(b, eocd + 10);
  let p = u32(b, eocd + 16);
  const out: Entry[] = [];
  for (let i = 0; i < count && u32(b, p) === 0x02014b50; i++) {
    const method = u16(b, p + 10), size = u32(b, p + 20), nameLen = u16(b, p + 28), extra = u16(b, p + 30), comment = u16(b, p + 32), offset = u32(b, p + 42);
    out.push({ name: new TextDecoder().decode(b.subarray(p + 46, p + 46 + nameLen)), method, size, offset });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

async function read(b: Uint8Array, e: Entry): Promise<string> {
  if (u32(b, e.offset) !== 0x04034b50) throw new Error('XLSX_BAD_ENTRY');
  const start = e.offset + 30 + u16(b, e.offset + 26) + u16(b, e.offset + 28);
  const data = b.subarray(start, start + e.size);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error('XLSX_UNSUPPORTED_COMPRESSION');
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

const xml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n))).replace(/&amp;/g, '&');
const texts = (s: string) => [...s.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(m => xml(m[1])).join('');
const column = (ref: string) => [...(/^[A-Z]+/.exec(ref)?.[0] ?? 'A')].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

export async function xlsxRows(bytes: ArrayBuffer, maxRows = 2000): Promise<string[][]> {
  const b = new Uint8Array(bytes);
  const all = entries(b);
  const sheet = all.filter(e => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name)).sort((x, y) => Number(/\d+/.exec(x.name)![0]) - Number(/\d+/.exec(y.name)![0]))[0];
  if (!sheet) throw new Error('XLSX_NO_SHEET');
  const sharedEntry = all.find(e => e.name === 'xl/sharedStrings.xml');
  const shared = sharedEntry ? [...(await read(b, sharedEntry)).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => texts(m[1])) : [];
  const rows: string[][] = [];
  for (const r of (await read(b, sheet)).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = [];
    for (const c of r[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1], body = c[2] ?? '';
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const value = type === 's' ? shared[Number(v)] ?? '' : type === 'inlineStr' ? texts(body) : xml(v ?? '');
      row[ref ? column(ref) : row.length] = value.trim();
    }
    rows.push(Array.from(row, x => x ?? ''));
    if (rows.length >= maxRows) break;
  }
  return rows;
}
