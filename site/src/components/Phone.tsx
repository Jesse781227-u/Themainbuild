// Device frames at their real CSS viewport sizes, scaled to fit the space they're given:
// Samsung Galaxy S24 (360 × 780, centred punch-hole camera) and iPhone 15 (393 × 852, Dynamic Island).
import { useEffect, useRef, useState, type ReactNode } from 'react';

export type Device = 'android' | 'iphone';

export const DEVICES = {
  android: { w: 360, h: 780, bezel: 9, frameRadius: 46, screenRadius: 38, statusH: 30 },
  iphone: { w: 393, h: 852, bezel: 13, frameRadius: 68, screenRadius: 55, statusH: 54 },
} as const;

export function Phone({ device, maxWidth = 320, children, label }: { device: Device; maxWidth?: number; children: ReactNode; label?: string }) {
  const d = DEVICES[device];
  const outerW = d.w + d.bezel * 2;
  const outerH = d.h + d.bezel * 2;
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(maxWidth);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.min(maxWidth, e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [maxWidth]);
  const scale = width / outerW;
  return (
    <div ref={box} className="phone-slot" style={{ maxWidth }} aria-label={label} role={label ? 'img' : undefined}>
      <div style={{ width, height: outerH * scale, position: 'relative' }}>
        <div className={`phone phone-${device}`} style={{ width: outerW, height: outerH, borderRadius: d.frameRadius, padding: d.bezel, transform: `scale(${scale})` }}>
          {device === 'android' ? <><i className="btn-side vol" /><i className="btn-side pwr" /></> : <><i className="btn-side mute" /><i className="btn-side vup" /><i className="btn-side vdn" /><i className="btn-side pwr" /></>}
          <div className="screen" style={{ width: d.w, height: d.h, borderRadius: d.screenRadius }}>
            {children}
            {device === 'android' ? <i className="punch" /> : <><i className="island" /><i className="home-bar" /></>}
            <i className="glare" />
          </div>
        </div>
      </div>
    </div>
  );
}

const Wifi = ({ c }: { c: string }) => <svg width="16" height="12" viewBox="0 0 16 12"><path fill={c} d="M8 11.5 0.6 3.9A10.6 10.6 0 0 1 8 1a10.6 10.6 0 0 1 7.4 2.9z" /></svg>;
const Signal = ({ c }: { c: string }) => <svg width="16" height="12" viewBox="0 0 16 12"><path fill={c} d="M15 0v12H1z" /></svg>;
const Battery = ({ c, ios }: { c: string; ios?: boolean }) => ios
  ? <svg width="27" height="13" viewBox="0 0 27 13"><rect x=".5" y=".5" width="23" height="12" rx="3.8" fill="none" stroke={c} opacity=".4" /><rect x="2" y="2" width="17" height="9" rx="2.4" fill={c} /><path d="M25 4.5v4a2.2 2.2 0 0 0 0-4z" fill={c} opacity=".45" /></svg>
  : <svg width="9" height="15" viewBox="0 0 9 15"><rect x="2.5" width="4" height="2" rx=".5" fill={c} /><rect y="1.5" width="9" height="13.5" rx="1.5" fill={c} /></svg>;

export function StatusBar({ device, time, dark }: { device: Device; time: string; dark?: boolean }) {
  const c = dark ? '#fff' : '#111';
  if (device === 'iphone') {
    return (
      <div className="sb sb-ios" style={{ height: DEVICES.iphone.statusH, color: c }}>
        <span className="sb-time">{time}</span>
        <span className="sb-icons"><IosSignal c={c} /><IosWifi c={c} /><Battery c={c} ios /></span>
      </div>
    );
  }
  return (
    <div className="sb sb-android" style={{ height: DEVICES.android.statusH, color: c }}>
      <span className="sb-time">{time}</span>
      <span className="sb-icons"><Wifi c={c} /><Signal c={c} /><Battery c={c} /></span>
    </div>
  );
}

const IosSignal = ({ c }: { c: string }) => <svg width="18" height="12" viewBox="0 0 18 12">{[0, 1, 2, 3].map(i => <rect key={i} x={i * 4.8} y={9 - i * 3} width="3.2" height={3 + i * 3} rx="1" fill={c} />)}</svg>;
const IosWifi = ({ c }: { c: string }) => <svg width="17" height="12" viewBox="0 0 17 12"><path fill={c} d="M8.5 2.3c2.4 0 4.6.9 6.3 2.5l1.2-1.2A10.6 10.6 0 0 0 8.5.6 10.6 10.6 0 0 0 1 3.6l1.2 1.2a9 9 0 0 1 6.3-2.5zm0 3.4c1.5 0 2.9.6 3.9 1.5l1.2-1.2a7.3 7.3 0 0 0-10.2 0l1.2 1.2c1-.9 2.4-1.5 3.9-1.5zm0 3.4c.6 0 1.1.2 1.5.6L8.5 11.2 7 9.7c.4-.4.9-.6 1.5-.6z" /></svg>;
