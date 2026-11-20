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
        <div className="open">{t} in Nigeria</div>
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
          <span><b>Pay only when you sell</b></span>
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
  const lines = [['Stop losing', ''], ['orders in', ''], ['your', 'DMs.']];
  const cards = [
    { src: PHOTOS.ankaraTop, name: 'Ankara Off Shoulder Top', price: '₦18,500', note: 'Sold 02:13', cls: 'c1' },
    { src: PHOTOS.jollof, name: 'Jollof Rice + Fish', price: '₦5,500', note: 'Paid ✓', cls: 'c2' },
    { src: PHOTOS.slippers, name: 'Leather Palm Slippers', price: '₦18,000', note: 'Back from cart', cls: 'c3' },
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
          <p>Your customer asks “how much?” at 11pm. You don’t see it until morning, and they’ve bought from someone else.</p>
          <p>Relay replies to your customers in seconds and takes the order for you.</p>
          <p className="op-small">For any Nigerian business that sells products or services on WhatsApp.</p>
          <div className="op-cta">
            <a className="btn btn-lime" href={company.ctaHref}>Open my shop free</a>
            <a className="link" href="#day">See a day of orders ↓</a>
          </div>
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
  ['jollof is finished', 'Marked sold out. Your customers stop seeing it.', 'Undo for 10 min'],
  ['egusi restock 20', 'Back in stock with 20 plates.', 'Undo for 10 min'],
  ['who hasn’t paid?', 'Every order still waiting for money.', 'Instant'],
  ['RLY-7PL2M is out for delivery', 'Your customer is told straight away.', 'Instant'],
  ['zobo price 1000', 'Waits for your Confirm before it changes.', 'Asks first'],
  ['remind people who left their cart', 'Turns on cart reminders for you.', 'Asks first'],
  ['how far with sales this week?', 'Your week so far, in one message.', 'Instant'],
  ['withdraw 80k', 'Sends it to your bank after one Confirm.', 'Asks first'],
];
function Phrasebook() {
  return (
    <section className="phrase">
      <div className="wrap">
        <Rise className="ph-head">
          <h2>Run your shop by <em>texting</em> it.</h2>
          <p>Type or send a voice note in English or Pidgin. Anything that touches your money waits for your Confirm.</p>
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
  ['Back in stock', 'For people who asked for it.', 'Good news Amaka! The Ankara top is back in your size 🎉'],
  ['Left in cart', 'For people who stopped at checkout.', 'Your slippers are still in your cart. 2 pairs left.'],
  ['Price drop', 'For people who looked but didn’t buy.', 'The linen shirt you liked is now ₦12,000.'],
  ['After delivery', 'For yesterday’s buyers.', 'Hope you’re enjoying your top! Anything else you need?'],
  ['Usual order', 'For regulars, when they usually order.', 'It’s about time for your usual egusi. Same again?'],
  ['Your own campaign', 'Tell Relay the offer. It writes the message for you.', '“tell my regulars 10% off this weekend”'],
];
const REACH_RULES = ['Sent to the right customers only', 'One promo a week at most', 'Never at night', 'Easy to stop'];
function Reach() {
  return (
    <section className="reach" id="reach">
      <div className="wrap">
        <Rise className="rh-top">
          <h2>Smart Reach brings your buyers <em>back</em>.</h2>
          <p>Smart Reach is your marketing tool inside Relay. It remembers what each customer wanted and sends your promo to the people most likely to buy. Turn a campaign on once and it runs for you.</p>
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
        <Rise><p className="rh-note">Most campaigns cost you nothing. When a message needs paying for, you see Meta’s price first and Relay adds nothing to it. Type <b>REACH</b> to turn campaigns on or off.</p></Rise>
      </div>
    </section>
  );
}

function Payments() {
  return (
    <section className="pay">
      <div className="wrap">
        <Rise className="pay-head">
          <h2>Only real money marks your order paid.</h2>
          <p>Fake transfer alerts cost you stock and rider fees. Relay waits until the exact amount reaches your account.</p>
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
          <h2>You only pay when you get paid.</h2>
          <p>Your customers already buy from you on WhatsApp. Relay gives you a catalogue, a cart and payments right there in the chat.</p>
          <p>There is nothing to pay upfront or monthly. When an order is paid, 4.5% goes to Relay and the rest is yours.</p>
          <ul className="cost-points">
            <li><b>Start with what you have.</b> Send your menu, price list or services as a photo or a PDF.</li>
            <li><b>Keep your number.</b> Your customers message the number they already know.</li>
            <li><b>Withdraw any time.</b> Your money goes straight to your bank, free.</li>
          </ul>
        </Rise>
        <Receipt />
      </div>
    </section>
  );
}

function Setup() {
  const steps = [
    ['Say hi to Relay', 'on WhatsApp.'],
    ['Send your menu or price list', 'as a photo or a PDF.'],
    ['Add your delivery prices', 'or send your delivery list.'],
    ['Try your shop', 'by sending TEST.'],
    ['Connect your number', 'and start selling.'],
  ];
  return (
    <section className="setup">
      <div className="wrap">
        <Rise><h2 className="setup-h">Open your shop in about <em>5 minutes</em>.</h2></Rise>
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
  ['I already reply my DMs. Why do I need Relay?', 'You can’t reply at 2am, or while you’re busy with another customer. Relay replies for you, so you stop losing those orders.'],
  ['Do my customers need to download anything?', 'No. They chat with your number like they always do.'],
  ['Can I keep my number and my WhatsApp Business app?', 'Yes. You keep your number and keep using the app on your phone.'],
  ['How does Relay stop fake transfers?', 'Each order gets its own exact amount. Relay marks it paid only when that amount reaches your account.'],
  ['Will Smart Reach spam my customers?', 'No. Each customer gets one promo a week at most, and never at night. They can stop updates any time.'],
  ['What does it cost?', 'You pay 4.5% of each paid order, at most ₦4,000. When you don’t sell, you pay nothing. You can pay the fee yourself or add it to your customer’s total.'],
  ['What if my customer wants to talk to me?', 'Relay hands the chat to you and stays quiet until you hand it back.'],
];
function Questions() {
  return (
    <section className="qs">
      <div className="wrap qs-in">
        <Rise className="qs-head"><h2>Your questions, answered.</h2></Rise>
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
          <span className="close-time">It's {t}.</span>
          <h2>Someone wants to buy from you right now.</h2>
          <a className="btn btn-lime lg" href={company.ctaHref}>Open my shop free</a>
          <p>You pay nothing until your customer pays you.</p>
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
        <span>© {new Date().getFullYear()} {company.legalName}</span>
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
