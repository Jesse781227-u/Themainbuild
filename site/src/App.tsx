import { AnimatePresence, motion, useScroll, useSpring, useTransform } from 'framer-motion';
import { useRef, useState, type ReactNode } from 'react';
import { Phone } from './components/Phone';
import { Chat, type ChatScript } from './components/Chat';
import { AgentLoop, FeeCalculator, LayerDiagram, SlowReply, Stat } from './components/Infographics';
import { customerSale, morningBrief, onboarding, ownerOps, reach } from './demos/scripts';
import { company } from './company';

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];
const up = { initial: { opacity: 0, y: 28 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, amount: 0.3 }, transition: { duration: 0.8, ease } };

function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  return <motion.div className={className} {...up} transition={{ ...up.transition, delay }}>{children}</motion.div>;
}

function Section({ id, eyebrow, title, lead, children, tone }: { id?: string; eyebrow: string; title: ReactNode; lead?: ReactNode; children: ReactNode; tone?: 'dark' | 'lime' }) {
  return (
    <section id={id} className={`section${tone ? ` ${tone}` : ''}`}>
      <div className="wrap">
        <Reveal className="sec-head">
          <span className="eyebrow">{eyebrow}</span>
          <h2>{title}</h2>
          {lead && <p className="lead">{lead}</p>}
        </Reveal>
        {children}
      </div>
    </section>
  );
}

const Logo = ({ size = 34 }: { size?: number }) => <img src="/logo.png" width={size} height={size} alt="" className="logo" />;

function Nav() {
  const { scrollY } = useScroll();
  const bg = useTransform(scrollY, [0, 80], ['rgba(11,13,10,0)', 'rgba(11,13,10,0.78)']);
  const border = useTransform(scrollY, [0, 80], ['rgba(255,255,255,0)', 'rgba(255,255,255,0.08)']);
  return (
    <motion.header className="nav" style={{ backgroundColor: bg, borderColor: border }}>
      <div className="wrap nav-in">
        <a href="#top" className="brand"><Logo /><span>Relay</span></a>
        <nav className="links">
          <a href="#how">How it works</a><a href="#demo">See it work</a><a href="#pricing">Pricing</a><a href="#faq">FAQ</a>
        </nav>
        <a className="btn btn-lime sm" href={company.ctaHref}>Get started</a>
      </div>
    </motion.header>
  );
}

function Hero() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end start'] });
  const yA = useTransform(scrollYProgress, [0, 1], [0, -60]);
  const yB = useTransform(scrollYProgress, [0, 1], [0, 40]);
  const rot = useTransform(scrollYProgress, [0, 1], [6, 12]);
  const ownerHero: ChatScript = { ...ownerOps, messages: ownerOps.messages.map((m, i) => (i === 0 ? { ...m, wait: 16500 } : m)) };
  const words = ['AI', 'that', 'runs', 'your', 'shop'];
  return (
    <section className="hero" id="top" ref={ref}>
      <div className="hero-bg"><div className="grid" /><div className="blob b1" /><div className="blob b2" /></div>
      <div className="wrap hero-in">
        <div className="hero-copy">
          <motion.span className="pill" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease }}>
            <i className="dot" /> Built on the official WhatsApp Business Platform
          </motion.span>
          <h1>
            {words.map((w, i) => <motion.span key={w} className="w" initial={{ opacity: 0, y: 40, rotate: 4 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ duration: 0.8, delay: 0.1 + i * 0.07, ease }}>{w}&nbsp;</motion.span>)}
            <br />
            <motion.span className="w hl" initial={{ opacity: 0, y: 40 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.5, ease }}>in WhatsApp.</motion.span>
          </h1>
          <motion.p className="hero-sub" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.65, ease }}>
            Relay answers your customers, takes their orders, confirms their payments and sends receipts, in English and Pidgin, at any hour. You get the money and a short summary.
          </motion.p>
          <motion.div className="cta-row" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.8, ease }}>
            <a className="btn btn-lime" href={company.ctaHref}>Get started free <span aria-hidden>→</span></a>
            <a className="btn btn-ghost" href="#demo">See it work</a>
          </motion.div>
          <motion.ul className="ticks-list" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.1 }}>
            <li>No app for you or your customers</li><li>Set up in about 5 minutes</li><li>1% only when you sell</li>
          </motion.ul>
        </div>
        <div className="hero-phones">
          <motion.div className="hp hp-back" style={{ y: yB, rotate: rot }} initial={{ opacity: 0, x: 60 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: 1.1, delay: 0.4, ease }}>
            <Phone device="iphone" maxWidth={280} label="iPhone showing the shop owner's chat with Relay"><Chat script={ownerHero} /></Phone>
            <span className="tag">The owner's phone</span>
          </motion.div>
          <motion.div className="hp hp-front" style={{ y: yA }} initial={{ opacity: 0, y: 80 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 1.1, delay: 0.2, ease }}>
            <Phone device="android" maxWidth={300} label="Android phone showing a customer ordering from the shop on WhatsApp"><Chat script={customerSale} /></Phone>
            <span className="tag">A customer's phone · example chat</span>
          </motion.div>
          <Float className="f1" delay={1.4}>⚡ Replied in seconds</Float>
          <Float className="f2" delay={2.0}>✅ Payment confirmed</Float>
          <Float className="f3" delay={2.6}>🧾 Receipt sent</Float>
        </div>
      </div>
    </section>
  );
}

