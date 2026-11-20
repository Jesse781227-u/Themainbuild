// The owner's wallet by chat:
//   /wallet    balance, what can go out today, where payouts go → [Withdraw] [Payout history] [Menu]
//   /verify    once, before the first withdrawal: name on the bank account → BVN → bank → account
//              number → read back → saved (encrypted) → verified (test mode) or checked by Relay
//   /withdraw  [All ₦X] [Another amount] → "Send ₦X to GTBank ••6789?" [Yes, send it] [Cancel]
// While typing: conversation.awaiting = kyc:name | kyc:bvn | kyc:bank | kyc:account | withdraw.
// The KYC answers wait in conversation.kycDraft (BVN and account number already encrypted).
import { C } from '../db';
import { decrypt, encrypt, randomId } from '../lib/crypto';
import { formatKobo, nairaToKobo } from '../lib/money';
import { log } from '../lib/logger';
import { bankLine, getKyc, getWallet, MIN_PAYOUT_KOBO, payoutLine, recentPayouts, requestPayout, saveKyc, settlePayout, withdrawable, type Payout } from '../services/wallet';
import { waiting } from './owner-home';
import { buttons, list, notifyOwner } from './common';
import { matchAction, type ActionCtx, type Out } from './actions';
import { parseAdminCommand } from './intent';

// The banks most shops use first; any other is typed.
export const BANKS = ['Access Bank', 'GTBank', 'Zenith Bank', 'First Bank', 'UBA', 'OPay', 'Moniepoint', 'Kuda', 'PalmPay', 'Wema Bank', 'Fidelity Bank', 'FCMB', 'Stanbic IBTC', 'Sterling Bank', 'Union Bank', 'Polaris Bank', 'Ecobank', 'Providus Bank', 'Keystone Bank', 'Jaiz Bank', 'Globus Bank', 'Titan Trust Bank', 'Unity Bank', 'Heritage Bank', 'Carbon', 'FairMoney', 'VFD Microfinance Bank', 'Paga'];
const findBank = (t: string) => {
  const q = t.trim().toLowerCase().replace(/\s+(bank|plc|ltd)$/g, '').replace(/^gt\s*bank|^guaranty trust.*$/, 'gtbank');
  return BANKS.find(b => b.toLowerCase() === t.trim().toLowerCase() || b.toLowerCase().replace(/\s+(bank|ibtc|microfinance bank)$/, '') === q) ?? null;
};

interface KycDraft { legalName?: string; bvnEnc?: string; bankName?: string; accountEnc?: string }
async function draft(c: ActionCtx) { return (((await c.db.get(c.db.doc(C.conversations, c.admin.conversationId)))?.kycDraft) ?? {}) as KycDraft; }
async function setDraft(c: ActionCtx, d: KycDraft | null) { await c.db.set(c.db.doc(C.conversations, c.admin.conversationId), { kycDraft: d }, { merge: true }); }

