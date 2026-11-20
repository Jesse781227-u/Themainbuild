import { AnimatePresence, motion, useMotionValueEvent, useScroll, useSpring, useTransform } from 'framer-motion';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { DEVICES, Phone } from './components/Phone';
import { Chat } from './components/Chat';
import { PaymentMatch, Receipt } from './components/Infographics';
import { DAY, PHOTOS } from './demos/scripts';
import { company } from './company';

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];

function useLagosTime() {
  const fmt = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit' }).format(new Date());
  const [t, setT] = useState(fmt);
  useEffect(() => { const id = window.setInterval(() => setT(fmt()), 20_000); return () => clearInterval(id); }, []);
  return t;
}

function useViewport() {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [v, setV] = useState(read);
  useEffect(() => { const on = () => setV(read()); window.addEventListener('resize', on); return () => window.removeEventListener('resize', on); }, []);
  return v;
}

const Logo = ({ size = 32 }: { size?: number }) => <img src="/logo.png" width={size} height={size} alt="" className="logo" />;

function Rise({ children, delay = 0, className, as = 'div' }: { children: ReactNode; delay?: number; className?: string; as?: 'div' | 'li' }) {
  const M = as === 'li' ? motion.li : motion.div;
  return <M className={className} initial={{ opacity: 0, y: 26 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }} transition={{ duration: 0.8, delay, ease }}>{children}</M>;
}

// ── Top strip: the shop is open, whatever the time in Lagos ──
function Strip() {
  const t = useLagosTime();
  return (
    <header className="strip">
      <div className="wrap strip-in">
        <a href="#top" className="brand"><Logo /><span>Relay</span></a>
        <div className="open"><i />Lagos {t} · your shop is open</div>
        <a className="btn btn-ink sm" href={company.ctaHref}>Start free</a>
      </div>
    </header>
  );
}

// ── Opening: a statement and the shop's own products, not a template hero ──
function Opening() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const drift = [useTransform(scrollYProgress, [0, 1], [0, -120]), useTransform(scrollYProgress, [0, 1], [0, -60]), useTransform(scrollYProgress, [0, 1], [0, -180]), useTransform(scrollYProgress, [0, 1], [0, -90])];
  const narrow = useViewport().w < 1000;
  const lines = [['No website.', ''], ['No app.', ''], ['No missed', 'orders.']];
  const cards = [
    { src: PHOTOS.ankaraTop, name: 'Ankara Off-shoulder Top', price: '₦18,500', note: 'Sold 02:13', cls: 'c1' },
    { src: PHOTOS.jollof, name: 'Jollof Rice + Chicken', price: '₦4,500', note: 'Paid ✓', cls: 'c2' },
    { src: PHOTOS.sneakers, name: 'White Low-top Sneakers', price: '₦24,000', note: 'Back from cart', cls: 'c3' },
    { src: PHOTOS.egusi, name: 'Egusi + Assorted', price: '₦6,500', note: 'Regular reorder', cls: 'c4' },
  ];
  return (
    <section className="opening" id="top" ref={ref}>
      <div className="wrap op-in">
        <h1>
          {lines.map(([a, b], i) => (
            <span className="ln" key={a}>
              <motion.span initial={{ y: '105%' }} animate={{ y: 0 }} transition={{ duration: 0.9, delay: 0.1 + i * 0.12, ease }}>
                {a}{b && <> <em>{b}</em></>}
              </motion.span>
            </span>
          ))}
        </h1>
        <motion.div className="op-side" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.6, duration: 0.8 }}>
          <p>Relay runs your shop inside WhatsApp. It takes orders day and night, confirms only real payments, tells customers where their order is, and with Smart Reach brings back the ones who went quiet.</p>
          <p className="op-small">For food and fashion sellers who don't want to spend a month's sales on a website they don't need.</p>
          <div className="op-cta">
            <a className="btn btn-lime" href={company.ctaHref}>Open my shop free</a>
            <a className="link" href="#day">Watch a day ↓</a>
          </div>
          <div className="op-fee"><b>1%</b> only when you sell. Nothing upfront, nothing monthly.</div>
        </motion.div>
        <div className="op-cards" aria-hidden>
          {cards.map((c, i) => (
            <motion.figure key={c.name} className={`pcard ${c.cls}`} style={{ y: narrow ? 0 : drift[i] }} initial={{ opacity: 0, scale: 0.9, rotate: 0 }} animate={{ opacity: 1, scale: 1 }} transition={{ duration: 0.9, delay: 0.4 + i * 0.12, ease }}>
              <img src={c.src} alt="" />
              <figcaption><b>{c.name}</b><span>{c.price}</span></figcaption>
              <i className="pnote">{c.note}</i>
            </motion.figure>
          ))}
        </div>
      </div>
    </section>
  );
}