function Float({ children, className, delay }: { children: ReactNode; className: string; delay: number }) {
  return (
    <motion.div className={`float ${className}`} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1, y: [0, -8, 0] }}
      transition={{ opacity: { delay }, scale: { delay, type: 'spring' }, y: { delay, duration: 4, repeat: Infinity, ease: 'easeInOut' } }}>
      {children}
    </motion.div>
  );
}

function Marquee() {
  const items = ['Answers in English & Pidgin', 'Understands voice notes', 'Confirms payments automatically', 'PDF receipts', 'Delivery prices by area', 'Sizes & colours', 'Sold out in one message', 'Morning brief at 7am', 'Broadcasts to opted-in customers', 'Hands over to you when needed'];
  return (
    <div className="marquee" aria-hidden>
      <div className="track-m">{[...items, ...items].map((t, i) => <span key={i}>{t}<i>✦</i></span>)}</div>
    </div>
  );
}

const TABS: { key: string; label: string; title: string; points: string[]; script: ChatScript }[] = [
  { key: 'sell', label: 'Sell & get paid', title: 'From "how much?" to paid, while you sleep', script: customerSale,
    points: ['Answers questions with your real prices and photos', 'Builds the cart, picks sizes, quotes delivery by area', 'Sends a pay link, confirms payment, sends a PDF receipt', 'Never invents a price or gives a discount you didn\'t set'] },
  { key: 'run', label: 'Run your shop', title: 'Tell it what changed, in your own words', script: ownerOps,
    points: ['Every paid order lands in your chat with Relay', '"Jollof don finish" marks it sold out, with Undo', 'Ask anything: sales this week, who owes, what sells', 'Type or send a voice note, English or Pidgin'] },
  { key: 'brief', label: 'Morning brief', title: 'Your day, in one message at 7am', script: morningBrief,
    points: ['What to deliver today', 'Who still owes, and how much', 'What is running low or sold out', 'Fix it with one tap or one line'] },
  { key: 'reach', label: 'Bring customers back', title: 'Customers come back without spam', script: reach,
    points: ['Say who to reach in plain words: "my regulars"', 'Free routes first; you see any cost before sending', 'Only customers who agreed, at most once a week', 'See who replied and ordered within 48 hours'] },
];

function Demos() {
  const [tab, setTab] = useState(0);
  const t = TABS[tab];
  return (
    <Section id="demo" eyebrow="See it work" title={<>One assistant. <span className="hl">Both sides</span> of the chat.</>} lead="Your customers talk to your shop's WhatsApp number. You talk to Relay. Pick a moment to watch it happen.">
      <div className="tabs" role="tablist">
        {TABS.map((x, i) => (
          <button key={x.key} role="tab" aria-selected={i === tab} className={i === tab ? 'on' : ''} onClick={() => setTab(i)}>
            {i === tab && <motion.span layoutId="tabpill" className="tabpill" transition={{ type: 'spring', stiffness: 400, damping: 34 }} />}
            <span className="tl">{x.label}</span>
          </button>
        ))}
      </div>
      <div className="demo">
        <AnimatePresence mode="wait">
          <motion.div key={t.key} className="demo-copy" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.4, ease }}>
            <h3>{t.title}</h3>
            <ul className="checks">{t.points.map((p, i) => <motion.li key={p} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 + i * 0.08 }}>{p}</motion.li>)}</ul>
            <p className="device-note">{t.script.device === 'android' ? 'Shown on a Samsung Galaxy S24 (360 × 780)' : 'Shown on an iPhone 15 (393 × 852)'} · example shop</p>
          </motion.div>
        </AnimatePresence>
        <div className="demo-phone">
          <AnimatePresence mode="wait">
            <motion.div key={t.key} initial={{ opacity: 0, y: 30, rotateY: -12 }} animate={{ opacity: 1, y: 0, rotateY: 0 }} exit={{ opacity: 0, y: -20, rotateY: 12 }} transition={{ duration: 0.55, ease }}>
              <Phone device={t.script.device} maxWidth={320}><Chat script={t.script} /></Phone>
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </Section>
  );
}

