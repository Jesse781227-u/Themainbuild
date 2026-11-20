import { animate, motion, useInView, useMotionValue, useReducedMotion, useTransform } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { SVGMotionProps } from 'framer-motion';

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];

// ── The 11:47pm problem: the same message, answered by hand vs by Relay ──
export function SlowReply() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const lane = (delay: number) => ({ initial: { scaleX: 0 }, animate: inView ? { scaleX: 1 } : {}, transition: { duration: 1.6, delay, ease } });
  const pop = (delay: number) => ({ initial: { opacity: 0, y: 10, scale: 0.9 }, animate: inView ? { opacity: 1, y: 0, scale: 1 } : {}, transition: { duration: 0.5, delay, ease } });
  return (
    <div className="slow" ref={ref}>
      <div className="slow-axis">{['11pm', '1am', '3am', '5am', '7am', '9am'].map(t => <span key={t}>{t}</span>)}</div>
      <div className="lane">
        <div className="lane-label"><b>By hand</b><span>You're asleep</span></div>
        <div className="track">
          <motion.div className="bar bar-bad" style={{ originX: 0 }} {...lane(0.2)} />
          <motion.div className="pin" style={{ left: '7%' }} {...pop(0.1)}><i />Message · 11:47pm</motion.div>
          <motion.div className="pin pin-bad" style={{ left: '69%' }} {...pop(1.7)}><i />Reply · 7:15am</motion.div>
          <motion.div className="verdict bad" {...pop(2.1)}>Customer already bought elsewhere</motion.div>
        </div>
      </div>
      <div className="lane">
        <div className="lane-label"><b>With Relay</b><span>Any hour</span></div>
        <div className="track">
          <motion.div className="bar bar-good" style={{ originX: 0, width: '4%' }} {...lane(0.6)} />
          <motion.div className="pin" style={{ left: '7%' }} {...pop(0.5)}><i />Message · 11:47pm</motion.div>
          <motion.div className="pin pin-good" style={{ left: '7%', top: 54 }} {...pop(1.0)}><i />Replied in seconds · paid by 11:49pm</motion.div>
          <motion.div className="verdict good" {...pop(1.4)}>Sale made, receipt sent, you see it in the morning</motion.div>
        </div>
      </div>
    </div>
  );
}

