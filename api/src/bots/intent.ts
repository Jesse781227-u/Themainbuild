// Turns an owner's message into a tool call. Plain commands are matched by rules first (fast, free,
// predictable, and works without an LLM key); anything else goes to the LLM, which can only pick
// one of the Admin Bot's tools. Both paths produce the same {tool, args} shape and go through the
// same zod validation in admin-tools.
import type { LLMProvider, ToolChoice } from '../services/ai';
import { adminToolSpecs } from './admin-tools';

const NUM = /^(?:₦|n|ngn)?\s*\d[\d,]*(?:\.\d{1,2})?(?:k)?$/i;
const toNaira = (s: string) => {
  const t = s.trim().replace(/^(₦|ngn|n)\s*/i, '');
  return /k$/i.test(t) ? String(Number(t.slice(0, -1).replace(/,/g, '')) * 1000) : t;
};

// "Jollof rice, 2500, 10" · "Jollof rice 2,500 10 in stock" · "Jollof rice ₦2.5k x10"
export function parseProductLine(text: string): { name: string; price: string; stock?: number } | null {
  const tokens = text
    .replace(/\b(in stock|pcs|pieces|units|left|available)\b/gi, ' ')
    .replace(/\bx\s*(\d+)/gi, ' $1')
    .replace(/,(?!\d{3}\b)/g, ' ') // separator commas, not thousands commas
    .split(/\s+/).filter(Boolean);
  const n = tokens.length;
  if (n >= 3 && /^\d+$/.test(tokens[n - 1]) && NUM.test(tokens[n - 2])) return { name: tokens.slice(0, -2).join(' '), price: toNaira(tokens[n - 2]), stock: Number(tokens[n - 1]) };
  if (n >= 2 && NUM.test(tokens[n - 1])) return { name: tokens.slice(0, -1).join(' '), price: toNaira(tokens[n - 1]) };
  return null;
}

