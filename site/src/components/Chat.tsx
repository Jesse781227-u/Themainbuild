// A WhatsApp chat screen (Android or iOS styling) that plays a scripted conversation when it
// scrolls into view: typing first, then the message; ticks turn blue; it loops.
import { AnimatePresence, motion, useInView, useReducedMotion } from 'framer-motion';
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { StatusBar, type Device } from './Phone';

export type Msg = { side: 'in' | 'out'; time: string; wait?: number } & (
  | { kind: 'text'; text: string }
  | { kind: 'buttons'; text: string; buttons: string[] }
  | { kind: 'product'; title: string; price: string; photo: string; text: string; buttons?: string[] }
  | { kind: 'shot'; amount: string; to: string; caption?: string }
  | { kind: 'track'; text: string; steps: string[]; at: number; buttons?: string[] }
  | { kind: 'cta'; text: string; button: string }
  | { kind: 'list'; text: string; button: string }
  | { kind: 'doc'; name: string; meta: string; text?: string }
  | { kind: 'voice'; secs: number }
  | { kind: 'image'; art: 'menu'; caption?: string }
);

export interface ChatScript { device: Device; title: string; subtitle: string; avatar: ReactNode; clock: string; notice?: boolean; messages: Msg[] }

// *bold*, _italic_, line breaks: WhatsApp's own formatting.
function rich(text: string) {
  return text.split('\n').map((line, i, all) => (
    <Fragment key={i}>
      {line.split(/(\*[^*]+\*|_[^_]+_)/g).map((p, j) => p.startsWith('*') && p.endsWith('*') && p.length > 2 ? <strong key={j}>{p.slice(1, -1)}</strong> : p.startsWith('_') && p.endsWith('_') && p.length > 2 ? <em key={j}>{p.slice(1, -1)}</em> : p)}
      {i < all.length - 1 && <br />}
    </Fragment>
  ));
}

const Ticks = ({ read }: { read: boolean }) => (
  <svg className="ticks" width="16" height="11" viewBox="0 0 16 11"><path fill={read ? '#53BDEB' : '#8696A0'} d="M11.07.65 10.4.1a.4.4 0 0 0-.58.07L4.6 6.72 2.57 4.97a.4.4 0 0 0-.56.04l-.54.62a.4.4 0 0 0 .04.57l2.86 2.47a.4.4 0 0 0 .58-.06l6.17-7.4a.4.4 0 0 0-.05-.56zm3.9 0L14.3.1a.4.4 0 0 0-.58.07L8.5 6.72l-.6-.52-.94 1.13 1.32 1.14a.4.4 0 0 0 .58-.06l6.17-7.4a.4.4 0 0 0-.05-.56z" /></svg>
);

function Meta({ m, read }: { m: Msg; read: boolean }) {
  return <span className="meta">{m.time}{m.side === 'out' && <Ticks read={read} />}</span>;
}

const ReplyIcon = () => <svg width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" /></svg>;
const LinkIcon = () => <svg width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" d="M14 3v2h3.6l-9.8 9.8 1.4 1.4L19 6.4V10h2V3h-7zm5 16H5V5h7V3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-7h-2v7z" /></svg>;
const ListIcon = () => <svg width="15" height="15" viewBox="0 0 24 24"><path fill="currentColor" d="M3 13h2v-2H3v2zm0 4h2v-2H3v2zm0-8h2V7H3v2zm4 4h14v-2H7v2zm0 4h14v-2H7v2zM7 7v2h14V7H7z" /></svg>;

function Photo({ src }: { src: string }) {
  return <div className="art"><img src={src} alt="" loading="lazy" /></div>;
}

