// Minimal Firestore client over the REST API (v1). firebase-admin needs Node's gRPC stack and can't run
// on Cloudflare Workers, so this speaks plain fetch. It covers what Relay needs: get, batched get,
// simple queries, writes with field transforms, and read-write transactions with retry on contention.
//
// Values: integers are stored as integerValue (so kobo stays exact), other numbers as doubleValue,
// Date as timestampValue (used for TTL fields), everything else maps to its JSON shape. Undefined
// fields are dropped. Timestamps are decoded back to ISO strings so documents stay plain JSON.

export type Doc = Record<string, unknown>;
export interface DocRef { collection: string; id: string }
export type Op = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'array-contains';
export type Filter = [field: string, op: Op, value: unknown];

class FieldTransform { constructor(readonly kind: 'increment' | 'arrayUnion', readonly value: unknown) {} }
export const increment = (n: number) => new FieldTransform('increment', n);
export const arrayUnion = (...values: unknown[]) => new FieldTransform('arrayUnion', values);

export class FirestoreError extends Error {
  constructor(readonly status: string, readonly httpStatus: number, message: string) { super(`${status}: ${message}`); }
}

type Value = Record<string, unknown>;

export function encodeValue(v: unknown): Value {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'string') return { stringValue: v };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v)) return { arrayValue: { values: v.filter(x => x !== undefined).map(encodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as Doc) } };
  throw new Error(`Unsupported Firestore value: ${typeof v}`);
}

export function encodeFields(doc: Doc): Record<string, Value> {
  const out: Record<string, Value> = {};
  for (const [k, v] of Object.entries(doc)) if (v !== undefined && !(v instanceof FieldTransform)) out[k] = encodeValue(v);
  return out;
}

export function decodeValue(v: Value): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('stringValue' in v) return v.stringValue;
  if ('timestampValue' in v) return new Date(String(v.timestampValue)).toISOString();
  if ('arrayValue' in v) return ((v.arrayValue as { values?: Value[] }).values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields((v.mapValue as { fields?: Record<string, Value> }).fields ?? {});
  if ('referenceValue' in v) return v.referenceValue;
  if ('bytesValue' in v) return v.bytesValue;
  if ('geoPointValue' in v) return v.geoPointValue;
  return null;
}

