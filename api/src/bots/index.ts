import { C } from '../db';
import { log } from '../lib/logger';
import type { Handlers } from '../services/router';
import { handleAdmin } from './admin';
import { handleShop } from './shop';
import type { BotDeps } from './common';

// The owner replied to a customer from the WhatsApp Business app (coexistence echo): the bot goes
// quiet in that chat until the owner sends HANDBACK to the Admin Bot (audit decision 20).
export const OWNER_TAKEOVER_REASON = 'owner_replied';

export function createBotHandlers(deps: BotDeps): Handlers {
  return {
    async admin(ctx) { await handleAdmin(ctx, deps); },
    async shop(ctx) { await handleShop(ctx, deps); },
    async ownerEcho(ctx) {
      const at = new Date().toISOString();
      await ctx.db.set(ctx.db.doc(C.conversations, ctx.conversationId), {
        id: ctx.conversationId, businessId: ctx.businessId, channel: ctx.event.source, customerId: ctx.conversationId,
        mode: 'owner', takeoverAt: at, takeoverReason: OWNER_TAKEOVER_REASON, updatedAt: at,
      }, { merge: true });
      log('info', 'owner_takeover', { businessId: ctx.businessId, channel: ctx.event.source });
    },
  };
}
