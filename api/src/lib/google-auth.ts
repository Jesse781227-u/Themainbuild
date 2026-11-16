// Service-account OAuth for the Firestore REST API, using WebCrypto (works in Workers and Node).
// Signs a JWT with the service account's private key and exchanges it for an access token, which
// is cached in memory until a minute before it expires.
import type { Credentials } from './firestore';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/datastore';

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));

function pemToDer(pem: string) {
  const body = pem.replace(/\\n/g, '\n').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function tokenProvider(creds: Credentials, doFetch: typeof fetch = (...a) => fetch(...a)) {
  let cached: { token: string; expiresAt: number } | null = null;
  let keyPromise: ReturnType<typeof crypto.subtle.importKey> | null = null;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    keyPromise ??= crypto.subtle.importKey('pkcs8', pemToDer(creds.privateKey), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const iat = Math.floor(Date.now() / 1000);
    const unsigned = `${b64urlJson({ alg: 'RS256', typ: 'JWT' })}.${b64urlJson({ iss: creds.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await keyPromise, new TextEncoder().encode(unsigned));
    const res = await doFetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
    });
    if (!res.ok) throw new Error(`Google token exchange failed: ${res.status}`);
    const json = (await res.json()) as { access_token: string; expires_in: number };
    cached = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
    return cached.token;
  };
}
