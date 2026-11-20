// One day across two example Relay shops in Lagos: a fashion seller and a food seller. Every scene is
// something Relay does today: night orders, the 7am brief, payment only on real money, order
// tracking, abandoned-cart and win-back messages, the 8pm summary. Product photos: Unsplash
// (Unsplash License), hot-linked from images.unsplash.com.
import type { ChatScript } from '../components/Chat';

const u = (id: string, w = 640, h = 480) => `https://images.unsplash.com/${id}?w=${w}&h=${h}&fit=crop&auto=format&q=72`;
export const PHOTOS = {
  jollof: u('photo-1665332195309-9d75071138f0'),
  egusi: u('photo-1763048443535-1243379234e2'),
  ankaraTop: u('photo-1664151099736-1ac6365a25aa', 640, 640),
  slippers: u('photo-1585120824848-8a5cd41493d2', 640, 560),
  // Profile pictures of the two example sellers.
  tee: u('photo-1681597107753-58e48bb38c32', 160, 160).replace('fit=crop', 'fit=crop&crop=faces'),
  ada: u('photo-1602058746409-a4adc6d68270', 160, 160).replace('fit=crop', 'fit=crop&crop=faces'),
};
// Warm the cache so photos are there when the message appears.
if (typeof window !== 'undefined') Object.values(PHOTOS).forEach(src => { const i = new Image(); i.src = src; });

const RelayAvatar = () => <img src="/logo.png" alt="" />;
const closet = { title: "Tee's Closet", subtitle: 'Business account', avatar: <img src={PHOTOS.tee} alt="" /> };
const kitchen = { title: "Ada's Kitchen", subtitle: 'Business account', avatar: <img src={PHOTOS.ada} alt="" /> };
const relay = { title: 'Relay', subtitle: 'Your shop assistant', avatar: <RelayAvatar /> };

export interface Scene { time: string; tag: string; title: string; body: string; short: string; who: string; script: ChatScript; sky: string }