// ── The layer: customers ⇄ Relay ⇄ your shop, with the services it plugs into ──
export function LayerDiagram() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.3 });
  const reduce = useReducedMotion();
  const packet = (path: string, delay: number, color: string) => !reduce && inView && (
    <circle r="5" fill={color}><animateMotion dur="2.6s" repeatCount="indefinite" begin={`${delay}s`} path={path} /></circle>
  );
  const draw = (d: number): SVGMotionProps<SVGPathElement> => ({ initial: { pathLength: 0 } as never, animate: { pathLength: inView ? 1 : 0 } as never, transition: { duration: 1.2, delay: d, ease } });
  const fade = (d: number) => ({ initial: { opacity: 0, y: 12 }, animate: inView ? { opacity: 1, y: 0 } : {}, transition: { duration: 0.6, delay: d, ease } });
  return (
    <div className="layer" ref={ref}>
      <svg viewBox="0 0 960 470" className="layer-svg" role="img" aria-label="Customers on WhatsApp connect to Relay, which works on your shop's catalogue, stock, orders and wallet, using WhatsApp, payments, AI and Google Sheets.">
        <defs>
          <linearGradient id="lg" x1="0" x2="1"><stop offset="0" stopColor="#8BE01B" /><stop offset="1" stopColor="#C6F36B" /></linearGradient>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="14" /></filter>
        </defs>
        {/* wires */}
        <motion.path d="M200 170 C 280 170, 300 170, 375 170" stroke="var(--line-strong)" strokeWidth="2" fill="none" {...draw(0.2)} />
        <motion.path d="M375 230 C 300 230, 280 230, 200 230" stroke="var(--line-strong)" strokeWidth="2" fill="none" {...draw(0.3)} />
        <motion.path d="M585 170 C 660 170, 680 170, 760 170" stroke="var(--line-strong)" strokeWidth="2" fill="none" {...draw(0.4)} />
        <motion.path d="M760 230 C 680 230, 660 230, 585 230" stroke="var(--line-strong)" strokeWidth="2" fill="none" {...draw(0.5)} />
        {[120, 360, 600, 840].map((x, i) => <motion.path key={x} d={`M480 290 C 480 340, ${x} 340, ${x} 380`} stroke="var(--line)" strokeWidth="1.5" strokeDasharray="4 6" fill="none" {...draw(0.7 + i * 0.1)} />)}
        {packet('M200 170 C 280 170, 300 170, 375 170', 0, '#8BE01B')}
        {packet('M585 170 C 660 170, 680 170, 760 170', 0.9, '#8BE01B')}
        {packet('M760 230 C 680 230, 660 230, 585 230', 1.5, '#fff')}
        {packet('M375 230 C 300 230, 280 230, 200 230', 2.1, '#fff')}

        {/* customers */}
        <motion.g {...fade(0.1)}>
          <rect x="20" y="110" width="180" height="180" rx="22" fill="var(--card)" stroke="var(--line)" />
          {[0, 1, 2].map(i => <g key={i} transform={`translate(${48 + i * 40} 150)`}><circle r="16" fill={['#F59E0B', '#0EA5E9', '#EC4899'][i]} opacity=".9" /><circle r="16" fill="none" stroke="var(--card)" strokeWidth="3" /></g>)}
          <text x="110" y="208" textAnchor="middle" className="t-h">Customers</text>
          <text x="110" y="232" textAnchor="middle" className="t-s">on WhatsApp, any hour</text>
          <text x="110" y="256" textAnchor="middle" className="t-s">text · voice · Pidgin</text>
        </motion.g>
        {/* relay */}
        <motion.g {...fade(0.3)}>
          <rect x="380" y="90" width="200" height="200" rx="28" fill="url(#lg)" opacity=".35" filter="url(#glow)" />
          <rect x="375" y="85" width="210" height="210" rx="28" fill="#0B0D0A" stroke="#8BE01B" strokeWidth="2" />
          <image href="/logo.png" x="448" y="105" width="64" height="64" style={{ clipPath: 'inset(0 round 14px)' }} />
          <text x="480" y="196" textAnchor="middle" className="t-h light">Relay</text>
          {['understands', 'decides · acts', 'checks every fact'].map((t, i) => <text key={t} x="480" y={222 + i * 22} textAnchor="middle" className="t-s light">{t}</text>)}
        </motion.g>
        {/* shop */}
        <motion.g {...fade(0.5)}>
          <rect x="760" y="110" width="180" height="180" rx="22" fill="var(--card)" stroke="var(--line)" />
          <text x="850" y="150" textAnchor="middle" className="t-h">Your shop</text>
          {['Catalogue & prices', 'Stock & sold out', 'Orders & delivery', 'Wallet & payouts'].map((t, i) => <g key={t}><circle cx="790" cy={176 + i * 26} r="4" fill="#8BE01B" /><text x="802" y={181 + i * 26} className="t-s">{t}</text></g>)}
        </motion.g>
        {/* plugs */}
        {[['WhatsApp', 'Cloud API'], ['Bachs', 'payments & wallet'], ['Google Gemini', 'language'], ['Google Sheets', 'export']].map(([a, b], i) => (
          <motion.g key={a} {...fade(0.9 + i * 0.12)}>
            <rect x={[120, 360, 600, 840][i] - 95} y="382" width="190" height="64" rx="16" fill="var(--card)" stroke="var(--line)" />
            <text x={[120, 360, 600, 840][i]} y="410" textAnchor="middle" className="t-h sm">{a}</text>
            <text x={[120, 360, 600, 840][i]} y="430" textAnchor="middle" className="t-s">{b}</text>
          </motion.g>
        ))}
      </svg>
    </div>
  );
}