export function decodeFields(fields: Record<string, Value>): Doc {
  const out: Doc = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

const simpleSegment = /^[a-zA-Z_][a-zA-Z_0-9]*$/;
const quotePath = (path: string) => path.split('.').map(s => (simpleSegment.test(s) ? s : '`' + s.replace(/[`\\]/g, m => '\\' + m) + '`')).join('.');

// Flattens {a: {b: 1}} only where the caller used dotted keys: 'stats.count' becomes a nested field
// and a field path in the update mask. Plain object values are written whole.
function splitUpdate(data: Doc) {
  const fields: Doc = {};
  const mask: string[] = [];
  const transforms: Value[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value instanceof FieldTransform) {
      transforms.push(value.kind === 'increment'
        ? { fieldPath: quotePath(key), increment: encodeValue(value.value) }
        : { fieldPath: quotePath(key), appendMissingElements: { values: (value.value as unknown[]).map(encodeValue) } });
      continue;
    }
    mask.push(quotePath(key));
    const parts = key.split('.');
    let target = fields;
    for (const part of parts.slice(0, -1)) target = (target[part] ??= {}) as Doc;
    target[parts[parts.length - 1]] = value;
  }
  return { fields: encodeFields(fields), mask, transforms };
}

type Write = Record<string, unknown>;

export interface Credentials { clientEmail: string; privateKey: string }
export interface FirestoreOptions {
  projectId: string;
  emulatorHost?: string;
  credentials?: Credentials;
  getToken?: () => Promise<string>;
  fetch?: typeof fetch;
}

export class Firestore {
  private readonly root: string;
  private readonly base: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: FirestoreOptions) {
    this.root = `projects/${opts.projectId}/databases/(default)/documents`;
    const host = opts.emulatorHost ? `http://${opts.emulatorHost}` : 'https://firestore.googleapis.com';
    this.base = `${host}/v1/${this.root}`;
    this.doFetch = opts.fetch ?? ((...args) => fetch(...args));
  }

  doc(collection: string, id: string): DocRef {
    if (!id || id.includes('/')) throw new Error(`Invalid document id for ${collection}`);
    return { collection, id };
  }

  name(ref: DocRef) { return `${this.root}/${ref.collection}/${ref.id}`; }

  private async headers() {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    // The emulator treats "owner" as an admin token that bypasses security rules.
    if (this.opts.emulatorHost) h.authorization = 'Bearer owner';
    else if (this.opts.getToken) h.authorization = `Bearer ${await this.opts.getToken()}`;
    return h;
  }

  async call<T>(action: string, body: unknown): Promise<T> {
    const res = await this.doFetch(`${this.base}:${action}`, { method: 'POST', headers: await this.headers(), body: JSON.stringify(body) });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const err = (Array.isArray(json) ? json[0]?.error : json.error) ?? {};
      throw new FirestoreError(String(err.status ?? res.status), res.status, String(err.message ?? 'Firestore request failed'));
    }
    return json as T;
  }

  async getAll(refs: DocRef[], transaction?: string): Promise<(Doc | null)[]> {
    if (!refs.length) return [];
    const names = refs.map(r => this.name(r));
    const rows = await this.call<{ found?: { name: string; fields?: Record<string, Value> }; missing?: string }[]>('batchGet', { documents: names, ...(transaction ? { transaction } : {}) });
    const byName = new Map<string, Doc | null>();
    for (const row of rows) {
      if (row.found) byName.set(row.found.name, decodeFields(row.found.fields ?? {}));
      else if (row.missing) byName.set(row.missing, null);
    }
    return names.map(n => byName.get(n) ?? null);
  }

  async get(ref: DocRef, transaction?: string) { return (await this.getAll([ref], transaction))[0]; }

  async query(collection: string, filters: Filter[] = [], opts: { orderBy?: [string, 'asc' | 'desc'][]; limit?: number; transaction?: string } = {}): Promise<(Doc & { _id: string })[]> {
    const ops: Record<Op, string> = { '==': 'EQUAL', '!=': 'NOT_EQUAL', '<': 'LESS_THAN', '<=': 'LESS_THAN_OR_EQUAL', '>': 'GREATER_THAN', '>=': 'GREATER_THAN_OR_EQUAL', in: 'IN', 'array-contains': 'ARRAY_CONTAINS' };
    const fieldFilters = filters.map(([field, op, value]) => ({ fieldFilter: { field: { fieldPath: quotePath(field) }, op: ops[op], value: encodeValue(value) } }));
    const structuredQuery: Record<string, unknown> = { from: [{ collectionId: collection }] };
    if (fieldFilters.length === 1) structuredQuery.where = fieldFilters[0];
    else if (fieldFilters.length > 1) structuredQuery.where = { compositeFilter: { op: 'AND', filters: fieldFilters } };
    if (opts.orderBy) structuredQuery.orderBy = opts.orderBy.map(([f, d]) => ({ field: { fieldPath: quotePath(f) }, direction: d === 'asc' ? 'ASCENDING' : 'DESCENDING' }));
    if (opts.limit) structuredQuery.limit = opts.limit;
    const rows = await this.call<{ document?: { name: string; fields?: Record<string, Value> } }[]>('runQuery', { structuredQuery, ...(opts.transaction ? { transaction: opts.transaction } : {}) });
    return rows.filter(r => r.document).map(r => ({ ...decodeFields(r.document!.fields ?? {}), _id: r.document!.name.split('/').pop()! }));
  }

  // Write builders, shared by batches and transactions.
  setWrite(ref: DocRef, data: Doc, opts: { merge?: boolean } = {}): Write {
    const { fields, mask, transforms } = splitUpdate(data);
    return { update: { name: this.name(ref), fields }, ...(opts.merge ? { updateMask: { fieldPaths: mask } } : {}), ...(transforms.length ? { updateTransforms: transforms } : {}) };
  }
  createWrite(ref: DocRef, data: Doc): Write { return { ...this.setWrite(ref, data), currentDocument: { exists: false } }; }
  updateWrite(ref: DocRef, data: Doc): Write { return { ...this.setWrite(ref, data, { merge: true }), currentDocument: { exists: true } }; }
  deleteWrite(ref: DocRef): Write { return { delete: this.name(ref) }; }

  async commit(writes: Write[], transaction?: string) {
    if (!writes.length && !transaction) return;
    await this.call('commit', { writes, ...(transaction ? { transaction } : {}) });
  }

  set(ref: DocRef, data: Doc, opts: { merge?: boolean } = {}) { return this.commit([this.setWrite(ref, data, opts)]); }
  update(ref: DocRef, data: Doc) { return this.commit([this.updateWrite(ref, data)]); }
  delete(ref: DocRef) { return this.commit([this.deleteWrite(ref)]); }

  // Creates the document only if it doesn't exist. Returns false when it already did.
  async create(ref: DocRef, data: Doc) {
    try { await this.commit([this.createWrite(ref, data)]); return true; }
    catch (e) { if (isAlreadyExists(e)) return false; throw e; }
  }

  batch() { return new WriteBatch(this); }

  async runTransaction<T>(fn: (tx: Transaction) => Promise<T>, attempts = 6): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const { transaction } = await this.call<{ transaction: string }>('beginTransaction', { options: { readWrite: {} } });
      const tx = new Transaction(this, transaction);
      try {
        const result = await fn(tx);
        await this.commit(tx.writes, transaction);
        return result;
      } catch (e) {
        await this.call('rollback', { transaction }).catch(() => undefined);
        if (e instanceof FirestoreError && e.status === 'ABORTED') { lastError = e; await new Promise(r => setTimeout(r, 20 * 2 ** attempt + Math.random() * 20)); continue; }
        throw e;
      }
    }
    throw lastError;
  }
}

export const isAlreadyExists = (e: unknown) => e instanceof FirestoreError && (e.status === 'ALREADY_EXISTS' || e.status === 'FAILED_PRECONDITION');

export class WriteBatch {
  readonly writes: Write[] = [];
  constructor(protected readonly db: Firestore) {}
  set(ref: DocRef, data: Doc, opts: { merge?: boolean } = {}) { this.writes.push(this.db.setWrite(ref, data, opts)); return this; }
  create(ref: DocRef, data: Doc) { this.writes.push(this.db.createWrite(ref, data)); return this; }
  update(ref: DocRef, data: Doc) { this.writes.push(this.db.updateWrite(ref, data)); return this; }
  delete(ref: DocRef) { this.writes.push(this.db.deleteWrite(ref)); return this; }
  commit() { return this.db.commit(this.writes); }
}

// Reads must all happen before writes (as in every Firestore SDK). Writes are buffered and sent in
// the commit, which fails with ABORTED if anything read has changed since; runTransaction retries.
export class Transaction extends WriteBatch {
  constructor(db: Firestore, readonly id: string) { super(db); }
  get(ref: DocRef) { return this.db.get(ref, this.id); }
  getAll(refs: DocRef[]) { return this.db.getAll(refs, this.id); }
  query(collection: string, filters: Filter[] = [], opts: { orderBy?: [string, 'asc' | 'desc'][]; limit?: number } = {}) { return this.db.query(collection, filters, { ...opts, transaction: this.id }); }
}
