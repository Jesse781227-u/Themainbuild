// Several shops on one number: SWITCH lists them, NEW SHOP starts signup for another shop or branch.
import { C } from '../db';
import type { Business } from '../domain/business';
import type { OutboundContent } from '../services/channel';
import type { AdminContext } from '../services/router';
import { getOwner, switchShop } from '../services/owners';
import { buttons, list } from './common';
import { firstOnboarding } from './onboarding';

// SWITCH lists the owner's shops; NEW SHOP starts signup for another shop or branch (its own number,
// products and wallet). Returns true when it handled the message.
export async function handleShops(ctx: AdminContext, business: Business, choiceId: string | null, text: string, reply: (c: OutboundContent | string) => Promise<unknown>) {
  const { db } = ctx;
  const t = text.trim().toLowerCase();
  if (choiceId?.startsWith('shop:')) {
    const id = choiceId.slice(5);
    if (!(await switchShop(db, ctx.ownerPhone, id))) { await reply("That shop isn't on this number."); return true; }
    const next = (await db.get(db.doc(C.businesses, id))) as Business | null;
    await db.set(db.doc(C.conversations, ctx.conversationId), { businessId: id, productDraft: null, awaiting: null, editingProductId: null, importDraft: null, pendingAction: null }, { merge: true });
    await reply(`Now managing *${next?.name ?? 'that shop'}* ✅ Everything you send now is for this shop. Send SWITCH to change again.`);
    return true;
  }
  if (/^(switch|switch shops?|my shops|shops|branches|my branches)$/.test(t)) {
    const owner = await getOwner(db, ctx.ownerPhone);
    const all = ((await db.getAll((owner?.businessIds ?? [business.id]).map(id => db.doc(C.businesses, id)))) as (Business | null)[]).filter((b): b is Business => !!b && b.status !== 'deleted');
    if (all.length < 2) {
      await reply(buttons(`You have one shop on this number: *${business.name}*. Want to add another shop or branch?`, [['newshop:yes', 'Add a shop'], ['newshop:no', 'Not now']]));
      return true;
    }
    await reply(list(`You're managing *${business.name}*. Which shop do you want to manage?`, 'Switch shop', all.slice(0, 10).map(b => ({ id: `shop:${b.id}`, title: b.name, description: [b.area, b.status === 'active' ? 'live' : 'setting up'].filter(Boolean).join(' · ') })), 'Your shops'));
    return true;
  }
  if (/^(new shop|add (a |another )?shop|new branch|add (a |another )?branch|another shop|open (a |another )?(shop|branch))$/.test(t)) {
    await reply(buttons('Add another shop or branch? It gets its own WhatsApp number, products and wallet, and you manage it from this chat (send SWITCH to move between shops).', [['newshop:yes', 'Yes, add a shop'], ['newshop:no', 'Not now']]));
    return true;
  }
  if (choiceId === 'newshop:no') { await reply('OK.'); return true; }
  if (choiceId === 'newshop:yes') {
    const ob = firstOnboarding({ adding: true });
    await db.set(db.doc(C.conversations, ctx.conversationId), { onboarding: { ...ob, lastSeenAt: new Date().toISOString() }, productDraft: null, awaiting: null, editingProductId: null, importDraft: null }, { merge: true });
    await reply("What's the new shop or branch called?");
    return true;
  }
  return false;
}