// ── The day: one pinned phone, the clock and the sky move as you scroll ──
const isDark = (hex: string) => { const n = parseInt(hex.slice(1), 16); const r = n >> 16, g = (n >> 8) & 255, b = n & 255; return 0.299 * r + 0.587 * g + 0.114 * b < 150; };

function Day() {
  const ref = useRef<HTMLElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] });
  const [i, setI] = useState(0);
  useMotionValueEvent(scrollYProgress, 'change', v => setI(Math.min(DAY.length - 1, Math.max(0, Math.floor(v * DAY.length * 0.999)))));
  const stops = DAY.map((_, k) => k / (DAY.length - 1));
  const sky = useTransform(scrollYProgress, stops, DAY.map(s => s.sky));
  const sunX = useTransform(scrollYProgress, [0, 1], ['46%', '96%']);
  const sunY = useTransform(scrollYProgress, [0, 0.5, 1], ['30%', '9%', '30%']);
  const bar = useSpring(scrollYProgress, { stiffness: 140, damping: 30 });
  const s = DAY[i];
  const dark = isDark(s.sky);
  const { w, h } = useViewport();
  const mobile = w < 900;
  const d = DEVICES[s.script.device];
  const ratio = (d.w + d.bezel * 2) / (d.h + d.bezel * 2);
  const phoneW = Math.round(Math.min(mobile ? 280 : 330, (h - (mobile ? 280 : 110)) * ratio, w - 40));
  const jump = (k: number) => { const el = ref.current; if (!el) return; const top = el.offsetTop + (el.offsetHeight - h) * ((k + 0.5) / DAY.length); window.scrollTo({ top, behavior: 'smooth' }); };
  return (
    <section className="day" id="day" ref={ref} style={{ height: `${DAY.length * 110}vh` }}>
      <motion.div className={`day-pin${dark ? ' night' : ''}`} style={{ backgroundColor: sky }}>
        <motion.div className="sun" style={{ left: sunX, top: sunY }} aria-hidden><i className={dark ? 'moon' : ''} /></motion.div>
        <div className="wrap day-in">
          <div className="day-copy">
            <span className="day-kicker">A day at two Lagos shops</span>
            <div className="clock" aria-live="polite">
              <AnimatePresence mode="popLayout">
                <motion.span key={s.time} initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }} transition={{ duration: 0.45, ease }}>{s.time}</motion.span>
              </AnimatePresence>
            </div>
            <AnimatePresence mode="wait">
              <motion.div key={i} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.4, ease }}>
                <span className="day-tag">{s.tag}</span>
                <h2>{s.title}</h2>
                <p>{s.body}</p>
                <small className="day-who">Shown: {s.who} · {s.script.device === 'android' ? 'Samsung Galaxy S24' : 'iPhone 15'} · example shops</small>
              </motion.div>
            </AnimatePresence>
            <div className="hours">
              <motion.i className="hours-bar" style={{ scaleX: bar }} />
              {DAY.map((x, k) => <button key={x.time} className={k === i ? 'on' : k < i ? 'past' : ''} onClick={() => jump(k)} aria-label={`${x.time}: ${x.tag}`}><span>{x.time}</span></button>)}
            </div>
          </div>
          <div className="day-phone" style={{ width: phoneW }}>
            <AnimatePresence mode="wait">
              <motion.div key={i} initial={{ opacity: 0, y: 40, rotate: -2 }} animate={{ opacity: 1, y: 0, rotate: 0 }} exit={{ opacity: 0, y: -30, rotate: 2 }} transition={{ duration: 0.5, ease }}>
                <Phone device={s.script.device} maxWidth={phoneW} label={`${s.who}'s phone at ${s.time}`}><Chat script={s.script} speed={1.25} loop={false} /></Phone>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

