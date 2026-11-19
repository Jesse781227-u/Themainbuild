// Shop settings from signup that the owner can change any time by chat:
//   HOURS · HOURS Mon–Sat 8am–9pm, Sun closed · AFTER HOURS (take orders / menu only)
//   POLICIES · POLICIES: <their own words> · FEE (who pays Relay's 1%) · SWITCH/NEW SHOP live in admin.ts
// Returns the reply, or null when the message isn't a settings command.
import { C } from '../db';
import type { Business } from '../domain/business';
import type { Firestore } from '../lib/firestore';
import { formatKobo } from '../lib/money';
import type { Config } from '../config';
import type { OutboundContent } from '../services/channel';
import { describeHours, parseHours } from '../services/hours';
import { policyText } from '../services/policies';
import { buttons } from './common';

async function save(db: Firestore, business: Business, patch: Partial<Business>) {
  await db.update(db.doc(C.businesses, business.id), { ...patch, updatedAt: new Date().toISOString() } as Record<string, unknown>);
  Object.assign(business, patch);
}

export async function handleSettings(db: Firestore, cfg: Config, business: Business, text: string, choiceId: string | null): Promise<OutboundContent | string | null> {
  const t = text.trim();
  let m: RegExpExecArray | null;

  // Opening hours.
  if (/^(hours|opening hours|my hours)$/i.test(t)) {
    return business.hours ? `Your opening hours: ${describeHours(business.hours)}.\nTo change them send e.g. *hours Mon–Sat 8am–9pm, Sun closed*.` : 'No opening hours set: customers can order any time. To set them send e.g. *hours 8am–9pm*.';
  }
  if ((m = /^(?:hours|opening hours|set hours)\s*:?\s+(.+)$/i.exec(t))) {
    if (/^(none|off|always open|24\/?7|any ?time)$/i.test(m[1].trim())) { await save(db, business, { hours: null }); return 'Done ✅ No opening hours: customers can order any time.'; }
    const parsed = parseHours(m[1]);
    if (!parsed) return 'I couldn\'t read those hours. Try *hours 8am–9pm*, or *hours Mon–Fri 8am–6pm, Sat 10am–4pm, Sun closed*.';
    await save(db, business, { hours: parsed.hours });
    return `Saved ✅ ${describeHours(parsed.hours)}.`;
  }

  // Outside opening hours: take orders for later, or menu only.
  if (choiceId === 'ah:orders' || choiceId === 'ah:menu' || /^after ?hours\s+(take orders|orders|menu( only)?|closed)$/i.test(t)) {
    const mode = choiceId === 'ah:menu' || /menu|closed/i.test(choiceId ? '' : t) ? 'menu' : 'orders';
    await save(db, business, { afterHours: mode });
    return mode === 'menu' ? 'Done ✅ When you\'re closed, customers see your menu and when you open, but can\'t order.' : 'Done ✅ When you\'re closed, customers can still order for when you open.';
  }
  if (/^after ?hours$/i.test(t)) {
    const now = business.afterHours === 'menu' ? 'customers see the menu but can\'t order' : 'customers can still order for when you open';
    return buttons(`When you're closed, ${now}. Change it?`, [['ah:orders', 'Take orders'], ['ah:menu', 'Menu only']]);
  }

  // Shop policies.
  if (/^(policies|policy|my policies|return policy|returns policy)$/i.test(t)) {
    const p = policyText(business.policies);
    return p ? `Your shop policies (your shop assistant uses these to answer customers):\n\n${p}\n\nTo change them send *policies:* followed by your own words.` : 'No policies set. Send *policies:* followed by your own words, e.g. *policies: Exchange within 3 days. No refunds.*';
  }
  if ((m = /^(?:policies|policy|set policies)\s*:\s*([\s\S]{5,600})$/i.exec(t))) {
    await save(db, business, { policies: { returns: business.policies?.returns ?? '', issues: business.policies?.issues ?? '', custom: m[1].trim() } });
    return 'Saved ✅ Your shop assistant will use these from now on.';
  }

  // Verification before the first withdrawal (KYC). TODO(jesse): the KYC flow (later phase).
  if (/^(verify|verify me|verify account|kyc|withdraw|wallet|my wallet|payout|withdrawal)$/i.test(t)) {
    await db.update(db.doc(C.businesses, business.id), { kycRequestedAt: new Date().toISOString() });
    return 'Thanks! Account verification for withdrawals is opening very soon, and you\'ll be among the first we message. Your money stays safe in your Relay wallet until then. Questions? Reply *CALL*.';
  }

  // Who pays Relay's fee.
  if (choiceId === 'fee:customer' || choiceId === 'fee:owner') {
    await save(db, business, { feePayer: choiceId === 'fee:owner' ? 'owner' : 'customer' });
    return choiceId === 'fee:owner' ? 'Done ✅ You pay Relay\'s fee from now on: customers pay your prices, and the fee comes out of what you receive.' : 'Done ✅ Customers pay Relay\'s fee from now on, as a small service fee on their total.';
  }
  if (/^(fee|fees|relay fee|service fee)$/i.test(t)) {
    const who = business.feePayer === 'owner' ? 'You pay it: it comes out of what you receive' : 'Your customers pay it, as a service fee on their total';
    return buttons(`Relay's fee is 1% of each paid order, at most ${formatKobo(cfg.FEE_CAP_KOBO)}, and nothing on delivery. ${who}.\n\nWho should pay it?`, [['fee:customer', 'My customers'], ['fee:owner', "I'll pay it"]]);
  }
  return null;
}

