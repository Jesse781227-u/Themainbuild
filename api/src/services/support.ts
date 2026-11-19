// "Reply CALL anytime": a support ticket, and an alert to Relay's support number on the Admin Bot.
// Until message templates are approved, the alert only arrives if the support phone has messaged
// the Admin Bot in the last 24 hours; the ticket is always saved.
import { C } from '../db';
import type { Config } from '../config';
import type { Firestore } from '../lib/firestore';
import { randomId } from '../lib/crypto';
import { notifyOwner, type BotDeps } from '../bots/common';

export const CALL = /^(call|call me|help me|support|i need help|human|talk to (a )?(person|human))$/i;

export async function openTicket(db: Firestore, cfg: Config, deps: BotDeps, t: { ownerPhone: string; businessId: string | null; businessName?: string | null; stage: string; message: string }) {
  const id = `T-${randomId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
  const at = new Date().toISOString();
  await db.create(db.doc(C.supportTickets, id), { id, businessId: t.businessId, ownerPhone: t.ownerPhone, stage: t.stage, message: t.message.slice(0, 500), status: 'open', createdAt: at });
  if (cfg.SUPPORT_PHONE && cfg.SUPPORT_PHONE !== t.ownerPhone) {
    const who = `${t.ownerPhone}${t.businessName ? ` (${t.businessName})` : ''}`;
    await notifyOwner(db, deps, { id: t.businessId ?? 'relay', ownerPhone: cfg.SUPPORT_PHONE }, 'support',
      `🆘 Support ${id}: ${who} replied CALL.\nStage: ${t.stage}\nTheir message: "${t.message.slice(0, 200)}"\nCall or WhatsApp them: https://wa.me/${t.ownerPhone.replace(/\D/g, '')}`, id);
  }
  return id;
}