function Bubble({ m, first, read }: { m: Msg; first: boolean; read: boolean }) {
  const cls = `bubble ${m.side}${first ? ' tail' : ''}`;
  switch (m.kind) {
    case 'text':
      return <div className={cls}><span className="txt">{rich(m.text)}</span><Meta m={m} read={read} /></div>;
    case 'product':
      return (
        <div className="group">
          <div className={`${cls} media`}><Photo src={m.photo} /><div className="prod"><b>{m.title}</b><span>{m.price}</span></div><span className="txt">{rich(m.text)}</span><Meta m={m} read={read} /></div>
          {m.buttons?.map(b => <div key={b} className="wa-btn"><ReplyIcon />{b}</div>)}
        </div>
      );
    case 'shot':
      // A customer's "proof of payment" screenshot from a bank app.
      return (
        <div className={`${cls} media`}>
          <div className="shot"><div className="shot-top"><span>9:41</span><span>●●● 4G</span></div><div className="shot-ok">✓</div><b>Transfer Successful</b><div className="shot-amt">{m.amount}</div><span>To {m.to}</span><span className="shot-ref">Ref: 000013251120094112</span></div>
          {m.caption && <span className="txt">{m.caption}</span>}<Meta m={m} read={read} />
        </div>
      );
    case 'track':
      return (
        <div className="group">
          <div className={cls}>
            <span className="txt">{rich(m.text)}</span>
            <div className="trk">{m.steps.map((st, i) => <div key={st} className={`trk-s${i < m.at ? ' done' : ''}${i === m.at ? ' now' : ''}`}><i />{st}</div>)}</div>
            <Meta m={m} read={read} />
          </div>
          {m.buttons?.map(b => <div key={b} className="wa-btn"><ReplyIcon />{b}</div>)}
        </div>
      );
    case 'buttons':
      return <div className="group"><div className={cls}><span className="txt">{rich(m.text)}</span><Meta m={m} read={read} /></div>{m.buttons.map(b => <div key={b} className="wa-btn"><ReplyIcon />{b}</div>)}</div>;
    case 'cta':
      return <div className="group"><div className={cls}><span className="txt">{rich(m.text)}</span><Meta m={m} read={read} /></div><div className="wa-btn"><LinkIcon />{m.button}</div></div>;
    case 'list':
      return <div className="group"><div className={cls}><span className="txt">{rich(m.text)}</span><Meta m={m} read={read} /></div><div className="wa-btn"><ListIcon />{m.button}</div></div>;
    case 'doc':
      return (
        <div className={`${cls} media`}>
          <div className="doc"><div className="pdf">PDF</div><div><b>{m.name}</b><span>{m.meta}</span></div></div>
          {m.text && <span className="txt">{rich(m.text)}</span>}<Meta m={m} read={read} />
        </div>
      );
    case 'voice':
      return (
        <div className={`${cls} voice`}>
          <svg width="22" height="22" viewBox="0 0 24 24"><path fill="#54656F" d="M8 5v14l11-7z" /></svg>
          <div className="wave">{Array.from({ length: 28 }, (_, i) => <i key={i} style={{ height: 4 + Math.abs(Math.sin(i * 1.7) * 14) + (i % 3) * 2 }} />)}</div>
          <div className="vavatar">A</div>
          <span className="vlen">0:{String(m.secs).padStart(2, '0')}</span><Meta m={m} read={read} />
        </div>
      );
    case 'image':
      return (
        <div className={`${cls} media`}>
          <div className="menu-photo"><b>MENU</b>{['Jollof Rice + Chicken ....... 4,500', 'Fried Rice + Turkey ......... 5,500', 'Ofada Sauce + Rice ........... 4,000', 'Zobo (50cl) ............................... 800', 'Small Chops (10) .............. 3,000'].map(l => <span key={l}>{l}</span>)}</div>
          {m.caption && <span className="txt">{m.caption}</span>}<Meta m={m} read={read} />
        </div>
      );
  }
}

const Back = ({ c }: { c: string }) => <svg width="24" height="24" viewBox="0 0 24 24"><path fill={c} d="M20 11H7.8l5.6-5.6L12 4l-8 8 8 8 1.4-1.4L7.8 13H20z" /></svg>;
const Icon = ({ d, c, s = 24 }: { d: string; c: string; s?: number }) => <svg width={s} height={s} viewBox="0 0 24 24"><path fill={c} d={d} /></svg>;
const VIDEO = 'M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z';
const CALL = 'M20 15.5c-1.25 0-2.45-.2-3.57-.57a1 1 0 0 0-1.02.24l-2.2 2.2a15.07 15.07 0 0 1-6.59-6.59l2.2-2.21a.96.96 0 0 0 .25-1A11.36 11.36 0 0 1 8.5 4a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1 17 17 0 0 0 17 17 1 1 0 0 0 1-1v-3.5a1 1 0 0 0-1-1z';
const DOTS = 'M12 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm0 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z';
const MIC = 'M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5.3-3a5.3 5.3 0 0 1-10.6 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-1.7z';