// ── The loop Relay runs on its own, step by step ──
const LOOP = [
  { k: 'Message', d: '"How much be jollof?" at 11:47pm, typed or as a voice note.' },
  { k: 'Understand', d: 'Reads plain words and Pidgin, finds the item, the size, the area.' },
  { k: 'Cart', d: 'Adds it, quotes delivery from your own price list.' },
  { k: 'Pay', d: 'Sends a pay link or exact transfer details, holds the stock.' },
  { k: 'Confirm', d: 'Payment is matched automatically. No screenshots to check.' },
  { k: 'Receipt', d: 'PDF receipt to the customer, the order to you, the money to your wallet.' },
];
export function AgentLoop() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const reduce = useReducedMotion();
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (!inView || reduce) return;
    const id = window.setInterval(() => setStep(s => (s + 1) % LOOP.length), 2200);
    return () => clearInterval(id);
  }, [inView, reduce]);
  const R = 150, C = 190;
  const pos = (i: number) => { const a = (i / LOOP.length) * Math.PI * 2 - Math.PI / 2; return [C + R * Math.cos(a), C + R * Math.sin(a)]; };
  const [dx, dy] = pos(step);
  return (
    <div className="loop" ref={ref}>
      <div className="loop-ring">
        <svg viewBox="0 0 380 380">
          <circle cx={C} cy={C} r={R} fill="none" stroke="var(--line)" strokeWidth="2" />
          <motion.circle cx={C} cy={C} r={R} fill="none" stroke="#8BE01B" strokeWidth="3" strokeLinecap="round" transform={`rotate(-90 ${C} ${C})`}
            animate={{ pathLength: (step + 1) / LOOP.length } as never} transition={{ duration: 0.8, ease }} />
          <motion.circle r="9" fill="#8BE01B" initial={{ cx: dx, cy: dy }} animate={{ cx: dx, cy: dy }} transition={{ duration: 0.8, ease }} />
          <motion.circle fill="#8BE01B" opacity=".25" initial={{ cx: dx, cy: dy, r: 18 }} animate={{ cx: dx, cy: dy, r: [16, 26, 16] } as never} transition={{ duration: 0.8, ease, r: { duration: 1.6, repeat: Infinity } }} />
        </svg>
        {LOOP.map((s, i) => {
          const [x, y] = pos(i);
          return (
            <button key={s.k} className={`loop-node${i === step ? ' on' : ''}${i < step ? ' done' : ''}`} style={{ left: `${(x / 380) * 100}%`, top: `${(y / 380) * 100}%` }} onClick={() => setStep(i)}>
              <span>{i + 1}</span>{s.k}
            </button>
          );
        })}
        <div className="loop-center">
          <motion.div key={step} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
            <small>Step {step + 1} of {LOOP.length}</small>
            <b>{LOOP[step].k}</b>
            <p>{LOOP[step].d}</p>
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// ── Count-up stat ──
export function Stat({ to, prefix = '', suffix = '', label, decimals = 0 }: { to: number; prefix?: string; suffix?: string; label: string; decimals?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.6 });
  const v = useMotionValue(0);
  const text = useTransform(v, n => `${prefix}${n.toFixed(decimals)}${suffix}`);
  useEffect(() => { if (inView) animate(v, to, { duration: 1.6, ease }); }, [inView, to, v]);
  return <div className="stat" ref={ref}><motion.b>{text}</motion.b><span>{label}</span></div>;
}

// ── Fee calculator: 1% of the order, capped, nothing on delivery ──
const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;
export function FeeCalculator({ capNaira = 2000 }: { capNaira?: number }) {
  const [order, setOrder] = useState(15000);
  const fee = Math.min(order * 0.01, capNaira);
  const keep = order - fee;
  const capped = order * 0.01 > capNaira;
  return (
    <div className="calc">
      <label htmlFor="order">Order value (before delivery)</label>
      <div className="calc-val">{naira(order)}</div>
      <input id="order" type="range" min={1000} max={500000} step={500} value={order} onChange={e => setOrder(Number(e.target.value))}
        style={{ ['--p' as string]: `${((order - 1000) / 499000) * 100}%` }} />
      <div className="calc-bar">
        <motion.div className="keep" animate={{ flexGrow: keep }} transition={{ type: 'spring', stiffness: 200, damping: 30 }}><span>You keep {naira(keep)}</span></motion.div>
        <motion.div className="fee" animate={{ flexGrow: Math.max(fee, order * 0.006) }} transition={{ type: 'spring', stiffness: 200, damping: 30 }} />
      </div>
      <div className="calc-rows">
        <div><span>Relay fee</span><b>{naira(fee)}{capped && <em> · capped</em>}</b></div>
        <div><span>Delivery fee</span><b>No fee</b></div>
        <div><span>Withdrawals to your bank</span><b>Free</b></div>
      </div>
      <p className="calc-note">You choose whether you or the customer pays the 1%. Nothing to pay until you make a sale.</p>
    </div>
  );
}