export async function walletView(c: ActionCtx): Promise<Out> {
  const [w, kyc] = await Promise.all([getWallet(c.db, c.business.id), getKyc(c.db, c.business.id)]);
  const head = [`💰 *Your Relay wallet* (${c.business.name})`, `Available: *${formatKobo(w.availableKobo)}*`, `Paid in so far: ${formatKobo(w.lifetimeInKobo)} · Withdrawn: ${formatKobo(w.lifetimeOutKobo)}`];
  if (kyc?.status === 'verified') {
    const max = withdrawable(w, c.business);
    return buttons([...head, `You can withdraw up to ${formatKobo(max)} today, with no fee.`, `Payouts go to ${bankLine(kyc)}.`].join('\n'), [['act:withdraw', 'Withdraw'], ['act:payouts', 'Payout history'], ['act:menu', 'Menu']]);
  }
  if (kyc?.status === 'pending_review') return buttons([...head, '', "We're checking your bank details. I'll message you as soon as you can withdraw."].join('\n'), [['act:menu', 'Menu']]);
  return buttons([...head, '', `To withdraw, verify your account once: your bank details and BVN. It takes about 2 minutes.${kyc?.status === 'rejected' ? `\n\nYour last details couldn't be confirmed${kyc.reason ? `: ${kyc.reason}` : ''}. Please try again.` : ''}`].join('\n'), [['act:verify', 'Verify now'], ['act:menu', 'Menu']]);
}

export async function startVerify(c: ActionCtx): Promise<Out> {
  const kyc = await getKyc(c.db, c.business.id);
  if (kyc?.status === 'verified') return buttons(`You're verified ✅ Payouts go to ${bankLine(kyc)}. To change the account, reply *CALL* and we'll help.`, [['act:wallet', 'My wallet'], ['act:menu', 'Menu']]);
  if (kyc?.status === 'pending_review') return "We're still checking your details. I'll message you as soon as it's done.";
  await setDraft(c, {});
  await c.setAwaiting('kyc:name');
  return waiting("Let's verify your account so you can withdraw 🔐 It's once only, and your details are encrypted.\n\n*1 of 4* · What's the full name on your bank account? (Exactly as the bank has it.)");
}

const BANK_ROWS = () => list('*3 of 4* · Which bank should payouts go to?', 'Pick bank', [...BANKS.slice(0, 9).map(b => ({ id: `bank:${b}`, title: b })), { id: 'bank:other', title: 'Another bank' }], 'Banks');

// Typed answers during verify / withdraw, and the taps that go with them. Null: not for this flow.
export async function handleWalletInput(c: ActionCtx, choiceId: string | null, text: string): Promise<Out | null> {
  const awaiting = (await c.db.get(c.db.doc(C.conversations, c.admin.conversationId)))?.awaiting as string | null | undefined;
  const t = text.trim();

  if (choiceId?.startsWith('bank:')) {
    if (choiceId === 'bank:other') { await c.setAwaiting('kyc:bank'); return 'Type the name of your bank, e.g. *Fidelity Bank*.'; }
    return bankChosen(c, choiceId.slice(5));
  }
  if (choiceId === 'kyc:ok') return finishVerify(c);
  if (choiceId === 'kyc:fix') return startVerify(c);
  if (choiceId?.startsWith('wd:')) return withdrawTap(c, choiceId);
  if (choiceId || !awaiting || !(awaiting.startsWith('kyc:') || awaiting === 'withdraw')) return null;
  // A command instead of an answer ("RLY-ABCDE ready", "menu"): drop the question and do that.
  if (matchAction(t) || parseAdminCommand(t)) { await c.setAwaiting(null); return null; }

  if (awaiting === 'kyc:name') {
    const name = t.replace(/\s+/g, ' ');
    if (!/^[\p{L}][\p{L}'.\- ]{3,79}$/u.test(name) || name.split(' ').length < 2) return 'Please send your first and last name, as they appear on your bank account.';
    await setDraft(c, { ...(await draft(c)), legalName: name });
    await c.setAwaiting('kyc:bvn');
    return '*2 of 4* · Your BVN (Bank Verification Number): 11 digits. Dial *565*0# on the phone number linked to your bank to see it.';
  }
  if (awaiting === 'kyc:bvn') {
    const bvn = t.replace(/\D/g, '');
    if (bvn.length !== 11) return 'A BVN is 11 digits. Please send it again (dial *565*0# to see yours).';
    await setDraft(c, { ...(await draft(c)), bvnEnc: encrypt(bvn, c.cfg) });
    await c.setAwaiting(null);
    return BANK_ROWS();
  }
  if (awaiting === 'kyc:bank') {
    const bank = findBank(t) ?? (t.length >= 3 && t.length <= 60 ? t.replace(/\s+/g, ' ') : null);
    if (!bank) return 'Please type the name of your bank.';
    return bankChosen(c, bank);
  }
  if (awaiting === 'kyc:account') {
    const account = t.replace(/\D/g, '');
    if (account.length !== 10) return 'An account number (NUBAN) is 10 digits. Please send it again.';
    const d = { ...(await draft(c)), accountEnc: encrypt(account, c.cfg) };
    await setDraft(c, d);
    await c.setAwaiting(null);
    return buttons(`Please check:\n• Name: *${d.legalName}*\n• Bank: *${d.bankName}*\n• Account: *${account}*\n• BVN: ending ${decrypt(d.bvnEnc!, c.cfg).slice(-4)}\n\nYour withdrawals will only ever go to this account. The name on it must be ${d.legalName}.`, [['kyc:ok', "Yes, that's right"], ['kyc:fix', 'Start again']]);
  }
  if (awaiting === 'withdraw') {
    const kobo = nairaToKobo(t.replace(/^(₦|n)\s*/i, ''));
    if (!kobo) return 'Send the amount in naira, e.g. *20000* or *20k*.';
    await c.setAwaiting(null);
    return confirmWithdraw(c, kobo);
  }
  return null;
}

async function bankChosen(c: ActionCtx, bank: string): Promise<Out> {
  const d = await draft(c);
  if (!d.legalName || !d.bvnEnc) return startVerify(c);
  await setDraft(c, { ...d, bankName: bank.slice(0, 60) });
  await c.setAwaiting('kyc:account');
  return `*4 of 4* · Your ${bank} account number (10 digits).`;
}

async function finishVerify(c: ActionCtx): Promise<Out> {
  const d = await draft(c);
  if (!d.legalName || !d.bvnEnc || !d.bankName || !d.accountEnc) return startVerify(c);
  const kyc = await saveKyc(c.db, c.cfg, c.business.id, { legalName: d.legalName, bvn: decrypt(d.bvnEnc, c.cfg), bankName: d.bankName, account: decrypt(d.accountEnc, c.cfg), accountName: d.legalName.toUpperCase() });
  await setDraft(c, null);
  log('info', 'kyc_submitted', { businessId: c.business.id, status: kyc.status });
  if (kyc.status === 'verified') return buttons(`You're verified ✅ Withdrawals go to ${bankLine(kyc)}.`, [['act:withdraw', 'Withdraw now'], ['act:wallet', 'My wallet'], ['act:menu', 'Menu']]);
  await notifyOwner(c.db, c.deps, { id: c.business.id, ownerPhone: c.cfg.SUPPORT_PHONE }, 'kyc_review', `🔐 KYC to check: ${c.business.name} (${c.business.id}). ${bankLine(kyc)}, BVN ending ${kyc.bvnLast4}. Approve or reject: POST /api/v1/internal/kyc/${c.business.id}`, kyc.submittedAt);
  return buttons("Thanks! We're checking your details now. I'll message you as soon as you can withdraw. Your money stays safe in your wallet meanwhile.", [['act:wallet', 'My wallet'], ['act:menu', 'Menu']]);
}

export async function startWithdraw(c: ActionCtx): Promise<Out> {
  const [w, kyc] = await Promise.all([getWallet(c.db, c.business.id), getKyc(c.db, c.business.id)]);
  if (kyc?.status !== 'verified') return walletView(c);
  const max = withdrawable(w, c.business);
  if (w.availableKobo < MIN_PAYOUT_KOBO) return buttons(`You have ${formatKobo(w.availableKobo)} in your wallet. The smallest withdrawal is ${formatKobo(MIN_PAYOUT_KOBO)}.`, [['act:sales', 'Sales report'], ['act:menu', 'Menu']]);
  if (max < MIN_PAYOUT_KOBO) return buttons(`You've reached today's withdrawal limit. You can withdraw again tomorrow; ${formatKobo(w.availableKobo)} is waiting in your wallet.`, [['act:wallet', 'My wallet'], ['act:menu', 'Menu']]);
  if (c.arg) { const kobo = nairaToKobo(c.arg.replace(/^(₦|n)\s*/i, '')); if (kobo) return confirmWithdraw(c, kobo); }
  return buttons(`How much do you want to withdraw to ${bankLine(kyc)}?\nAvailable today: ${formatKobo(max)}. No fee.`, [[`wd:amt:${max}`, `All ${formatKobo(max)}`], ['wd:other', 'Another amount'], ['act:menu', 'Menu']]);
}

// Each confirmation works once (a second tap can't send it twice).
async function confirmWithdraw(c: ActionCtx, kobo: number): Promise<Out> {
  const [w, kyc] = await Promise.all([getWallet(c.db, c.business.id), getKyc(c.db, c.business.id)]);
  if (!kyc || kyc.status !== 'verified') return walletView(c);
  const max = withdrawable(w, c.business);
  if (kobo < MIN_PAYOUT_KOBO) return `The smallest withdrawal is ${formatKobo(MIN_PAYOUT_KOBO)}. Send another amount.`;
  if (kobo > max) return buttons(`You can withdraw up to ${formatKobo(max)} today.`, [[`wd:amt:${max}`, `All ${formatKobo(max)}`], ['wd:other', 'Another amount'], ['act:menu', 'Menu']]);
  const nonce = randomId(6).replace(/[^A-Za-z0-9]/g, 'x');
  await c.db.set(c.db.doc(C.conversations, c.admin.conversationId), { withdrawConfirm: { nonce, amountKobo: kobo, at: new Date().toISOString() } }, { merge: true });
  return buttons(`Send *${formatKobo(kobo)}* to ${bankLine(kyc)}? No fee.`, [[`wd:go:${nonce}`, 'Yes, send it'], ['act:wallet', 'Cancel']]);
}

async function withdrawTap(c: ActionCtx, choiceId: string): Promise<Out> {
  const [, kind, v] = choiceId.split(':');
  if (kind === 'other') { await c.setAwaiting('withdraw'); return 'How much? Send the amount in naira, e.g. *20000* or *20k*.'; }
  if (kind === 'amt') return confirmWithdraw(c, Number(v));
  if (kind !== 'go') return walletView(c);
  const ref = c.db.doc(C.conversations, c.admin.conversationId);
  const pending = (await c.db.get(ref))?.withdrawConfirm as { nonce: string; amountKobo: number; at: string } | null | undefined;
  if (!pending || pending.nonce !== v || Date.now() - new Date(pending.at).getTime() > 15 * 60_000) return buttons('That request has expired. Start again from your wallet.', [['act:withdraw', 'Withdraw'], ['act:menu', 'Menu']]);
  await c.db.set(ref, { withdrawConfirm: null }, { merge: true });
  const r = await requestPayout(c.db, c.business, pending.amountKobo);
  if (!r.ok) {
    const why = r.reason === 'not_verified' ? 'Your account needs verifying first.' : r.reason === 'below_minimum' ? `The smallest withdrawal is ${formatKobo(MIN_PAYOUT_KOBO)}.` : `You can withdraw up to ${formatKobo(r.maxKobo ?? 0)} right now.`;
    return buttons(why, [['act:wallet', 'My wallet'], ['act:menu', 'Menu']]);
  }
  log('info', 'payout_requested', { businessId: c.business.id, payoutId: r.payout.id, amountKobo: r.payout.amountKobo });
  return sendPayout(c, r.payout);
}

// Moving the money. TODO(jesse): the Bachs payouts API. Test mode: paid at once (pretend money).
// Otherwise a person at Relay pays it and marks it (routes/internal.ts): nothing moves on its own.
async function sendPayout(c: ActionCtx, p: Payout): Promise<Out> {
  if (c.cfg.PAYMENTS_MODE === 'simulated') {
    await settlePayout(c.db, c.business.id, p.id, { status: 'paid', reference: `SIM-${p.id}` });
    return buttons(`✅ Sent ${formatKobo(p.amountKobo)} to ${p.bank.name} ••${p.bank.last4}. (Test mode: no real money moved.)`, [['act:wallet', 'My wallet'], ['act:menu', 'Menu']]);
  }
  await notifyOwner(c.db, c.deps, { id: c.business.id, ownerPhone: c.cfg.SUPPORT_PHONE }, 'payout_request', `💸 Payout ${p.id}: ${formatKobo(p.amountKobo)} for ${c.business.name} to ${p.bank.name} ••${p.bank.last4} (${p.bank.accountName}). Details: GET /api/v1/internal/payouts/${p.id}. Mark paid or failed: POST /api/v1/internal/payouts/${p.id}`, p.id);
  return buttons(`💸 Withdrawal ${p.id} of ${formatKobo(p.amountKobo)} is on its way to ${p.bank.name} ••${p.bank.last4}. I'll message you when it lands.`, [['act:payouts', 'Payout history'], ['act:menu', 'Menu']]);
}

export async function payoutHistory(c: ActionCtx): Promise<Out> {
  const ps = await recentPayouts(c.db, c.business.id, 10);
  return ps.length ? `Your last withdrawals:\n${ps.map(payoutLine).join('\n')}` : 'No withdrawals yet.';
}