// ── Talk to your shop: things owners actually type, and what happens ──
const PHRASES: [string, string, string][] = [
  ['jollof don finish', 'Marked sold out. Customers stop being offered it.', 'Undo for 10 min'],
  ['egusi restock 20', 'Back in stock with 20 plates.', 'Undo for 10 min'],
  ['who never pay?', 'Every order still waiting for money, with amounts.', 'Instant'],
  ['RLY-7PL2M don leave', 'Marked out for delivery. The customer is told.', 'Instant'],
  ['price of zobo 1000', 'Shows the change and waits for your Confirm.', 'Asks first'],
  ['remind people wey leave cart', 'Abandoned-cart reminders switched on.', 'Asks first'],
  ['how far with sales this week?', 'This week vs last week, in one message.', 'Instant'],
  ['withdraw 80k', 'Sends it to your bank after one Confirm.', 'Asks first'],
];
function Phrasebook() {
  return (
    <section className="phrase">
      <div className="wrap">
        <Rise className="ph-head">
          <h2>Manage the shop by <em>saying</em> it.</h2>
          <p>No dashboard to learn. Type or send a voice note to Relay, in English or Pidgin. Anything touching prices, money or your customers' inboxes waits for your Confirm.</p>
        </Rise>
        <ul className="ph-list">
          {PHRASES.map(([say, does, how], k) => (
            <Rise as="li" key={say} delay={k * 0.05}>
              <span className="ph-say">“{say}”</span>
              <span className="ph-does">{does}</span>
              <span className={`ph-how ${how === 'Asks first' ? 'ask' : ''}`}>{how}</span>
            </Rise>
          ))}
        </ul>
      </div>
    </section>
  );
}

// ── Smart Reach: the right customer hears the right thing, once ──
const REACH: [string, string, string][] = [
  ['Back in stock', 'Only people who asked for it.', 'Good news Amaka! The Ankara top is back in your size 🎉'],
  ['Left in cart', 'One reminder an hour later. Never twice.', 'Your sneakers are still in your cart. 2 pairs left.'],
  ['Price drop', 'Only people who looked at it and didn’t buy.', 'The linen shirt you liked is now ₦12,000.'],
  ['After delivery', 'A day later, a friendly check-in.', 'Hope you’re enjoying your top! Anything else you need?'],
  ['Usual order', 'Regulars, around when they normally buy.', 'It’s about time for your usual egusi. Same again?'],
  ['Send to a group', 'Say who and what. Relay shows the count and cost first.', '“tell my regulars we open Sunday”'],
];
const REACH_RULES = ['At most 1 update a week per customer', 'Nothing between 9pm and 8am', 'Every message has Stop updates', 'Paid messages only after you see the cost'];
function Reach() {
  return (
    <section className="reach" id="reach">
      <div className="wrap">
        <Rise className="rh-top">
          <div>
            <span className="kicker">Smart Reach</span>
            <h2>Sell again to people who <em>already</em> bought.</h2>
          </div>
          <p>Relay remembers what every customer asked for, bought and left in the cart. When something changes, it tells only the people it matters to, in your shop's own voice. No blasting your whole contact list.</p>
        </Rise>
        <ul className="rh-grid">
          {REACH.map(([name, who, say], k) => (
            <Rise as="li" key={name} delay={k * 0.05}>
              <b>{name}</b>
              <span className="rh-who">{who}</span>
              <span className="rh-say">{say}</span>
            </Rise>
          ))}
        </ul>
        <Rise className="rh-rules">
          {REACH_RULES.map(r => <span key={r}>{r}</span>)}
        </Rise>
        <Rise><p className="rh-note">Automatic updates go out free inside open chats. For regulars, Relay writes the message and you send it from your own phone, also free. You can switch each update on or off by typing <b>REACH</b>.</p></Rise>
      </div>
    </section>
  );
}

function Payments() {
  return (
    <section className="pay">
      <div className="wrap">
        <Rise className="pay-head">
          <span className="kicker">Fake transfers</span>
          <h2>Only real money marks an order paid.</h2>
          <p>Fake alerts cost sellers food, clothes and rider fees every week. With Relay, the customer's word and the customer's screenshot don't count. The bank's does.</p>
        </Rise>
        <PaymentMatch />
      </div>
    </section>
  );
}

function Cost() {
  return (
    <section className="cost">
      <div className="wrap cost-in">
        <Rise className="cost-copy">
          <span className="kicker">What it costs</span>
          <h2>Keep the month of sales a website would have eaten.</h2>
          <p>Your customers are already on WhatsApp. Relay gives you the parts of a website that matter there: a catalogue, a cart, payments, receipts, tracking and follow-ups. It costs nothing until you make a sale.</p>
          <ul className="cost-points">
            <li><b>Nothing to build.</b> Send your menu or price list as a photo, PDF, spreadsheet or text.</li>
            <li><b>Keep your number.</b> Customers message the WhatsApp Business number they already know.</li>
            <li><b>Your money, your bank.</b> Withdraw any time from the chat. ₦1,000 minimum, no fee.</li>
          </ul>
        </Rise>
        <Receipt />
      </div>
    </section>
  );
}

