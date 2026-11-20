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

function Strip() {
  const t = useLagosTime();
  return (
    <header className="strip">
      <div className="wrap strip-in">
        <a href="#top" className="brand"><Logo /><span>Relay</span></a>
        <div className="open">{t} in Lagos</div>
        <a className="btn btn-ink sm" href={company.ctaHref}>Start free</a>
      </div>
    </header>
  );
}

// Phones: a call to action that stays in reach after the opening, and steps aside for the closing one.
function MobileCta() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const on = () => {
      const y = window.scrollY, vh = window.innerHeight;
      const close = document.querySelector('.close') as HTMLElement | null;
      const day = document.querySelector('.day') as HTMLElement | null;
      const end = close ? close.offsetTop - vh + 120 : Infinity;
      const inDay = !!day && y > day.offsetTop - vh * 0.5 && y < day.offsetTop + day.offsetHeight - vh * 0.6;
      setShow(y > 640 && y < end && !inDay);
    };
    on();
    window.addEventListener('scroll', on, { passive: true });
    return () => window.removeEventListener('scroll', on);
  }, []);
  return (
    <AnimatePresence>
      {show && (
        <motion.div className="m-cta" initial={{ y: 90 }} animate={{ y: 0 }} exit={{ y: 90 }} transition={{ duration: 0.3, ease }}>
          <span><b>4.5%</b> per sale</span>
          <a className="btn btn-lime" href={company.ctaHref}>Open my shop</a>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Opening() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const drift = [useTransform(scrollYProgress, [0, 1], [0, -120]), useTransform(scrollYProgress, [0, 1], [0, -60]), useTransform(scrollYProgress, [0, 1], [0, -180]), useTransform(scrollYProgress, [0, 1], [0, -90])];
  const narrow = useViewport().w < 1000;
  const lines = [['Take orders', ''], ['on WhatsApp', ''], ['while you', 'sleep.']];
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
          <p>Relay answers your customers on WhatsApp day and night. It sells from your catalogue, marks an order paid only when the money arrives, and keeps buyers updated until delivery.</p>
          <p className="op-small">Built for food and fashion sellers in Lagos who sell through DMs and don't need a website.</p>
          <div className="op-cta">
            <a className="btn btn-lime" href={company.ctaHref}>Open my shop free</a>
            <a className="link" href="#day">See a day of orders ↓</a>
          </div>
          <div className="op-fee"><b>4.5%</b> per sale. No setup or monthly fee.</div>
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
  const phoneW = Math.round(Math.min(mobile ? 290 : 330, (h - (mobile ? 300 : 110)) * ratio, w - 40));
  const jump = (k: number) => { const el = ref.current; if (!el) return; const top = el.offsetTop + (el.offsetHeight - h) * ((k + 0.5) / DAY.length); window.scrollTo({ top, behavior: 'smooth' }); };
  return (
    <section className="day" id="day" ref={ref} style={{ height: `${DAY.length * (mobile ? 100 : 110)}vh` }}>
      <motion.div className={`day-pin${dark ? ' night' : ''}`} style={{ backgroundColor: sky }}>
        <motion.div className="sun" style={{ left: sunX, top: sunY }} aria-hidden><i className={dark ? 'moon' : ''} /></motion.div>
        <div className="wrap day-in">
          <div className="day-copy">
            <div className="day-head">
              <div className="clock" aria-live="polite">
                <AnimatePresence mode="popLayout">
                  <motion.span key={s.time} initial={{ y: 40, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -40, opacity: 0 }} transition={{ duration: 0.45, ease }}>{s.time}</motion.span>
                </AnimatePresence>
              </div>
              <span className="day-tag">{s.tag}</span>
            </div>
            <AnimatePresence mode="wait">
              <motion.div key={i} initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.4, ease }}>
                <h2>{s.title}</h2>
                <p>{mobile ? s.short : s.body}</p>
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
                <Phone device={s.script.device} maxWidth={phoneW} label={`${s.who}'s phone at ${s.time}`}><Chat script={s.script} speed={mobile ? 1.6 : 1.25} loop={false} /></Phone>
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </section>
  );
}

