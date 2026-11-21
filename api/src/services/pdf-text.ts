// The text inside a PDF (unpdf: pdf.js built for Workers). Lists typed in Word or Excel and saved as
// PDF have their words inside, so they can be read without the AI (delivery lists) or by a text-only
// model (Groq) when the file reader (Gemini) is busy. Scanned PDFs have no text: null.
import { extractText, getDocumentProxy } from 'unpdf';

export async function pdfText(bytes: ArrayBuffer | Uint8Array, maxChars = 60_000): Promise<string | null> {
  try {
    const pdf = await getDocumentProxy(bytes instanceof Uint8Array ? new Uint8Array(bytes) : new Uint8Array(bytes.slice(0)));
    const { text } = await extractText(pdf, { mergePages: true });
    const clean = String(text ?? '').replace(/[ \t]+\n/g, '\n').trim();
    return /\p{L}{2,}/u.test(clean) ? clean.slice(0, maxChars) : null;
  } catch {
    return null;
  }
}
