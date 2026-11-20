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

export interface Scene { time: string; tag: string; title: string; body: string; short: string; who: string; script: ChatScript; sky: string }

export const DAY: Scene[] = [
  {
    time: '02:13', tag: 'Orders while you sleep', sky: '#0B1020', who: "A customer of Tee's Closet",
    title: 'She found your top at 2am. Relay sold it to her.',
    body: 'Relay showed the photo and sizes, priced delivery to her area, sent a pay link and a receipt. You were asleep for all of it.',
    short: 'Photo, size, delivery price, pay link and receipt. You were asleep.',
    script: { device: 'android', ...closet, clock: '02:13', notice: true, messages: [
      { side: 'out', kind: 'text', time: '02:13', wait: 200, text: 'Good evening. Do you have this ankara top in size 12?' },
      { side: 'in', kind: 'product', time: '02:13', photo: PHOTOS.ankaraTop, title: 'Ankara Off-shoulder Top', price: '₦18,500 · sizes 8–16', text: 'Yes, size 12 is available 👌 Add it to your cart?', buttons: ['Add size 12', 'See more tops'] },
      { side: 'out', kind: 'text', time: '02:14', text: 'Add size 12' },
      { side: 'in', kind: 'buttons', time: '02:14', text: 'Added ✅ Delivery to Ikeja is ₦2,500.\nTotal: *₦21,000*', buttons: ['Checkout', 'Edit cart'] },
      { side: 'out', kind: 'text', time: '02:14', text: 'Checkout' },
      { side: 'in', kind: 'cta', time: '02:14', text: 'Order *RLY-7PL2M* · ₦21,000\nPay with this link. Your size is held for 30 minutes.', button: 'Pay ₦21,000' },
      { side: 'in', kind: 'doc', time: '02:16', wait: 2400, name: 'Receipt RLY-7PL2M.pdf', meta: '1 page · PDF', text: '✅ Payment received. Thank you! Delivery is tomorrow.' },
    ] },
  },
  {
    time: '07:00', tag: 'Wake up to a plan', sky: '#3B2A4A', who: "The owner of Ada's Kitchen",
    title: 'One message tells you what the day needs.',
    body: 'What to deliver, who still owes and what is running low. Fix any of it by replying in your own words.',
    short: 'Deliveries, unpaid orders and low stock. Reply to fix any of it.',
    script: { device: 'iphone', ...relay, clock: '07:00', messages: [
      { side: 'in', kind: 'buttons', time: '07:00', wait: 200, text: "☀️ Good morning Ada! *Ada's Kitchen* today:\n🚚 To deliver (4): RLY-4K2Q9, RLY-9QX4T and 2 more\n💸 Waiting for payment (1): ₦12,500\n📦 Running low: Egusi (3 plates)", buttons: ['Orders', 'Sold out / restock', 'Menu'] },
      { side: 'out', kind: 'text', time: '07:03', text: 'egusi restock 20' },
      { side: 'in', kind: 'buttons', time: '07:03', text: '*Egusi + Assorted* now has 20 in stock ✅', buttons: ['Undo', 'Menu'] },
    ] },
  },
  {
    time: '09:42', tag: 'Fake alerts blocked', sky: '#E8A15C', who: "A customer of Ada's Kitchen",
    title: 'A screenshot doesn’t mark an order paid.',
    body: 'Relay marks an order paid only when the exact amount on the order arrives. A fake alert or an edited screenshot changes nothing, and the food stays in your kitchen.',
    short: 'Only the exact amount arriving marks it paid. The food stays in your kitchen.',
    script: { device: 'android', ...kitchen, clock: '09:42', messages: [
      { side: 'in', kind: 'text', time: '09:31', wait: 200, text: 'Order *RLY-9QX4T* · ₦12,500\nTransfer exactly *₦12,500.37* to the account below. Payment is confirmed automatically.' },
      { side: 'out', kind: 'shot', time: '09:42', amount: '₦12,500.00', to: "ADA'S KITCHEN", caption: 'I have paid, abeg send it now' },
      { side: 'in', kind: 'text', time: '09:42', text: 'Thank you! The money hasn’t arrived yet. I’ll confirm it as soon as it does and send your receipt 🙏\n\nYour order is held until 10:01.' },
    ] },
  },
  {
    time: '13:05', tag: 'Order tracking', sky: '#F5D9A8', who: "A customer of Tee's Closet",
    title: '"Where is my order?" answered before you see it.',
    body: 'Customers ask any time and get the real status: paid, ready, out for delivery or delivered. You update it with one tap and they hear about it straight away.',
    short: 'Customers get the real status any time. You update it with one tap.',
    script: { device: 'android', ...closet, clock: '13:05', messages: [
      { side: 'out', kind: 'text', time: '13:05', wait: 200, text: 'Please where is my order?' },
      { side: 'in', kind: 'track', time: '13:05', text: '*RLY-7PL2M* · Ankara Off-shoulder Top (12)\nIt has left the shop and is on its way 🛵', steps: ['Paid', 'Ready', 'Out for delivery', 'Delivered'], at: 2, buttons: ['Talk to the owner'] },
      { side: 'out', kind: 'text', time: '13:06', text: 'Thank you 🙏🏾' },
    ] },
  },
  {
    time: '16:30', tag: 'Abandoned carts', sky: '#F2B880', who: "A customer of Tee's Closet",
    title: 'Carts left behind get one reminder.',
    body: 'Kunle added sneakers and never paid. Smart Reach reminds him once, with the photo and his size, and stops if he says no.',
    short: 'Smart Reach sends one reminder with the photo and size.',
    script: { device: 'android', ...closet, clock: '16:30', messages: [
      { side: 'in', kind: 'product', time: '16:30', wait: 200, photo: PHOTOS.sneakers, title: 'White Low-top Sneakers', price: '₦24,000 · size 42', text: 'Hi Kunle 👋 Your sneakers (size 42) are still in your cart. Only 2 pairs left in your size.', buttons: ['Checkout', 'Not now'] },
      { side: 'out', kind: 'text', time: '16:41', text: 'Checkout' },
      { side: 'in', kind: 'cta', time: '16:41', text: 'Order *RLY-3TQ8N* · ₦26,500 with delivery to Yaba.', button: 'Pay ₦26,500' },
    ] },
  },
  {
    time: '18:00', tag: 'Regulars come back', sky: '#C2410C', who: "A customer of Ada's Kitchen",
    title: 'Regulars hear from you when they usually reorder.',
    body: 'Smart Reach knows who orders what and how often. It sends each customer at most one promo a week, never at night.',
    short: 'Smart Reach offers their usual order, at most once a week.',
    script: { device: 'android', ...kitchen, clock: '18:00', messages: [
      { side: 'in', kind: 'product', time: '18:00', wait: 200, photo: PHOTOS.egusi, title: 'Egusi + Assorted', price: '₦6,500', text: 'Hi Tolu, it’s been a while! Your usual egusi with assorted is ready this evening. Should I save you a plate?', buttons: ['Yes, save one', 'Stop updates'] },
      { side: 'out', kind: 'text', time: '18:04', text: 'Yes, save one' },
      { side: 'in', kind: 'buttons', time: '18:04', text: 'Done ✅ 1 × Egusi + Assorted. Same address in Surulere (₦1,500)?', buttons: ['Yes, checkout', 'New address'] },
    ] },
  },
  {
    time: '20:00', tag: 'Close the day', sky: '#111827', who: "The owner of Ada's Kitchen",
    title: 'See the day’s sales and withdraw in the same chat.',
    body: 'Paid orders, deliveries left and who still owes. Send the money to your bank from the chat, free.',
    short: 'Sales, deliveries and unpaid orders. Withdraw to your bank, free.',
    script: { device: 'iphone', ...relay, clock: '20:00', messages: [
      { side: 'in', kind: 'buttons', time: '20:00', wait: 200, text: "📊 *Ada's Kitchen*, Fri 20 Nov\n✅ 14 paid orders\n💰 *₦96,500 to you*\n🚚 2 still to deliver\n💸 1 waiting for payment", buttons: ['Withdraw', 'Orders', 'Menu'] },
      { side: 'out', kind: 'text', time: '20:02', text: 'withdraw 80k' },
      { side: 'in', kind: 'buttons', time: '20:02', text: 'Send *₦80,000* to GTBank ••••4521 (Ada O.)?', buttons: ['Confirm', 'Cancel'] },
      { side: 'out', kind: 'text', time: '20:02', text: 'Confirm' },
      { side: 'in', kind: 'text', time: '20:02', text: 'Sent ✅ ₦80,000 is on its way to your bank.' },
    ] },
  },
];