function How() {
  const steps = [
    { n: '01', t: 'Set up in a chat', d: 'Message Relay on WhatsApp. Send your menu or price list as text, a photo, a PDF or a spreadsheet. Add your area, hours and delivery prices. About 5 minutes.' },
    { n: '02', t: 'Try it yourself', d: 'Send TEST and shop from your own store as a customer, with pretend payments, until it sounds like you.' },
    { n: '03', t: 'Connect your number', d: 'Link the WhatsApp Business number your customers already know. You can still use the WhatsApp Business app on your phone.' },
    { n: '04', t: 'Relay sells. You get paid.', d: 'Customers chat, order and pay. Money goes to your Relay wallet; withdraw to your bank any time.' },
  ];
  return (
    <Section id="how" eyebrow="How it works" title={<>Live in about <span className="hl">5 minutes</span>, all inside WhatsApp</>} lead="No dashboard to learn. The whole setup is a conversation.">
      <div className="how">
        <div className="how-steps">
          {steps.map((s, i) => (
            <Reveal key={s.n} delay={i * 0.08} className="step">
              <span className="step-n">{s.n}</span>
              <div><h3>{s.t}</h3><p>{s.d}</p></div>
            </Reveal>
          ))}
        </div>
        <Reveal className="how-phone" delay={0.2}>
          <Phone device="android" maxWidth={300} label="Android phone showing shop signup with Relay"><Chat script={onboarding} /></Phone>
        </Reveal>
      </div>
    </Section>
  );
}