export function parseAdminCommand(input: string): ToolChoice | null {
  const text = input.trim().replace(/[.!]+$/, '');
  const t = text.toLowerCase();
  let m: RegExpExecArray | null;

  if (/^(help|menu|commands|what can you do|\?)$/.test(t)) return { tool: 'help', args: {} };
  if (/^(hi+|hello+|hey+|hiya|helo|good (morning|afternoon|evening|day)|howdy|yo|sup|what'?s up|how far|hi there|hello there)(\s+relay)?[\s!.]*$/.test(t)) return { tool: 'greet', args: {} };
  if (/^(products|product list|list products|stock|inventory|catalog(ue)?|my products)$/.test(t)) return { tool: 'listProducts', args: {} };
  if (/^(orders|recent orders|list orders)$/.test(t)) return { tool: 'listOrders', args: { filter: 'recent' } };
  if (/^(orders today|today'?s orders)$/.test(t)) return { tool: 'listOrders', args: { filter: 'today' } };
  if (/^(unpaid|unpaid orders|pending|pending orders|awaiting payment)$/.test(t)) return { tool: 'listOrders', args: { filter: 'unpaid' } };
  if (/^(paid orders)$/.test(t)) return { tool: 'listOrders', args: { filter: 'paid' } };
  if (/^(sales|sales today|today|report|how much (did i|have i) (sell|sold|make|made) today\??)$/.test(t)) return { tool: 'salesToday', args: {} };
  if (/^(connect|connect whatsapp|link whatsapp|connect my number)$/.test(t)) return { tool: 'connectWhatsApp', args: {} };
  if (/^delete my (data|account)$/.test(t)) return { tool: 'deleteMyData', args: {} };
  if ((m = /^(?:hand ?back|resume(?: bot)?|bot on)(?:\s+(?:to\s+)?(\+?[\d\s-]{7,}))?$/i.exec(text))) return { tool: 'handBack', args: m[1] ? { customer: m[1] } : {} };

  // Categories (before "add …" and "move …", which they would otherwise match).
  if (/^(messages|my messages|edit messages|customer messages|welcome message|receipt message|thank you message)$/.test(t)) return { tool: 'shopMessages', args: {} };
  { const m = /^(?:receipt|send receipt|receipt for) (rly-[a-z0-9]{5})$/.exec(t); if (m) return { tool: 'orderReceipt', args: { order: m[1].toUpperCase() } }; }
  if (/^suggestions? (on|off)$/.test(t)) return { tool: 'setSuggestions', args: { on: t.endsWith('on') } };
  { const m = /^pair (.{1,120}?) with (.{1,500})$/.exec(t); if (m) return { tool: 'pairProducts', args: { product: m[1], with: m[2] } }; }
  { const m = /^unpair (.{1,120})$/.exec(t); if (m) return { tool: 'unpairProduct', args: { product: m[1] } }; }
  if (/^(customers|my customers|customer list|list customers|all customers|show customers|top customers)$/.test(t)) return { tool: 'listCustomers', args: { sort: 'top' } };
  { const m = /^customers? (recent|new|latest|quiet|inactive|gone quiet)$/.exec(t); if (m) return { tool: 'listCustomers', args: { sort: /quiet|inactive/.test(m[1]) ? 'quiet' : 'recent' } }; }
  { const m = /^(?:customer|find customer|search customer|look up) (.{2,60})$/.exec(t); if (m) return { tool: 'findCustomer', args: { query: m[1] } }; }
  if (/^(categories|my categories|list categories|show categories)$/.test(t)) return { tool: 'listCategories', args: {} };
  if ((m = /^(?:add|new|create)\s+categor(?:y|ies)\s*:?\s+(.+)$/i.exec(text))) return { tool: 'addCategories', args: { names: m[1] } };
  if ((m = /^rename\s+(?:the\s+)?categor(?:y|ies)\s+(.+?)\s+(?:to|as)\s+(.+)$/i.exec(text))) return { tool: 'renameCategory', args: { category: m[1], name: m[2] } };
  if ((m = /^(?:delete|remove)\s+(?:the\s+)?categor(?:y|ies)\s+(.+)$/i.exec(text))) return { tool: 'deleteCategory', args: { category: m[1] } };
  if ((m = /^move\s+(.+?)\s+to\s+(?:the\s+)?(top|bottom|first|last|end|position\s+\d+|\d+)$/i.exec(text))) return { tool: 'reorderCategory', args: { category: m[1], position: m[2].replace(/^position\s+/i, '') } };
  if ((m = /^move\s+(.+?)\s+(?:to|into)\s+(.+)$/i.exec(text))) return { tool: 'moveProduct', args: { product: m[1], category: m[2] } };

  if ((m = /^add\s+(.+)$/i.exec(text)) && !/^add\s+stock\b/i.test(text)) {
    const p = parseProductLine(m[1]);
    return p ? { tool: 'addProduct', args: p } : { tool: 'addProduct', args: { name: m[1] } };
  }
  if ((m = /^(?:restock|add stock|stock up)\s+(.+?)\s+\+?(\d+)$/i.exec(text))) return { tool: 'restock', args: { product: m[1], quantity: Number(m[2]) } };
  if ((m = /^(?:sold|remove stock)\s+(\d+)\s+(.+)$/i.exec(text))) return { tool: 'adjustStock', args: { product: m[2], change: -Number(m[1]) } };
  if ((m = /^(?:set |change )?price(?: of)?\s+(.+?)\s+(?:to\s+)?((?:₦|n)?\s*[\d,]+(?:\.\d{1,2})?k?)$/i.exec(text))) return { tool: 'setPrice', args: { product: m[1], price: toNaira(m[2]) } };
  if ((m = /^(?:hide)\s+(.+)$/i.exec(text))) return { tool: 'setAvailability', args: { product: m[1], available: false } };
  // "show me my Sneakers" / "preview Sneakers" = what customers see; "show Black AF1" = unhide it.
  if ((m = /^(?:show me(?: my)?|preview(?: my)?|what do customers see (?:in|for))\s+(.+)$/i.exec(text))) return { tool: 'previewCategory', args: { category: m[1] } };
  if (/^(preview|show me my shop|what do customers see\??)$/i.test(text)) return { tool: 'previewCategory', args: {} };
  if ((m = /^(?:show|unhide)\s+(.+)$/i.exec(text))) return { tool: 'setAvailability', args: { product: m[1], available: true } };
  if ((m = /^(?:delete|remove)\s+(?:product\s+)?(.+)$/i.exec(text)) && !/^delete my/i.test(text)) return { tool: 'deleteProduct', args: { product: m[1] } };
  if ((m = /^(?:mark\s+)?(rly-[a-z0-9]{5})\s+(?:as\s+)?paid$/i.exec(text))) return { tool: 'markPaid', args: { order: m[1] } };
  if ((m = /^cancel\s+(?:order\s+)?(rly-[a-z0-9]{5})$/i.exec(text))) return { tool: 'cancelOrder', args: { order: m[1] } };
  // "RLY-7PL2M out for delivery" · "RLY-7PL2M don leave with Musa 0803 123 4567, 1 hour"
  if ((m = /^(rly-[a-z0-9]{5})\s+(?:is\s+)?(ready|out for delivery|shipped|dispatched|on the way|don leave|has left|left|delivered|picked up|collected)(?:\s*[,:-]?\s+(.+))?$/i.exec(text))) {
    const status = ({ ready: 'ready', 'out for delivery': 'out_for_delivery', shipped: 'out_for_delivery', dispatched: 'out_for_delivery', 'on the way': 'out_for_delivery', 'don leave': 'out_for_delivery', 'has left': 'out_for_delivery', left: 'out_for_delivery', delivered: 'delivered', 'picked up': 'picked_up', collected: 'picked_up' } as Record<string, string>)[m[2].toLowerCase()];
    if (m[3] && status !== 'out_for_delivery') return null;
    return { tool: 'updateFulfilment', args: { order: m[1], status, ...(m[3] ? { rider: m[3] } : {}) } };
  }
  if ((m = /^delivery zone\s+(.+?),\s*([^,]+?)(?:,\s*(.+))?$/i.exec(text))) return { tool: 'addDeliveryZone', args: { area: m[1], fee: toNaira(m[2]), ...(m[3] ? { timeframe: m[3] } : {}) } };
  if ((m = /^broadcast\s*:?\s+([\s\S]+)$/i.exec(input.trim()))) return { tool: 'broadcast', args: { message: m[1].trim() } };
  if ((m = /^(?:link|share link|shop link|my link)(?:\s*:?\s+(.+))?$/i.exec(text))) return { tool: 'shopLink', args: m[1] ? { message: m[1] } : {} };
  if ((m = /^payment details?\s*:?\s+(.+)$/i.exec(text))) return { tool: 'setPaymentDetails', args: { details: m[1] } };
  return null;
}

export const ADMIN_SYSTEM = [
  'You route messages from a small-business owner in Nigeria to the Relay Admin Bot, which manages their shop on WhatsApp.',
  'Choose exactly one tool. Prices are in naira. Use offTopic for anything not about running this shop (general knowledge, chit-chat, homework, coding, other businesses).',
  'Never invent product names or order numbers that are not in the message.',
].join(' ');

export async function chooseAdminTool(text: string, llm: LLMProvider | null): Promise<ToolChoice | null> {
  const rule = parseAdminCommand(text);
  if (rule) return rule;
  if (!llm) return null;
  return llm.chooseTool({ system: ADMIN_SYSTEM, message: text.slice(0, 1000), tools: adminToolSpecs() });
}