function Setup() {
  const steps = [
    ['Say hi to Relay', 'on WhatsApp. No forms, no app.'],
    ['Send your menu or price list', 'photo, PDF, spreadsheet or typed.'],
    ['Add area, hours, delivery prices', 'or upload your whole delivery list.'],
    ['Try it yourself', 'send TEST and shop like a customer.'],
    ['Connect your number', 'and you are open, all day and all night.'],
  ];
  return (
    <section className="setup">
      <div className="wrap">
        <Rise><h2 className="setup-h">Open in about <em>5 minutes</em>, from your phone.</h2></Rise>
        <ol className="setup-row">
          {steps.map(([a, b], k) => (
            <Rise as="li" key={a} delay={k * 0.08}><span className="n">{k + 1}</span><b>{a}</b><span>{b}</span></Rise>
          ))}
        </ol>
      </div>
    </section>
  );
}

const QA: [string, string][] = [
  ['I already reply DMs myself. Why do I need this?', 'You can reply. You can\'t also confirm transfers, track deliveries, chase unpaid carts and remember every regular, at 2am, every day. Relay does those parts so you can run the business.'],
  ['Do my customers have to download anything?', 'No. They chat with your WhatsApp number like they always do.'],
  ['Can I keep my number and my WhatsApp Business app?', 'Yes. You connect the number your customers know, through Meta\'s official signup, and keep using the app on your phone.'],
  ['How does it stop fake transfers?', 'Each order has its own exact amount, and it is only marked paid when our payment partner reports that money arriving. Screenshots and "I don pay" never mark anything paid.'],
  ['Will it spam my customers?', 'No. Smart Reach sends each customer at most one update a week, only about things they care about, never at night. Every message has a Stop updates button.'],
  ['What does it cost?', '1% of each paid order, capped at ₦2,000, nothing on delivery. No setup fee, no monthly fee, and nothing at all until you sell.'],
  ['What if a customer wants a real person?', 'Relay hands the chat to you and stays quiet until you hand it back. It also hands over on complaints and refund requests.'],
];
function Questions() {
  return (
    <section className="qs">
      <div className="wrap qs-in">
        <Rise className="qs-head"><h2>Asked by shop owners.</h2><p>Answered the way Relay answers: short.</p></Rise>
        <div className="thread">
          {QA.map(([q, a]) => (
            <div key={q} className="pair">
              <Rise className="b-q" delay={0.02}>{q}</Rise>
              <Rise className="b-a" delay={0.15}><img src="/logo.png" alt="" width={26} height={26} />{a}</Rise>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Close() {
  const t = useLagosTime();
  return (
    <section className="close">
      <div className="wrap">
        <Rise className="close-in">
          <span className="close-time">It's {t} in Lagos.</span>
          <h2>Somebody wants to buy from you right now.</h2>
          <a className="btn btn-lime lg" href={company.ctaHref}>Open my shop free</a>
          <p>We're onboarding food and fashion sellers in Lagos first.</p>
        </Rise>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="footer">
      <div className="wrap foot-in">
        <div><a href="#top" className="brand light"><Logo size={36} /><span>Relay</span></a><p className="foot-line">Run your shop in WhatsApp.</p></div>
        <div className="foot-col"><h4>Company</h4><p>{company.legalName}</p><p>{company.address}</p><p><a href={`mailto:${company.email}`}>{company.email}</a></p>{company.phone && <p><a href={`tel:${company.phone.replace(/\s/g, '')}`}>{company.phone}</a></p>}</div>
        <div className="foot-col"><h4>Legal</h4><p><a href="/privacy">Privacy policy</a></p><p><a href="/terms">Terms of service</a></p><p><a href="/data-deletion">Delete your data</a></p></div>
      </div>
      <div className="wrap foot-base">
        <span>© {new Date().getFullYear()} {company.legalName}. Example shops and chats are illustrations. Food and fashion photos from Unsplash.</span>
        <span>WhatsApp is a trademark of Meta Platforms, Inc. Relay is an independent business using the WhatsApp Business Platform.</span>
      </div>
    </footer>
  );
}

export default function App() {
  return (
    <>
      <Strip />
      <main>
        <Opening />
        <Day />
        <Payments />
        <Reach />
        <Phrasebook />
        <Cost />
        <Setup />
        <Questions />
        <Close />
      </main>
      <Footer />
    </>
  );
}
