// Smart Reach marketing templates: the paid route, for customers whose 24h chat window is closed.
// Each shop connects its own WhatsApp Business account, so the templates are submitted to each
// shop's account (scripts/submit-templates.ts) and their status is kept per shop in
// templateStatus/{businessId}_{name}. Only approved ones are used. All are MARKETING (never labelled
// utility). Variables are filled per customer and checked first: a missing one skips that customer.
import { C } from '../db';
import type { Firestore } from '../lib/firestore';

export type Variable = 'name' | 'shop' | 'item' | 'size' | 'area' | 'price' | 'code' | 'message';

export interface ReachTemplate {
  name: string; category: 'MARKETING'; language: string;
  body: string;                  // Meta's {{1}}, {{2}}… in the order of `variables`
  variables: Variable[];
  header?: 'image' | null;       // a product photo on top
  carousel?: boolean;            // "picked for you": product cards
  example: string[];             // sample values Meta asks for
}

export const TEMPLATES: ReachTemplate[] = [
  { name: 'relay_update', category: 'MARKETING', language: 'en', body: 'Hi {{1}}! News from {{2}}: {{3}}', variables: ['name', 'shop', 'message'], example: ['Ada', "Tee's Thrift", 'new Ankara gowns just landed, from ₦18,000.'] },
  { name: 'relay_new_arrival', category: 'MARKETING', language: 'en', body: 'Hi {{1}}, {{2}} just arrived at {{3}}, {{4}}. Reply to order!', variables: ['name', 'item', 'shop', 'price'], header: 'image', example: ['Ada', 'Black Ankle Boots', "Tee's Thrift", '₦15,000'] },
  { name: 'relay_back_in_stock', category: 'MARKETING', language: 'en', body: 'Good news {{1}}! {{2}} is back in stock at {{3}}. Reply to order before it goes again.', variables: ['name', 'item', 'shop'], header: 'image', example: ['Ada', 'Black Ankle Boots (42)', "Tee's Thrift"] },
  { name: 'relay_price_drop', category: 'MARKETING', language: 'en', body: 'Hi {{1}}, {{2}} at {{3}} is now {{4}}. Reply to order!', variables: ['name', 'item', 'shop', 'price'], header: 'image', example: ['Ada', 'Plaid Flannel Shirt', "Tee's Thrift", '₦5,500'] },
  { name: 'relay_offer', category: 'MARKETING', language: 'en', body: 'Hi {{1}}, a little thank-you from {{2}}: use code {{3}} on your next order. Reply to order!', variables: ['name', 'shop', 'code'], example: ['Ada', "Tee's Thrift", 'ADA10'] },
  { name: 'relay_picked_for_you', category: 'MARKETING', language: 'en', body: 'Hi {{1}}, we picked these for you at {{2}} 👇', variables: ['name', 'shop'], carousel: true, example: ['Ada', "Tee's Thrift"] },
];

export const templateByName = (name: string) => TEMPLATES.find(t => t.name === name) ?? null;

// The values for one customer, or the variables that are missing (then they're skipped, never sent
// a broken message).
export function fillVariables(t: Pick<ReachTemplate, 'variables'>, values: Partial<Record<Variable, string | null | undefined>>): { ok: true; params: string[] } | { ok: false; missing: Variable[] } {
  const missing = t.variables.filter(v => !String(values[v] ?? '').trim());
  if (missing.length) return { ok: false, missing };
  return { ok: true, params: t.variables.map(v => String(values[v]).trim().slice(0, v === 'message' ? 900 : 120)) };
}

// The library in Meta's create-template format (what the submit script sends).
export function templatePayloads() {
  return TEMPLATES.map(t => {
    const problems: string[] = [];
    if (!/^[a-z0-9_]{1,512}$/.test(t.name)) problems.push('name: lower case, numbers and _ only');
    const used = [...t.body.matchAll(/\{\{(\d+)\}\}/g)].map(m => Number(m[1]));
    if (used.length !== t.variables.length || used.some((n, i) => n !== i + 1)) problems.push('body variables must be {{1}}…{{n}} in order, one per variable');
    if (t.example.length !== t.variables.length) problems.push('one example per variable');
    if (problems.length) throw new Error(`TEMPLATE_INVALID ${t.name}: ${problems.join('; ')}`);
    const components: Record<string, unknown>[] = [];
    if (t.header === 'image') components.push({ type: 'HEADER', format: 'IMAGE', example: { header_handle: ['<upload handle>'] } });
    components.push({ type: 'BODY', text: t.body, example: { body_text: [t.example] } });
    if (t.carousel) components.push({ type: 'CAROUSEL', cards: [] }); // cards are built from products when sent
    return { name: t.name, category: t.category, language: t.language, components };
  });
}

export type TemplateState = 'not_submitted' | 'pending' | 'approved' | 'rejected';
export async function templateState(db: Firestore, businessId: string, name: string): Promise<TemplateState> {
  return ((await db.get(db.doc(C.templateStatus, `${businessId}_${name}`)))?.status as TemplateState | undefined) ?? 'not_submitted';
}
export async function setTemplateState(db: Firestore, businessId: string, name: string, status: TemplateState, extra: Record<string, unknown> = {}) {
  await db.set(db.doc(C.templateStatus, `${businessId}_${name}`), { businessId, name, status, updatedAt: new Date().toISOString(), ...extra }, { merge: true });
}