// ── Talk to your shop: things owners type, and what happens ──
const PHRASES: [string, string, string][] = [
  ['jollof is finished', 'Marked sold out. Customers stop seeing it.', 'Undo for 10 min'],
  ['egusi restock 20', 'Back in stock with 20 plates.', 'Undo for 10 min'],
  ['who hasn’t paid?', 'Every unpaid order, with the amount owed.', 'Instant'],
  ['RLY-7PL2M is out for delivery', 'Order updated. The customer gets a message.', 'Instant'],
  ['zobo price 1000', 'Shows the new price and waits for your Confirm.', 'Asks first'],
  ['remind people who left their cart', 'Turns on cart reminders.', 'Asks first'],
  ['how far with sales this week?', 'This week against last week, in one message.', 'Instant'],
  ['withdraw 80k', 'Sends it to your bank after one Confirm.', 'Asks first'],
];
function Phrasebook() {
  return (
    <section className="phrase">
      <div className="wrap">
        <Rise className="ph-head">
          <h2>Run the shop by <em>texting</em> it.</h2>
          <p>Type or send a voice note to Relay in English or Pidgin. Price changes, withdrawals and messages to customers wait for your Confirm.</p>
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

// ── Smart Reach: WhatsApp marketing that targets and sends itself ──
const REACH: [string, string, string][] = [
  ['Back in stock', 'Goes to everyone who asked for it.', 'Good news Amaka! The Ankara top is back in your size 🎉'],
  ['Left in cart', 'Goes to shoppers who stopped at checkout.', 'Your sneakers are still in your cart. 2 pairs left.'],
  ['Price drop', 'Goes to people who looked and didn’t buy.', 'The linen shirt you liked is now ₦12,000.'],
  ['After delivery', 'Goes to yesterday’s buyers.', 'Hope you’re enjoying your top! Anything else you need?'],
  ['Usual order', 'Goes to regulars when they normally reorder.', 'It’s about time for your usual egusi. Same again?'],
  ['Your own campaign', 'Describe the offer and who gets it. Relay writes it and shows the reach and cost.', '“tell my regulars 10% off this weekend”'],
];
const REACH_RULES = ['Targeted by what they viewed and bought', 'At most 1 promo a week per customer', 'Nothing sent 9pm to 8am', 'Stop updates on every message'];
function Reach() {
  return (
    <section className="reach" id="reach">
      <div className="wrap">
        <Rise className="rh-top">
          <h2>Smart Reach brings buyers <em>back</em>.</h2>
          <p>Smart Reach is the marketing tool inside Relay. It knows what every customer viewed, asked for, carted and bought, and sends each promo only to the people likely to buy. Switch on the campaigns you want and they run on their own.</p>
        </Rise>
        <Rise>
          <ul className="rh-grid">
            {REACH.map(([name, who, say]) => (
              <li key={name}>
                <b>{name}</b>
                <span className="rh-who">{who}</span>
                <span className="rh-say">{say}</span>
              </li>
            ))}
          </ul>
        </Rise>
        <Rise className="rh-rules">
          {REACH_RULES.map(r => <span key={r}>{r}</span>)}
        </Rise>
        <Rise><p className="rh-note">Campaigns go out free inside open chats. For regulars, Relay writes the promo and you send it from your own phone, also free. Paid WhatsApp messages come from your wallet at Meta's price, and only after you approve the cost. Type <b>REACH</b> to switch campaigns on or off.</p></Rise>
      </div>
    </section>
  );
}

function Payments() {
  return (
    <section className="pay">
      <div className="wrap">
        <Rise className="pay-head">
          <h2>Only real money marks an order paid.</h2>
          <p>Fake transfer alerts cost sellers food, clothes and rider fees every week. Relay marks an order paid only when the payment partner reports the exact amount arriving. Screenshots and forwarded alerts change nothing.</p>
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
          <h2>Keep the month of sales a website would have eaten.</h2>
          <p>Your customers already buy on WhatsApp. Relay adds what a website would give you there: a catalogue, a cart, payments, receipts, tracking and marketing. You pay 4.5% when an order is paid, and nothing before your first sale.</p>
          <ul className="cost-points">
            <li><b>Set up from what you have.</b> Send your menu or price list as a photo, PDF, spreadsheet or text.</li>
            <li><b>Keep your number.</b> Customers message the WhatsApp Business number they already know.</li>
            <li><b>Withdraw any time.</b> Straight to your bank from the chat, ₦1,000 minimum, free.</li>
          </ul>
        </Rise>
        <Receipt />
      </div>
    </section>
  );
}

function Setup() {
  const steps = [
    ['Say hi to Relay', 'on WhatsApp to start.'],
    ['Send your menu or price list', 'as a photo, PDF, spreadsheet or text.'],
    ['Add your area, hours and delivery prices', 'or upload your whole delivery list.'],
    ['Try it as a customer', 'by sending TEST.'],
    ['Connect your number', 'and start taking orders.'],
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
  ['Do my customers have to download anything?', 'No. They chat with your WhatsApp number as they always have.'],
  ['Can I keep my number and my WhatsApp Business app?', 'Yes. You connect the number your customers know through Meta\'s official signup, and keep using the app on your phone.'],
  ['How does it stop fake transfers?', 'Each order has its own exact amount, and it is marked paid only when our payment partner reports that money arriving. A screenshot or an "I\'ve paid" message never marks anything paid.'],
  ['Will Smart Reach spam my customers?', 'No. Each customer gets at most one promo a week, only about things they showed interest in, and never at night. Every message has a Stop updates button.'],
  ['What does it cost?', '4.5% of each sale, at most ₦4,000, and payments are included. You choose whether you or your customers pay it. There is no setup or monthly fee. Paid marketing messages are charged at Meta\'s price, after you approve them.'],
  ['What if a customer wants a real person?', 'Relay hands the chat to you and stays quiet until you hand it back. It also hands over complaints and refund requests.'],
];
function Questions() {
  return (
    <section className="qs">
      <div className="wrap qs-in">
        <Rise className="qs-head"><h2>Questions from shop owners.</h2></Rise>
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
      <MobileCta />
    </>
  );
}
