// Decides which bot handles an inbound event:
//   - a message to the Relay Admin Bot number → admin handler (the owner managing their business)
//   - a message to a merchant's connected WhatsApp number or Instagram account → shop handler
//   - anything else (a number we don't know) → ignored
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { log } from '../lib/logger';
import { maskPhone } from '../lib/phone';
import type { InboundEvent } from './inbound';
import { customerConversationId, recordAdminInbound, recordCustomerInbound } from './conversations';

export interface AdminContext { db: Firestore; cfg: Config; event: InboundEvent; ownerPhone: string; businessId: string | null; conversationId: string }
export interface ShopContext { db: Firestore; cfg: Config; event: InboundEvent; businessId: string; conversationId: string }
export interface Handlers {
  admin(ctx: AdminContext): Promise<void>;
  shop(ctx: ShopContext): Promise<void>;
  ownerEcho?(ctx: ShopContext): Promise<void>;
}

// Phase 3 replaces these with the Admin Bot and Shop Bot.
export const placeholderHandlers: Handlers = {
  async admin(ctx) { log('info', 'admin_message_received', { eventId: ctx.event.id, businessId: ctx.businessId, from: maskPhone(ctx.ownerPhone), type: ctx.event.type }); },
  async shop(ctx) { log('info', 'shop_message_received', { eventId: ctx.event.id, businessId: ctx.businessId, channel: ctx.event.source, type: ctx.event.type }); },
};

export type Route = 'admin' | 'shop' | 'owner_echo' | 'ignored';

export async function routeEvent(db: Firestore, cfg: Config, event: InboundEvent, handlers: Handlers): Promise<Route> {
  if (event.source === 'whatsapp' && cfg.ADMIN_BOT_PHONE_NUMBER_ID && event.accountId === cfg.ADMIN_BOT_PHONE_NUMBER_ID) {
    if (event.kind !== 'message') return 'ignored';
    const owner = await db.get(db.doc(C.ownerPhones, event.from));
    const businessId = (owner?.businessId as string | undefined) ?? null;
    const conversationId = await recordAdminInbound(db, { ownerPhone: event.from, businessId, at: event.sentAt });
    await handlers.admin({ db, cfg, event, ownerPhone: event.from, businessId, conversationId });
    return 'admin';
  }

  const account = await db.get(db.doc(C.channelAccounts, `${event.source}_${event.accountId}`));
  if (!account?.businessId) {
    log('warn', 'inbound_unknown_account', { eventId: event.id, source: event.source });
    return 'ignored';
  }
  const businessId = String(account.businessId);

  if (event.kind === 'echo') {
    if (!handlers.ownerEcho) return 'ignored';
    await handlers.ownerEcho({ db, cfg, event, businessId, conversationId: customerConversationId(businessId, event.source, event.from) });
    return 'owner_echo';
  }

  const conversationId = await recordCustomerInbound(db, {
    businessId, channel: event.source, customerKey: event.from,
    phone: event.source === 'whatsapp' ? event.from : null, name: event.contactName, at: event.sentAt,
  });
  await handlers.shop({ db, cfg, event, businessId, conversationId });
  return 'shop';
}