function Guardrails() {
  const cols = [
    { h: 'Does on its own', c: 'go', items: ['Answers customers and takes orders', 'Confirms payments, sends receipts', 'Marks items sold out or back in stock, with Undo', 'Automatic updates you switched on'] },
    { h: 'Asks you first', c: 'ask', items: ['Changing prices or delivery fees', 'Deleting products', 'Cancelling an order', 'Sending a broadcast'] },
    { h: 'Never does', c: 'no', items: ['Haggle or give discounts you didn\'t set', 'Invent prices or stock', 'Move your money', 'Message people who said stop'] },
  ];
  return (
    <Section eyebrow="Guardrails" title={<>It acts. <span className="hl">You stay in charge.</span></>} lead="Every price and number in a reply is checked against your shop before it is sent. When a customer complains or asks for a person, the chat comes to you and Relay goes quiet until you hand it back.">
      <div className="guard">
        {cols.map((col, i) => (
          <Reveal key={col.h} delay={i * 0.1} className={`gcol ${col.c}`}>
            <div className="gicon">{col.c === 'go' ? '✓' : col.c === 'ask' ? '?' : '×'}</div>
            <h3>{col.h}</h3>
            <ul>{col.items.map(x => <li key={x}>{x}</li>)}</ul>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

const FAQS = [
  ['Do my customers need to download anything?', 'No. They message your WhatsApp number like they always do. You manage everything by chatting with Relay on WhatsApp too.'],
  ['Can I keep my WhatsApp Business number?', 'Yes. You connect the number your customers already know through Meta\'s official signup, and you can keep using the WhatsApp Business app on your phone.'],
  ['Does it understand Pidgin and voice notes?', 'Yes. Customers and owners can type in English or Pidgin, or send voice notes. Replies match how the customer writes.'],
  ['What if a customer asks something it can\'t answer?', 'It asks one short question, or offers simple buttons. If the customer complains, asks for a refund, or wants a person, the chat is handed to you and Relay stays quiet until you hand it back.'],
  ['Will customers know they\'re talking to an AI?', 'Relay replies as your shop. If a customer asks whether it\'s a bot, it says honestly that it\'s your shop\'s AI assistant and tells them how to reach you.'],
  ['How do I get my money?', 'Customers pay into your Relay wallet through our payments partner, and each payment is confirmed automatically. You withdraw to your bank account from the chat: ₦1,000 minimum, no fee. You verify your bank details and BVN once, before your first withdrawal.'],
  ['How much does it cost?', '1% of each paid order, capped at ₦2,000, and nothing on delivery fees. You choose whether you or the customer pays it. No monthly fee, and nothing at all until you make a sale.'],
  ['Will it spam my customers?', 'No. Promotions go only to customers who agreed to updates, at most once a week, never at night, and anyone can reply STOP. Any WhatsApp message cost is shown to you before sending.'],
];

function Faq() {
  const [open, setOpen] = useState<number | null>(0);
  return (
    <Section id="faq" eyebrow="FAQ" title="Questions owners ask">
      <div className="faq">
        {FAQS.map(([q, a], i) => (
          <Reveal key={q} delay={i * 0.04} className={`qa${open === i ? ' open' : ''}`}>
            <button onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>
              <span>{q}</span><motion.i animate={{ rotate: open === i ? 45 : 0 }}>+</motion.i>
            </button>
            <AnimatePresence initial={false}>
              {open === i && (
                <motion.div className="ans" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.35, ease }}>
                  <p>{a}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

function Footer() {
  const year = new Date().getFullYear();
  return (
    <footer className="footer">
      <div className="wrap foot-in">
        <div className="foot-brand">
          <a href="#top" className="brand"><Logo size={40} /><span>Relay</span></a>
          <p>AI that runs your shop in WhatsApp. For food and fashion sellers in Nigeria.</p>
        </div>
        <div className="foot-col">
          <h4>Company</h4>
          <p>{company.legalName}</p>
          <p>{company.address}</p>
          <p><a href={`mailto:${company.email}`}>{company.email}</a></p>
          {company.phone && <p><a href={`tel:${company.phone.replace(/\s/g, '')}`}>{company.phone}</a></p>}
        </div>
        <div className="foot-col">
          <h4>Legal</h4>
          <p><a href="/privacy.html">Privacy policy</a></p>
          <p><a href="/terms.html">Terms of service</a></p>
          <p><a href="/data-deletion.html">Delete your data</a></p>
        </div>
      </div>
      <div className="wrap foot-base">
        <span>© {year} {company.legalName}. All rights reserved.</span>
        <span>WhatsApp is a trademark of Meta Platforms, Inc. Relay is an independent business using the WhatsApp Business Platform.</span>
      </div>
    </footer>
  );
}

export default function App() {
  const { scrollYProgress } = useScroll();
  const progress = useSpring(scrollYProgress, { stiffness: 120, damping: 30 });
  return (
    <>
      <motion.div className="progress" style={{ scaleX: progress }} />
      <Nav />
      <main>
        <Hero />
        <Marquee />
        <Section eyebrow="The problem" title={<>Every slow reply is a <span className="hl">lost sale</span></>} lead="Customers message when they're hungry or ready to buy, often late at night. If nobody answers, they order from whoever does.">
          <Reveal><SlowReply /></Reveal>
          <div className="pains">
            {[['"I can\'t reply everybody"', 'Relay answers every chat at once, any hour.'], ['"Confirming transfers wears me out"', 'Payments are matched automatically. No screenshots.'], ['"I lose track of orders"', 'Every order, paid or owing, in one place, in your chat.'], ['"Customers don\'t come back"', 'Relay reminds the right customers, politely.']].map(([q, a], i) => (
              <Reveal key={q} delay={i * 0.08} className="pain"><b>{q}</b><p>{a}</p></Reveal>
            ))}
          </div>
        </Section>
        <Section eyebrow="An agent, not a chatbot" tone="dark" title={<>It doesn't just answer. <span className="hl">It does the work.</span></>} lead="Relay sits between your customers and your shop. It understands what they want, decides what to do, and does it: cart, payment, stock, receipts and follow-ups.">
          <Reveal><LayerDiagram /></Reveal>
        </Section>
        <Section eyebrow="The loop" title={<>From <span className="hl">"how much?"</span> to paid, without you</>} lead="Six steps Relay runs on its own for every order. Tap a step to see it.">
          <div className="loop-wrap">
            <Reveal><AgentLoop /></Reveal>
            <div className="stats">
              <Stat to={24} suffix="/7" label="Replies at any hour, weekends too" />
              <Stat to={5} suffix=" min" label="To set up your shop, by chat" />
              <Stat to={2} label="Languages: English and Pidgin, typed or spoken" />
              <Stat to={0} prefix="₦" label="Until you make your first sale" />
            </div>
          </div>
        </Section>
        <Demos />
        <How />
        <Guardrails />
        <Section id="pricing" eyebrow="Pricing" tone="dark" title={<>Pay <span className="hl">1%</span> when you sell. Nothing else.</>} lead="No subscription and no setup fee. Promotional WhatsApp messages, if you send any, come from your wallet at cost, and you see the price first.">
          <div className="pricing">
            <Reveal className="price-card">
              <span className="eyebrow">Every shop</span>
              <div className="big">1%<small> per paid order</small></div>
              <ul className="checks">
                <li>Capped at ₦2,000 per order</li><li>Nothing on delivery fees</li><li>AI replies included, unlimited</li><li>Free withdrawals to your bank</li><li>Nothing to pay until you sell</li>
              </ul>
              <a className="btn btn-lime" href={company.ctaHref}>Get started free</a>
            </Reveal>
            <Reveal delay={0.1}><FeeCalculator /></Reveal>
          </div>
        </Section>
        <Faq />
        <section className="final">
          <div className="wrap">
            <Reveal className="final-card">
              <Logo size={64} />
              <h2>Let Relay answer the next message.</h2>
              <p>We're onboarding our first shops in Lagos now. Food and fashion sellers first.</p>
              <a className="btn btn-dark" href={company.ctaHref}>Join the pilot <span aria-hidden>→</span></a>
            </Reveal>
          </div>
        </section>
      </main>
      <Footer />
    </>
  );
}