function Header({ s, typing }: { s: ChatScript; typing: boolean }) {
  const sub = typing ? 'typing…' : s.subtitle;
  if (s.device === 'iphone') {
    return (
      <div className="hd hd-ios">
        <svg width="12" height="20" viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" stroke="#007AFF" strokeWidth="2.6" fill="none" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="av">{s.avatar}</div>
        <div className="who"><b>{s.title}</b><span className={typing ? 'typing' : ''}>{sub}</span></div>
        <Icon d={VIDEO} c="#007AFF" /><Icon d={CALL} c="#007AFF" s={21} />
      </div>
    );
  }
  return (
    <div className="hd hd-android">
      <Back c="#111B21" />
      <div className="av">{s.avatar}</div>
      <div className="who"><b>{s.title}</b><span className={typing ? 'typing' : ''}>{sub}</span></div>
      <Icon d={VIDEO} c="#54656F" /><Icon d={CALL} c="#54656F" s={21} /><Icon d={DOTS} c="#54656F" />
    </div>
  );
}

function Composer({ device }: { device: Device }) {
  if (device === 'iphone') {
    return (
      <div className="cp cp-ios">
        <span className="plus">+</span><div className="field" /><Icon d="M9 3 7.2 5H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9zm3 15a5 5 0 1 1 0-10 5 5 0 0 1 0 10z" c="#007AFF" /><Icon d={MIC} c="#007AFF" />
      </div>
    );
  }
  return (
    <div className="cp cp-android">
      <div className="cp-pill"><span className="emoji">☺</span><span className="ph">Message</span><span className="clip">📎</span><span className="cam">📷</span></div>
      <div className="mic"><Icon d={MIC} c="#fff" /></div>
    </div>
  );
}

const TypingDots = () => (
  <motion.div className="bubble in tail typing-bubble" initial={{ y: 8, scale: 0.9 }} animate={{ y: 0, scale: 1 }}>
    {[0, 1, 2].map(i => <motion.i key={i} animate={{ y: [0, -4, 0], opacity: [0.4, 1, 0.4] }} transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15 }} />)}
  </motion.div>
);

export function Chat({ script, speed = 1, loop = true }: { script: ChatScript; speed?: number; loop?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.35 });
  const reduce = useReducedMotion();
  const all = script.messages;
  const [count, setCount] = useState(reduce ? all.length : 0);
  const [typing, setTyping] = useState(false);
  const [run, setRun] = useState(0);

  useEffect(() => {
    if (reduce) { setCount(all.length); return; }
    if (!inView) return;
    let cancelled = false;
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => timers.push(window.setTimeout(() => !cancelled && fn(), ms / speed));
    let t = 600;
    setCount(0);
    all.forEach((m, i) => {
      t += m.wait ?? (m.side === 'out' ? 1300 : 500);
      if (m.side === 'in') {
        at(t, () => setTyping(true));
        const len = 'text' in m && m.text ? m.text.length : 60;
        t += Math.min(1900, 700 + len * 9);
      }
      at(t, () => { setTyping(false); setCount(i + 1); });
    });
    if (loop) at(t + 5200, () => setRun(r => r + 1));
    return () => { cancelled = true; timers.forEach(clearTimeout); };
  }, [inView, run, reduce, all, speed, loop]);

  const shown = all.slice(0, count);
  return (
    <div className={`wa wa-${script.device}`} ref={ref}>
      <StatusBar device={script.device} time={script.clock} />
      <Header s={script} typing={typing} />
      <div className="body">
        <div className="wallpaper" />
        <div className="stack">
          <div className="chip">Today</div>
          {script.notice && <div className="chip notice">🔒 This business uses a secure service from Meta to manage this chat. Tap to learn more.</div>}
          <AnimatePresence initial={false}>
            {shown.map((m, i) => {
              const prev = shown[i - 1];
              const first = !prev || prev.side !== m.side;
              // An out message is "read" once the shop has replied after it.
              const read = m.side === 'out' && (shown.slice(i + 1).some(n => n.side === 'in') || (typing && i === shown.length - 1));
              return (
                <motion.div key={`${run}-${i}`} layout className={`row ${m.side}${first ? ' gap' : ''}`}
                  initial={{ opacity: 0, y: 14, scale: 0.96 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 420, damping: 32 }} style={{ originX: m.side === 'out' ? 1 : 0, originY: 1 }}>
                  <Bubble m={m} first={first} read={read} />
                </motion.div>
              );
            })}
            {typing && <motion.div key="typing" className="row in gap" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0 } }}><TypingDots /></motion.div>}
          </AnimatePresence>
        </div>
      </div>
      <Composer device={script.device} />
    </div>
  );
}
