// One day across two example Relay shops in Lagos: a fashion seller and a food seller. Every scene is
// something Relay does today: night orders, the 7am brief, payment only on real money, order
// tracking, abandoned-cart and win-back messages, the 8pm summary. Product photos: Unsplash
// (Unsplash License), hot-linked from images.unsplash.com.
import type { ChatScript } from '../components/Chat';

const u = (id: string, w = 640, h = 480) => `https://images.unsplash.com/${id}?w=${w}&h=${h}&fit=crop&auto=format&q=72`;
export const PHOTOS = {
  jollof: u('photo-1664993101841-036f189719b6'),
  jollofSkewers: u('photo-1664992960082-0ea299a9c53e'),
  egusi: u('photo-1763048443535-1243379234e2'),
  ankaraTop: u('photo-1664151099736-1ac6365a25aa', 640, 640),
  sneakers: u('photo-1541908328660-db3f2c9ee652', 640, 560),
};
// Warm the cache so photos are there when the message appears.
if (typeof window !== 'undefined') Object.values(PHOTOS).forEach(src => { const i = new Image(); i.src = src; });

const Av = ({ t, c }: { t: string; c: string }) => <span className="av-shop" style={{ background: c }}>{t}</span>;
const RelayAvatar = () => <img src="/logo.png" alt="" />;
const closet = { title: "Tee's Closet", subtitle: 'Business account', avatar: <Av t="TC" c="linear-gradient(135deg,#16A34A,#14532D)" /> };
const kitchen = { title: "Ada's Kitchen", subtitle: 'Business account', avatar: <Av t="AK" c="linear-gradient(135deg,#F59E0B,#B45309)" /> };
const relay = { title: 'Relay', subtitle: 'Your shop assistant', avatar: <RelayAvatar /> };

export interface Scene { time: string; tag: string; title: string; body: string; who: string; script: ChatScript; sky: string }

