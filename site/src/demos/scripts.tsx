// The demo conversations. They follow what Relay actually does today (cart, delivery price by area,
// pay link, automatic confirmation, PDF receipt, Undo, morning brief, broadcasts). The shop is an
// example, labelled as one on the page.
import type { ChatScript } from '../components/Chat';

const ShopAvatar = () => <span className="av-shop">AK</span>;
const RelayAvatar = () => <img src="/logo.png" alt="" />;

export const customerSale: ChatScript = {
  device: 'android', title: "Ada's Kitchen", subtitle: 'Business account', avatar: <ShopAvatar />, clock: '23:47', notice: true,
  messages: [
    { side: 'out', kind: 'text', time: '23:47', text: 'Good evening, una still dey sell? How much be jollof', wait: 300 },
    { side: 'in', kind: 'product', time: '23:47', art: 'jollof', title: 'Jollof Rice + Chicken', price: '₦4,500', text: 'We dey o! 🍛 Na ₦4,500 with chicken. Make I add am?', buttons: ['Add to cart', 'See menu'] },
    { side: 'out', kind: 'text', time: '23:47', text: 'Add to cart' },
    { side: 'in', kind: 'text', time: '23:47', text: 'Added ✅\n1 × Jollof Rice + Chicken: ₦4,500\n\nWhere we go deliver am?' },
    { side: 'out', kind: 'text', time: '23:48', text: 'Gbagada phase 2' },
    { side: 'in', kind: 'buttons', time: '23:48', text: 'Delivery to *Gbagada* na ₦1,500.\nTotal: *₦6,000*', buttons: ['Checkout', 'Edit cart'] },
    { side: 'out', kind: 'text', time: '23:48', text: 'Checkout' },
    { side: 'in', kind: 'cta', time: '23:48', text: 'Order *RLY-4K2Q9* · ₦6,000\nPay with the link below. I go hold your food for 30 minutes.', button: 'Pay ₦6,000' },
    { side: 'in', kind: 'doc', time: '23:49', name: 'Receipt RLY-4K2Q9.pdf', meta: '1 page · PDF · 38 kB', text: '✅ Payment received! Thank you 🙏 We go deliver tomorrow morning.', wait: 2600 },
  ],
};

export const ownerOps: ChatScript = {
  device: 'iphone', title: 'Relay', subtitle: 'Your shop assistant', avatar: <RelayAvatar />, clock: '23:49',
  messages: [
    { side: 'in', kind: 'buttons', time: '23:49', text: '💰 *New paid order RLY-4K2Q9*\n1 × Jollof Rice + Chicken\nDeliver to Gbagada Phase 2\n*₦6,000 to you*', buttons: ['Mark delivered', 'Orders'], wait: 300 },
    { side: 'out', kind: 'text', time: '23:52', text: 'jollof don finish for today' },
    { side: 'in', kind: 'buttons', time: '23:52', text: 'Done: *Jollof Rice + Chicken* is sold out. Customers won\'t be offered it.', buttons: ['Undo', 'Menu'] },
    { side: 'out', kind: 'voice', time: '23:53', secs: 4 },
    { side: 'in', kind: 'text', time: '23:53', text: '📊 This week: *23 paid orders*, ₦142,500 to you.\nLast week: 17 orders, ₦98,000.\nBest seller: Jollof Rice + Chicken.' },
  ],
};

export const morningBrief: ChatScript = {
  device: 'iphone', title: 'Relay', subtitle: 'Your shop assistant', avatar: <RelayAvatar />, clock: '07:00',
  messages: [
    { side: 'in', kind: 'buttons', time: '07:00', wait: 200, text: '☀️ Good morning Ada! *Ada\'s Kitchen* today:\n🚚 To deliver (3): RLY-4K2Q9, RLY-7PL2M, RLY-9QX4T\n💸 Waiting for payment (1): ₦2,500 in all\n📦 Running low: Zobo (2)\n⛔ Sold out: Ofada Sauce', buttons: ['Orders', 'Sold out / restock', 'Menu'] },
    { side: 'out', kind: 'text', time: '07:04', text: 'zobo restock 30' },
    { side: 'in', kind: 'buttons', time: '07:04', text: '*Zobo (50cl)* now has 30 in stock ✅', buttons: ['Undo', 'Menu'] },
  ],
};

export const reach: ChatScript = {
  device: 'android', title: 'Relay', subtitle: 'Your shop assistant', avatar: <RelayAvatar />, clock: '10:15',
  messages: [
    { side: 'out', kind: 'text', time: '10:15', wait: 300, text: 'tell my regulars say small chops don land. 10% off till Friday' },
    { side: 'in', kind: 'buttons', time: '10:15', text: 'Ready to send to *Regulars* (48 people):\n\n"Small chops don land 🎉 10% off till Friday with code *CHOPS10*. Reply to order!"\n\n31 free (chat open) · 17 paid from your wallet', buttons: ['Send', 'Change', 'Cancel'] },
    { side: 'out', kind: 'text', time: '10:16', text: 'Send' },
    { side: 'in', kind: 'text', time: '10:16', text: 'Sent to 48 people ✅\nPeople who said stop are never messaged. I\'ll tell you who orders in the next 48 hours.' },
    { side: 'in', kind: 'text', time: '18:02', wait: 2200, text: '📈 Small chops update: 9 replies, *6 orders*, ₦19,800 so far.' },
  ],
};

export const onboarding: ChatScript = {
  device: 'android', title: 'Relay', subtitle: 'Your shop assistant', avatar: <RelayAvatar />, clock: '14:02',
  messages: [
    { side: 'out', kind: 'text', time: '14:02', text: 'Hi', wait: 300 },
    { side: 'in', kind: 'text', time: '14:02', text: 'Welcome to Relay 👋 I\'ll set up your shop in about 5 minutes.\n\nWhat\'s your shop called?' },
    { side: 'out', kind: 'text', time: '14:02', text: "Ada's Kitchen" },
    { side: 'in', kind: 'text', time: '14:02', text: 'Step 1 of 6 · Send your menu: type it, or send a photo, PDF or spreadsheet.' },
    { side: 'out', kind: 'image', time: '14:03', art: 'menu' },
    { side: 'in', kind: 'buttons', time: '14:03', text: 'I found *5 items* ✅\nJollof Rice + Chicken ₦4,500, Fried Rice + Turkey ₦5,500 and 3 more.', buttons: ['Looks good', 'Fix something'] },
    { side: 'out', kind: 'text', time: '14:03', text: 'Looks good' },
    { side: 'in', kind: 'text', time: '14:03', text: 'Step 2 of 6 · Where are you? e.g. Gbagada, Lagos' },
  ],
};
