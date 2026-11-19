// WhatsApp interactive media carousel (a free-form session message, not a template): 2–10
// horizontally swipeable cards, each with an image, up to 160 characters of text and quick-reply
// buttons. Meta's limits are enforced here so callers can't build a message WhatsApp would reject:
//   • 2–10 cards           • main body ≤ 1,024 chars (required)   • card body ≤ 160 chars
//   • every card has the same number of buttons   • button title ≤ 20 chars, id ≤ 256 chars
// TODO(jesse): verify on a real number once the business is verified: the exact card JSON (Meta's
// example also sets card "type") and the webhook shape of a tapped card button (assumed to arrive
// like other quick replies, as interactive.button_reply).
import type { OutboundContent } from './channel';

// Button and row titles: one line, no stray spaces, cut at a word (WhatsApp allows 20 and 24 characters).
export function fitTitle(raw: string, max: number) {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max - 1);
  // Cut at the last whole word (unless the cut already falls between words).
  const cut = (/[\s,.;:–-]/.test(t[max - 1]) ? head : head.replace(/\s+\S*$/, '')).replace(/[\s,.;:–-]+$/, '');
  return `${cut.length >= max / 2 ? cut : t.slice(0, max - 1)}…`;
}

export const CAROUSEL = { minCards: 2, maxCards: 10, bodyMax: 1024, cardBodyMax: 160, titleMax: 20, idMax: 256 } as const;

export interface CarouselCard { imageUrl: string; body: string; buttons: [id: string, title: string][] }

// Cuts text to a limit on a word boundary where possible, with an ellipsis.
export function clip(text: string, max: number) {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function carousel(body: string, cards: CarouselCard[]): OutboundContent {
  if (cards.length < CAROUSEL.minCards || cards.length > CAROUSEL.maxCards) throw new Error(`CAROUSEL_CARDS: ${cards.length}`);
  const buttonCount = cards[0].buttons.length;
  if (!buttonCount || cards.some(c => c.buttons.length !== buttonCount)) throw new Error('CAROUSEL_BUTTONS_MISMATCH');
  if (!body.trim()) throw new Error('CAROUSEL_BODY_REQUIRED');
  return {
    type: 'interactive',
    interactive: {
      type: 'carousel',
      body: { text: clip(body, CAROUSEL.bodyMax) },
      action: {
        cards: cards.map((c, i) => ({
          card_index: i,
          header: { type: 'image', image: { link: c.imageUrl } },
          body: { text: clip(c.body, CAROUSEL.cardBodyMax) },
          action: { buttons: c.buttons.map(([id, title]) => ({ type: 'quick_reply', quick_reply: { id: id.slice(0, CAROUSEL.idMax), title: fitTitle(title, CAROUSEL.titleMax) } })) },
        })),
      },
    },
  };
}

export interface CarouselShape { body?: { text?: string }; action?: { cards?: { body?: { text?: string }; header?: { image?: { link?: string } }; action?: { buttons?: { quick_reply?: { id: string; title: string } }[] } }[] } }