export const DAY: Scene[] = [
  {
    time: '02:13', tag: 'Orders while you sleep', sky: '#0B1020', who: "A customer of Tee's Closet",
    title: 'She found your top at 2am. Relay sold it to her.',
    body: 'Photos, sizes, delivery price for her area, a pay link and a receipt. You were asleep for all of it.',
    script: { device: 'android', ...closet, clock: '02:13', notice: true, messages: [
      { side: 'out', kind: 'text', time: '02:13', wait: 200, text: 'Good evening. You get this ankara top for size 12?' },
      { side: 'in', kind: 'product', time: '02:13', photo: PHOTOS.ankaraTop, title: 'Ankara Off-shoulder Top', price: '₦18,500 · sizes 8–16', text: 'Yes! Size 12 dey 👌 Make I add am to your cart?', buttons: ['Add size 12', 'See more tops'] },
      { side: 'out', kind: 'text', time: '02:14', text: 'Add size 12' },
      { side: 'in', kind: 'buttons', time: '02:14', text: 'Added ✅ Where we go deliver am?\nIkeja delivery na ₦2,500.\nTotal: *₦21,000*', buttons: ['Checkout', 'Edit cart'] },
      { side: 'out', kind: 'text', time: '02:14', text: 'Checkout' },
      { side: 'in', kind: 'cta', time: '02:14', text: 'Order *RLY-7PL2M* · ₦21,000\nPay with this link. I go hold your size for 30 minutes.', button: 'Pay ₦21,000' },
      { side: 'in', kind: 'doc', time: '02:16', wait: 2400, name: 'Receipt RLY-7PL2M.pdf', meta: '1 page · PDF', text: '✅ Payment received. Thank you! We go deliver tomorrow.' },
    ] },
  },
  {
    time: '07:00', tag: 'Wake up to a plan', sky: '#3B2A4A', who: "The owner of Ada's Kitchen",
    title: 'One message tells you what the day needs.',
    body: 'What to deliver, who still owes, what is running low. Fix any of it by replying in your own words.',
    script: { device: 'iphone', ...relay, clock: '07:00', messages: [
      { side: 'in', kind: 'buttons', time: '07:00', wait: 200, text: "☀️ Good morning Ada! *Ada's Kitchen* today:\n🚚 To deliver (4): RLY-4K2Q9, RLY-9QX4T and 2 more\n💸 Waiting for payment (1): ₦12,500\n📦 Running low: Egusi (3 plates)", buttons: ['Orders', 'Sold out / restock', 'Menu'] },
      { side: 'out', kind: 'text', time: '07:03', text: 'egusi restock 20' },
      { side: 'in', kind: 'buttons', time: '07:03', text: '*Egusi + Assorted* now has 20 in stock ✅', buttons: ['Undo', 'Menu'] },
    ] },
  },
  {
    time: '09:42', tag: 'No more fake alerts', sky: '#E8A15C', who: "A customer of Ada's Kitchen",
    title: 'A screenshot is not money. Relay knows the difference.',
    body: 'Orders are marked paid only when the money actually lands, matched to the exact amount on the order. A fake alert or an edited screenshot changes nothing, and your food stays in the kitchen.',
    script: { device: 'android', ...kitchen, clock: '09:42', messages: [
      { side: 'in', kind: 'text', time: '09:31', wait: 200, text: 'Order *RLY-9QX4T* · ₦12,500\nTransfer exactly *₦12,500.37* to the account below. Payment is confirmed automatically.' },
      { side: 'out', kind: 'shot', time: '09:42', amount: '₦12,500.00', to: "ADA'S KITCHEN", caption: 'I don pay, abeg send am now' },
      { side: 'in', kind: 'text', time: '09:42', text: 'Thank you! The money never land yet. Once e enter, I go confirm am by myself and send your receipt 🙏\n\nYour order dey hold till 10:01.' },
    ] },
  },
  {
    time: '13:05', tag: 'Order tracking', sky: '#F5D9A8', who: "A customer of Tee's Closet",
    title: '"Where my order?" answered before you see it.',
    body: 'Customers ask any time and get the real status: paid, ready, out for delivery, delivered. You update it with one tap, they hear about it straight away.',
    script: { device: 'android', ...closet, clock: '13:05', messages: [
      { side: 'out', kind: 'text', time: '13:05', wait: 200, text: 'Please where my order dey?' },
      { side: 'in', kind: 'track', time: '13:05', text: '*RLY-7PL2M* · Ankara Off-shoulder Top (12)\nIt don leave our shop, e dey come 🛵', steps: ['Paid', 'Ready', 'Out for delivery', 'Delivered'], at: 2, buttons: ['Talk to the owner'] },
      { side: 'out', kind: 'text', time: '13:06', text: 'Thank you 🙏🏾' },
    ] },
  },
  {
    time: '16:30', tag: 'Abandoned carts', sky: '#F2B880', who: "A customer of Tee's Closet",
    title: 'Carts left behind get a gentle nudge.',
    body: 'Someone added sneakers yesterday and never paid. Relay reminds them once, with the photo and their size, and stops if they say no.',
    script: { device: 'android', ...closet, clock: '16:30', messages: [
      { side: 'in', kind: 'product', time: '16:30', wait: 200, photo: PHOTOS.sneakers, title: 'White Low-top Sneakers', price: '₦24,000 · size 42', text: 'Hi Kunle 👋 Your sneakers (size 42) are still in your cart. Only 2 pairs left in your size.', buttons: ['Checkout', 'Not now'] },
      { side: 'out', kind: 'text', time: '16:41', text: 'Checkout' },
      { side: 'in', kind: 'cta', time: '16:41', text: 'Order *RLY-3TQ8N* · ₦26,500 with delivery to Yaba.', button: 'Pay ₦26,500' },
    ] },
  },
  {
    time: '18:00', tag: 'Old customers come back', sky: '#C2410C', who: "A customer of Ada's Kitchen",
    title: 'Regulars who went quiet hear from you again.',
    body: 'Relay knows who used to order and what they liked. It reaches only customers who agreed to updates, at most once a week, and never at night.',
    script: { device: 'android', ...kitchen, clock: '18:00', messages: [
      { side: 'in', kind: 'product', time: '18:00', wait: 200, photo: PHOTOS.egusi, title: 'Egusi + Assorted', price: '₦6,500', text: 'Hi Tolu, e don tey! Your usual egusi with assorted dey ready this evening. Make I save one plate for you?', buttons: ['Yes, save one', 'Stop updates'] },
      { side: 'out', kind: 'text', time: '18:04', text: 'Yes, save one' },
      { side: 'in', kind: 'buttons', time: '18:04', text: 'Done ✅ 1 × Egusi + Assorted. Same address in Surulere (₦1,500)?', buttons: ['Yes, checkout', 'New address'] },
    ] },
  },
  {
    time: '20:00', tag: 'Close the day', sky: '#111827', who: "The owner of Ada's Kitchen",
    title: 'Your day, counted. Your money, ready.',
    body: 'Sales, deliveries, who still owes. Withdraw to your bank from the same chat, free.',
    script: { device: 'iphone', ...relay, clock: '20:00', messages: [
      { side: 'in', kind: 'buttons', time: '20:00', wait: 200, text: "📊 *Ada's Kitchen*, Fri 20 Nov\n✅ 14 paid orders\n💰 *₦96,500 to you*\n🚚 2 still to deliver\n💸 1 waiting for payment", buttons: ['Withdraw', 'Orders', 'Menu'] },
      { side: 'out', kind: 'text', time: '20:02', text: 'withdraw 80k' },
      { side: 'in', kind: 'buttons', time: '20:02', text: 'Send *₦80,000* to GTBank ••••4521 (Ada O.)?', buttons: ['Confirm', 'Cancel'] },
      { side: 'out', kind: 'text', time: '20:02', text: 'Confirm' },
      { side: 'in', kind: 'text', time: '20:02', text: 'Sent ✅ ₦80,000 is on its way to your bank.' },
    ] },
  },
];
