// WhatsApp Flows: one form instead of several chat messages for Add product, Hours and Delivery.
// Off unless FLOWS_ENABLED=true and the Flow is published in Meta (its id in FLOW_ID_*); the chat
// version is always there as the fallback (and the only version in the local test chat).
// The Flow JSON to publish is in docs/flows/. These Flows have no data endpoint: what the form needs
// (the shop's categories) is sent with the message, and the answers come back as an nfm_reply.
//   flow_token = <kind>:<businessId>:<random>  so an answer can only change the shop it was sent for.
import type { Config } from '../config';
import type { OutboundContent } from './channel';
import { randomId } from '../lib/crypto';

export type FlowKind = 'add' | 'hours' | 'delivery';

const ID_KEY: Record<FlowKind, keyof Config> = { add: 'FLOW_ID_ADD_PRODUCT', hours: 'FLOW_ID_HOURS', delivery: 'FLOW_ID_DELIVERY' };
const SCREEN: Record<FlowKind, string> = { add: 'PRODUCT', hours: 'HOURS', delivery: 'ZONES' };
const CTA: Record<FlowKind, string> = { add: 'Add product', hours: 'Set hours', delivery: 'Set delivery' };

// The published Flow's id, or null when Flows are off or can't be shown (the local test chat).
export function flowId(cfg: Config, kind: FlowKind): string | null {
  if (cfg.FLOWS_ENABLED !== 'true' || cfg.META_SEND_MODE === 'log') return null;
  const id = cfg[ID_KEY[kind]];
  return typeof id === 'string' && id ? id : null;
}

export function flowMessage(kind: FlowKind, id: string, businessId: string, body: string, data: Record<string, unknown> = {}): OutboundContent {
  return {
    type: 'interactive',
    interactive: {
      type: 'flow',
      body: { text: body },
      action: {
        name: 'flow',
        parameters: { flow_message_version: '3', flow_id: id, flow_token: `${kind}:${businessId}:${randomId(10).replace(/[^A-Za-z0-9]/g, 'x')}`, flow_cta: CTA[kind], flow_action: 'navigate', flow_action_payload: { screen: SCREEN[kind], data } },
      },
    },
  };
}

// A submitted form: which one, for which shop, and the answers. Null if it isn't one of ours.
export function readFlowReply(raw: unknown): { kind: FlowKind; businessId: string; answers: Record<string, unknown> } | null {
  if (!raw || typeof raw !== 'object') return null;
  let answers: Record<string, unknown>;
  try { answers = JSON.parse(String((raw as { response_json?: string }).response_json ?? '')) as Record<string, unknown>; } catch { return null; }
  const [kind, businessId] = String(answers.flow_token ?? '').split(':');
  if (!['add', 'hours', 'delivery'].includes(kind) || !businessId) return null;
  return { kind: kind as FlowKind, businessId, answers };
}