export const DAY: Scene[] = [
  {
    time: '02:13', tag: 'Orders while you sleep', sky: '#0B1020', who: "A customer of Tee's Closet",
    title: 'Your customer wanted the top at 2am. Relay sold it.',
    body: 'She got the photo, her size and a pay link in under a minute. You slept through it.',
    short: 'She got her size and a pay link in under a minute.',
    script: { device: 'android', ...closet, clock: '02:13', notice: true, messages: [
      { side: 'out', kind: 'text', time: '02:13', wait: 200, text: 'Good evening. Do you have this ankara top in size 12?' },
      { side: 'in', kind: 'product', time: '02:13', photo: PHOTOS.ankaraTop, title: 'Ankara Off Shoulder Top', price: '₦18,500 · sizes 8 to 16', text: 'Yes, size 12 is available 👌 Add it to your cart?', buttons: ['Add size 12', 'See more tops'] },
      { side: 'out', kind: 'text', time: '02:14', text: 'Add size 12' },
      { side: 'in', kind: 'buttons', time: '02:14', text: 'Added ✅ Delivery to Ikeja is ₦2,500.\nTotal: *₦21,000*', buttons: ['Checkout', 'Edit cart'] },
      { side: 'out', kind: 'text', time: '02:14', text: 'Checkout' },
      { side: 'in', kind: 'cta', time: '02:14', text: 'Order *RLY-7PL2M* · ₦21,000\nPay with this link. Your size is held for 30 minutes.', button: 'Pay ₦21,000' },
      { side: 'in', kind: 'doc', time: '02:16', wait: 2400, name: 'Receipt RLY-7PL2M.pdf', meta: '1 page · PDF', text: '✅ Payment received. Thank you! Delivery is tomorrow.' },
    ] },
  },
  {
    time: '07:00', tag: 'Your morning', sky: '#3B2A4A', who: "The owner of Ada's Kitchen",
    title: 'Wake up to your whole day in one message.',
    body: 'You see what to deliver and who still owes you. Reply in your own words to change anything.',
    short: 'Reply in your own words to change anything.',
    script: { device: 'iphone', ...relay, clock: '07:00', messages: [
      { side: 'in', kind: 'buttons', time: '07:00', wait: 200, text: "☀️ Good morning Ada! *Ada's Kitchen* today:\n🚚 To deliver (4): RLY-4K2Q9, RLY-9QX4T and 2 more\n💸 Waiting for payment (1): ₦12,500\n📦 Running low: Egusi (3 plates)", buttons: ['Orders', 'Sold out / restock', 'Menu'] },
      { side: 'out', kind: 'text', time: '07:03', text: 'egusi restock 20' },
      { side: 'in', kind: 'buttons', time: '07:03', text: '*Egusi + Assorted* now has 20 in stock ✅', buttons: ['Undo', 'Menu'] },
    ] },
  },
  {
    time: '09:42', tag: 'Fake alerts blocked', sky: '#E8A15C', who: "A customer of Ada's Kitchen",
    title: 'A fake alert can’t take your food.',
    body: 'Relay waits for the exact amount to reach your account. Until then, the order stays with you.',
    short: 'Relay waits for the money to reach your account.',
    script: { device: 'android', ...kitchen, clock: '09:42', messages: [
      { side: 'in', kind: 'text', time: '09:31', wait: 200, text: 'Order *RLY-9QX4T* · ₦12,500\nTransfer exactly *₦12,500.37* to the account below. Payment is confirmed automatically.' },
      { side: 'out', kind: 'shot', time: '09:42', amount: '₦12,500.00', to: "ADA'S KITCHEN", caption: 'I have paid, abeg send it now' },
      { side: 'in', kind: 'text', time: '09:42', text: 'Thank you! The money hasn’t arrived yet. I’ll confirm it as soon as it does and send your receipt 🙏\n\nYour order is held until 10:01.' },
    ] },
  },
  {
    time: '13:05', tag: 'Order tracking', sky: '#F5D9A8', who: "A customer of Tee's Closet",
    title: 'Your customer asks where the order is. Relay answers.',
    body: 'You tap one button when the rider leaves. Your customer sees it straight away.',
    short: 'You tap once. Your customer sees it straight away.',
    script: { device: 'android', ...closet, clock: '13:05', messages: [
      { side: 'out', kind: 'text', time: '13:05', wait: 200, text: 'Please where is my order?' },
      { side: 'in', kind: 'track', time: '13:05', text: '*RLY-7PL2M* · Ankara Off-shoulder Top (12)\nIt has left the shop and is on its way 🛵', steps: ['Paid', 'Ready', 'Out for delivery', 'Delivered'], at: 2, buttons: ['Talk to the owner'] },
      { side: 'out', kind: 'text', time: '13:06', text: 'Thank you 🙏🏾' },
    ] },
  },
  {
    time: '16:30', tag: 'Forgotten carts', sky: '#F2B880', who: "A customer of Tee's Closet",
    title: 'Your forgotten carts get one reminder.',
    body: 'Kunle left slippers in his cart. Smart Reach reminds him once, with the photo and his size.',
    short: 'One reminder, with the photo and his size.',
    script: { device: 'android', ...closet, clock: '16:30', messages: [
      { side: 'in', kind: 'product', time: '16:30', wait: 200, photo: PHOTOS.slippers, title: 'Leather Palm Slippers', price: '₦18,000 · size 42', text: 'Hi Kunle 👋 Your slippers (size 42) are still in your cart. Only 2 pairs left in your size.', buttons: ['Checkout', 'Not now'] },
      { side: 'out', kind: 'text', time: '16:41', text: 'Checkout' },
      { side: 'in', kind: 'cta', time: '16:41', text: 'Order *RLY-3TQ8N* · ₦20,500 with delivery to Yaba.', button: 'Pay ₦20,500' },
    ] },
  },
  {
    time: '18:00', tag: 'Your regulars', sky: '#C2410C', who: "A customer of Ada's Kitchen",
    title: 'Your regulars hear from you when they’re hungry.',
    body: 'Smart Reach knows when each customer usually orders, and offers their usual at the right time.',
    short: 'Smart Reach offers their usual at the right time.',
    script: { device: 'android', ...kitchen, clock: '18:00', messages: [
      { side: 'in', kind: 'product', time: '18:00', wait: 200, photo: PHOTOS.egusi, title: 'Egusi + Assorted', price: '₦6,500', text: 'Hi Tolu, it’s been a while! Your usual egusi with assorted is ready this evening. Should I save you a plate?', buttons: ['Yes, save one', 'Stop updates'] },
      { side: 'out', kind: 'text', time: '18:04', text: 'Yes, save one' },
      { side: 'in', kind: 'buttons', time: '18:04', text: 'Done ✅ 1 × Egusi + Assorted. Same address in Surulere (₦1,500)?', buttons: ['Yes, checkout', 'New address'] },
    ] },
  },
  {
    time: '20:00', tag: 'Your evening', sky: '#111827', who: "The owner of Ada's Kitchen",
    title: 'See what you made today, then withdraw it.',
    body: 'Your sales come in one message. Send the money to your bank for free.',
    short: 'Send your money to your bank for free.',
    script: { device: 'iphone', ...relay, clock: '20:00', messages: [
      { side: 'in', kind: 'buttons', time: '20:00', wait: 200, text: "📊 *Ada's Kitchen*, Fri 20 Nov\n✅ 14 paid orders\n💰 *₦96,500 to you*\n🚚 2 still to deliver\n💸 1 waiting for payment", buttons: ['Withdraw', 'Orders', 'Menu'] },
      { side: 'out', kind: 'text', time: '20:02', text: 'withdraw 80k' },
      { side: 'in', kind: 'buttons', time: '20:02', text: 'Send *₦80,000* to GTBank ••••4521 (Ada O.)?', buttons: ['Confirm', 'Cancel'] },
      { side: 'out', kind: 'text', time: '20:02', text: 'Confirm' },
      { side: 'in', kind: 'text', time: '20:02', text: 'Sent ✅ ₦80,000 is on its way to your bank.' },
    ] },
  },
];
