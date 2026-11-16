// Phone numbers are stored as E.164 ("+2348031234567"). Meta sends WhatsApp numbers as digits
// without the plus ("2348031234567"). Logs only ever see the masked form.

const NG_MOBILE = /^[789][01]\d{8}$/; // 10 digits after the leading 0, e.g. 803 123 4567

export function normalisePhone(input: string, defaultCountry: 'NG' = 'NG'): string | null {
  const raw = String(input ?? '').trim();
  const hasPlus = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);
  if (!digits) return null;

  if (defaultCountry === 'NG') {
    if (digits.startsWith('234')) {
      let rest = digits.slice(3);
      if (rest.startsWith('0')) rest = rest.slice(1); // "+234 0803…" is a common typo
      return NG_MOBILE.test(rest) ? `+234${rest}` : null;
    }
    if (!hasPlus) {
      if (digits.length === 11 && digits.startsWith('0') && NG_MOBILE.test(digits.slice(1))) return `+234${digits.slice(1)}`;
      if (digits.length === 10 && NG_MOBILE.test(digits)) return `+234${digits}`;
    }
  }
  // Another country, written in international form.
  if ((hasPlus || digits.length >= 11) && digits.length >= 8 && digits.length <= 15 && !digits.startsWith('0')) return `+${digits}`;
  return null;
}

// Meta's "wa_id"/"from" format: digits only.
export const toWaId = (e164: string) => e164.replace(/^\+/, '');

export function maskPhone(phone: string | undefined | null) {
  const d = String(phone ?? '').replace(/\D/g, '');
  if (d.length < 7) return '***';
  return `+${d.slice(0, 3)}***${d.slice(-4)}`;
}
