import { motion, useInView } from 'framer-motion';
import { useRef, useState } from 'react';

const ease: [number, number, number, number] = [0.22, 1, 0.36, 1];
const naira = (n: number) => `₦${Math.round(n).toLocaleString('en-NG')}`;

// ── A printed receipt: nothing upfront or monthly, then what a sale costs you ──
// The fee is shown as one 4.5% line; inside it the two parts are capped separately (₦2,000 each).
export function Receipt({ capNaira = 2000, rate = 0.03, processing = 0.015 }: { capNaira?: number; rate?: number; processing?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.35 });
  const [order, setOrder] = useState(15000);
  const fee = Math.min(order * rate, capNaira) + Math.min(order * processing, capNaira);
  const capped = order * (rate + processing) > fee;
  return (
    <motion.div className="receipt" ref={ref} initial={{ y: -40, opacity: 0 }} animate={inView ? { y: 0, opacity: 1 } : {}} transition={{ duration: 0.9, ease }}>
      <div className="rc-head"><img src="/logo.png" alt="" width={34} height={34} /><b>RELAY</b><span>What you pay</span></div>
      <div className="rc-rule" />
      <div className="rc-line total"><span>Setup</span><em>₦0</em></div>
      <div className="rc-line total"><span>Monthly fee</span><em>₦0</em></div>
      <div className="rc-rule dashed" />
      <div className="rc-calc">
        <label htmlFor="ov">When you sell an order of</label>
        <b className="rc-amt">{naira(order)}</b>
        <input id="ov" type="range" min={1000} max={400000} step={500} value={order} onChange={e => setOrder(Number(e.target.value))} style={{ ['--p' as string]: `${((order - 1000) / 399000) * 100}%` }} />
        <div className="rc-line"><span>Relay fee 4.5%{capped ? ' (capped)' : ''}</span><em>{naira(fee)}</em></div>
        <div className="rc-line"><span>Payments and receipts</span><em>included</em></div>
        <div className="rc-line big"><span>You keep</span><em>{naira(order - fee)}</em></div>
      </div>
      <div className="rc-rule dashed" />
      <p className="rc-foot">Paid orders only, at most ₦4,000 per order<br />Withdrawals to your bank are free</p>
      <div className="rc-barcode" aria-hidden>{Array.from({ length: 46 }, (_, i) => <i key={i} style={{ width: [1, 2, 3, 1, 2][i % 5] }} />)}</div>
    </motion.div>
  );
}

// ── How a payment is matched: only real money marks an order paid ──
export function PaymentMatch() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { once: true, amount: 0.4 });
  const step = (d: number) => ({ initial: { opacity: 0, y: 16 }, animate: inView ? { opacity: 1, y: 0 } : {}, transition: { duration: 0.6, delay: d, ease } });
  return (
    <div className="match" ref={ref}>
      <motion.div className="m-card" {...step(0)}><small>Order RLY-9QX4T asks for</small><b>₦12,500<span>.37</span></b><p>Each order gets its own exact amount.</p></motion.div>
      <motion.div className="m-arrow" {...step(0.25)}><span>→</span></motion.div>
      <motion.div className="m-card" {...step(0.4)}><small>Your account receives</small><b>₦12,500<span>.37</span> arrived</b><p>Confirmed by the bank, not by the customer.</p></motion.div>
      <motion.div className="m-arrow" {...step(0.65)}><span>→</span></motion.div>
      <motion.div className="m-card ok" {...step(0.8)}><small>Relay</small><b>Paid ✓</b><p>Your customer gets a receipt. You get the money.</p></motion.div>
      <motion.div className="m-fake" {...step(1.1)}>
        <span className="m-x">✕</span>
        <div><b>Screenshots and “I’ve paid” messages</b><p>They never mark your order paid.</p></div>
      </motion.div>
    </div>
  );
}
