import { Bell, Clock3, Send, Smartphone, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { auth } from '@/lib/firebase';

type PushSegment = string;
type AudienceCounts = Record<string, number> & { lists?: { id: string; name: string; count: number }[] };
type PushCampaign = { id: string; title: string; body: string; segment: PushSegment; sentCount: number; failedCount: number; createdAt: string };
type CampaignPalette = { id: string; name: string; background: string; text: string; mutedText: string; accent: string; ctaBackground: string; ctaText: string };

const campaignPalettes: CampaignPalette[] = [
  { id: 'ocean', name: 'Ocean', background: '#EAF4FF', text: '#102A43', mutedText: '#486581', accent: '#1D4ED8', ctaBackground: '#1D4ED8', ctaText: '#FFFFFF' },
  { id: 'forest', name: 'Forest', background: '#ECFDF3', text: '#123524', mutedText: '#4D6B5B', accent: '#15803D', ctaBackground: '#15803D', ctaText: '#FFFFFF' },
  { id: 'sunset', name: 'Sunset', background: '#FFF4E6', text: '#4A1D0B', mutedText: '#8A4B2A', accent: '#EA580C', ctaBackground: '#EA580C', ctaText: '#FFFFFF' },
  { id: 'berry', name: 'Berry', background: '#FFF1F8', text: '#4A1231', mutedText: '#8C3A68', accent: '#BE185D', ctaBackground: '#BE185D', ctaText: '#FFFFFF' },
  { id: 'midnight', name: 'Midnight', background: '#172033', text: '#F8FAFC', mutedText: '#B7C3D9', accent: '#A3E635', ctaBackground: '#A3E635', ctaText: '#172033' },
];
function Sheet({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 bg-ink/30 p-3 sm:p-5"><section className="mx-auto max-h-full w-full max-w-lg overflow-y-auto rounded-[24px] bg-card p-4 shadow-2xl"><button onClick={onClose} className="float-right" aria-label="Close"><X size={20} /></button>{children}</section></div>;
}

export default function Marketing() {
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [cta, setCta] = useState(false);
  const [ctaUrl, setCtaUrl] = useState('');
  const [ctaTitle, setCtaTitle] = useState('');
  const [paletteId, setPaletteId] = useState('ocean');
  const [manageAudiencesOpen, setManageAudiencesOpen] = useState(false);
  const [customAudiences, setCustomAudiences] = useState<{ id: string; name: string }[]>([]);
  const [newAudienceName, setNewAudienceName] = useState('');
  const [newAudienceCustomerIds, setNewAudienceCustomerIds] = useState('');
  const [segment, setSegment] = useState<PushSegment>('all_opted_in');
  const [inactiveDays, setInactiveDays] = useState(60);
  const [audience, setAudience] = useState<AudienceCounts | null>(null);
  const [campaigns, setCampaigns] = useState<PushCampaign[]>([]);
  const [pushSending, setPushSending] = useState(false);
  const palette = campaignPalettes.find(item => item.id === paletteId) ?? campaignPalettes[0];
  const businessId = typeof window !== 'undefined' ? localStorage.getItem('relay_business_id') || import.meta.env.VITE_BUSINESS_ID : undefined;
  const apiUrl = import.meta.env.VITE_API_URL || 'http://localhost:4000';
  const loadPushData = async () => {
    if (!businessId) return;
    const token = await auth?.currentUser?.getIdToken();
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}`, 'x-business-id': businessId };
    const [audienceResponse, campaignResponse] = await Promise.all([
      fetch(`${apiUrl}/api/v1/businesses/${businessId}/campaigns/push/audiences`, { headers }),
      fetch(`${apiUrl}/api/v1/businesses/${businessId}/campaigns/push`, { headers }),
    ]);
    if (audienceResponse.ok) {
      const audPayload = await audienceResponse.json();
      setAudience(audPayload.data ?? audPayload);
      // If the endpoint returns an array of custom lists under data.lists, map them.
      if (Array.isArray(audPayload.data?.lists)) setCustomAudiences(audPayload.data.lists.map((l: any) => ({ id: l.id, name: l.name })));
      // Some implementations may return lists at top-level
      if (Array.isArray(audPayload.lists)) setCustomAudiences(audPayload.lists.map((l: any) => ({ id: l.id, name: l.name })));
    }
    if (campaignResponse.ok) setCampaigns((await campaignResponse.json()).data);
  };
  useEffect(() => { void loadPushData(); }, []);
  const sendPush = async (test = false) => {
    if (!businessId) { setNotice('Select a business before sending a push campaign.'); return; }
    const token = await auth?.currentUser?.getIdToken();
    if (!token) { setNotice('Sign in to send push campaigns.'); return; }
    setPushSending(true);
    try {
      const response = await fetch(`${apiUrl}/api/v1/businesses/${businessId}/${test ? 'notifications/test' : 'campaigns/push/send'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-business-id': businessId, 'Content-Type': 'application/json' },
        body: test ? '{}' : JSON.stringify({ segment, title, body: message, deepLink: cta ? ctaUrl : undefined, inactiveDays: segment === 'inactive' ? inactiveDays : undefined, ctaTitle: cta ? ctaTitle : undefined, ctaColor: cta ? palette.ctaBackground : undefined, palette: palette.id }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || 'Unable to send push campaign.');
      if (test) setNotice(`Test notification sent to ${payload.data.sent} subscribed device${payload.data.sent === 1 ? '' : 's'}.`);
      else { setNotice(`Campaign sent to ${payload.data.sent} subscribed device${payload.data.sent === 1 ? '' : 's'}.`); setTitle(''); setMessage(''); setCta(false); setCtaUrl(''); setCtaTitle(''); setPaletteId('ocean'); void loadPushData(); }
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Unable to send push campaign.'); }
    finally { setPushSending(false); }
  };

  const createAudience = async () => {
    if (!businessId) { setNotice('Select a business before creating an audience.'); return; }
    if (!newAudienceName.trim()) { setNotice('Enter a name for the audience list.'); return; }
    try {
      const token = await auth?.currentUser?.getIdToken();
      if (!token) { setNotice('Sign in to create audience lists.'); return; }
      const response = await fetch(`${apiUrl}/api/v1/businesses/${businessId}/campaigns/push/audiences`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-business-id': businessId, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newAudienceName, customerIds: newAudienceCustomerIds.split(',').map(id => id.trim()).filter(Boolean) }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error?.message || 'Unable to create audience.');
      // add to local list and reload counts
      setCustomAudiences(prev => [...prev, { id: payload.data.id || payload.data.name, name: payload.data.name }]);
      setNewAudienceName('');
      setNewAudienceCustomerIds('');
      setManageAudiencesOpen(false);
      void loadPushData();
      setNotice('Audience list created.');
    } catch (err) { setNotice(err instanceof Error ? err.message : 'Unable to create audience.'); }
  };
  const pushReady = Boolean(title.trim() && message.trim() && title.length <= 80 && message.length <= 240 && (!cta || (ctaUrl.trim() && ctaTitle.trim())));

  return <div className="h-full overflow-y-auto bg-surface-alt/30"><div className="mx-auto max-w-5xl p-3 pb-20 md:p-6">
    {notice && <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-xs">{notice}</p>}
    <section className="mt-3 rounded-[22px] border border-border/50 bg-card p-3 shadow-soft sm:p-4">
      <div className="flex items-center gap-2"><Bell size={18} /><div><h2 className="font-extrabold">Push campaign</h2><p className="text-xs text-muted-foreground">Send a web push notification to customers who opted in.</p></div></div>
      <div className="mt-4 rounded-xl bg-muted p-3">
        <div className="flex items-center gap-2 text-sm font-extrabold"><Users size={16} />Audience</div>
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          {([['all_opted_in', 'All subscribers'], ['recent_purchasers', 'Recent purchasers'], ['inactive', 'Inactive customers']] as [PushSegment, string][])
            .concat(customAudiences.map(a => [a.id, a.name] as [PushSegment, string]))
            .map(([value, label]) => (
              <button type="button" key={value} onClick={() => setSegment(value)} className={`rounded-lg border p-2 text-left text-xs font-bold ${segment === value ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground'}`}>
                <span className="block">{label}</span>
                <span className={`mt-1 block text-[11px] ${segment === value ? 'text-primary-foreground/75' : 'text-muted-foreground'}`}>{audience ? `${audience[value] ?? 0} subscribed` : 'Loading audience…'}</span>
              </button>
            ))}
        </div>
        {segment === 'inactive' && <label className="mt-3 flex items-center gap-2 text-xs font-bold">Inactive for at least <input type="number" min="1" value={inactiveDays} onChange={event => setInactiveDays(Math.max(1, Number(event.target.value) || 1))} className="h-8 w-16 rounded-lg border border-border bg-card px-2 text-sm" /> days</label>}
        <div className="mt-3 flex items-center justify-between gap-2"><button onClick={() => setManageAudiencesOpen(true)} className="rounded-lg border border-border px-3 py-1.5 text-xs font-bold">Manage lists</button><p className="text-xs text-muted-foreground">Create custom lists to target specific customers.</p></div>
      </div>
      <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_16rem]">
        <div>
          <label className="text-xs font-bold text-muted-foreground">Notification title <span className="float-right">{title.length}/80</span></label>
          <input value={title} maxLength={80} onChange={event => setTitle(event.target.value)} placeholder="e.g. Your weekend offer is here" className="mt-1 h-10 w-full rounded-lg border border-border px-3 text-sm" />
          <label className="mt-3 block text-xs font-bold text-muted-foreground">Message <span className="float-right">{message.length}/240</span></label>
          <textarea value={message} maxLength={240} onChange={event => setMessage(event.target.value)} placeholder="Write a clear, helpful message for your customers." className="mt-1 h-24 w-full resize-none rounded-lg border border-border p-3 text-sm" />
          <fieldset className="mt-3"><legend className="text-xs font-bold text-muted-foreground">Campaign color palette</legend><div className="mt-2 flex flex-wrap gap-2">{campaignPalettes.map(item => <button type="button" key={item.id} onClick={() => setPaletteId(item.id)} aria-pressed={paletteId === item.id} className={`rounded-lg border p-1.5 text-left ${paletteId === item.id ? 'border-primary ring-2 ring-primary/25' : 'border-border'}`}><span className="flex overflow-hidden rounded"><i className="h-4 w-4" style={{ backgroundColor: item.background }} /><i className="h-4 w-4" style={{ backgroundColor: item.text }} /><i className="h-4 w-4" style={{ backgroundColor: item.ctaBackground }} /></span><span className="mt-1 block text-[10px] font-bold">{item.name}</span></button>)}</div></fieldset>
          <label className="mt-3 flex items-center gap-2 text-sm font-bold"><input type="checkbox" checked={cta} onChange={event => setCta(event.target.checked)} />Add a call to action</label>
          {cta && <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_9rem]">
            <input value={ctaUrl} type="url" onChange={event => setCtaUrl(event.target.value)} placeholder="https://your-store.com/offers" className="h-9 w-full rounded-lg border border-border px-2 text-sm sm:col-span-2" />
            <input value={ctaTitle} maxLength={30} onChange={event => setCtaTitle(event.target.value)} placeholder="CTA title, e.g. View offer" className="h-9 w-full rounded-lg border border-border px-2 text-sm" />
            <span className="flex h-9 items-center rounded-lg border border-border px-2 text-xs font-bold" style={{ color: palette.ctaBackground }}>Uses {palette.name}</span>
          </div>}
        </div>
        <aside className="rounded-2xl bg-ink p-4 text-white"><div className="flex items-center gap-2 text-xs font-bold text-white/60"><Smartphone size={15} />NOTIFICATION PREVIEW</div><div className="mt-4 rounded-2xl p-3 shadow-lg" style={{ backgroundColor: palette.background, color: palette.text }}><div className="flex gap-2"><div className="flex h-8 w-8 flex-none items-center justify-center rounded-lg" style={{ backgroundColor: palette.accent, color: palette.ctaText }}><Bell size={15} /></div><div className="min-w-0"><p className="text-xs font-extrabold">{title || 'Campaign title'}</p><p className="mt-1 text-xs leading-4" style={{ color: palette.mutedText }}>{message || 'Your notification message will appear here.'}</p>{cta && <span className="mt-3 inline-flex rounded-md px-2.5 py-1 text-[11px] font-extrabold" style={{ backgroundColor: palette.ctaBackground, color: palette.ctaText }}>{ctaTitle || 'Your CTA title'}</span>}</div></div></div><p className="mt-3 text-xs leading-5 text-white/65">Push campaigns send immediately. Scheduling is not enabled yet.</p></aside>
      </div>
      <div className="mt-4 flex flex-col gap-2 sm:flex-row"><button type="button" onClick={() => sendPush(true)} disabled={pushSending || !businessId} className="flex-1 rounded-lg border border-border py-2.5 text-sm font-extrabold disabled:opacity-50"><Smartphone size={15} className="mr-1 inline" />Send test</button><button disabled={!pushReady || pushSending || !businessId} onClick={() => sendPush()} className="flex-1 rounded-lg bg-ink py-2.5 text-sm font-extrabold text-white disabled:opacity-50"><Send size={15} className="mr-1 inline" />{pushSending ? 'Sending…' : `Send to ${audience ? audience[segment] : 'audience'}`}</button></div>
      <div className="mt-5 border-t border-border pt-4"><div className="flex items-center gap-2"><Clock3 size={16} /><h3 className="text-sm font-extrabold">Recent push campaigns</h3></div>{campaigns.length ? <div className="mt-3 space-y-2">{campaigns.slice(0, 5).map(campaign => <div key={campaign.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted px-3 py-2 text-xs"><div className="min-w-0"><p className="truncate font-bold">{campaign.title}</p><p className="mt-0.5 text-muted-foreground">{new Date(campaign.createdAt).toLocaleDateString()} · {campaign.segment.replaceAll('_', ' ')}</p></div><span className="flex-none font-extrabold text-primary">{campaign.sentCount} sent</span></div>)}</div> : <p className="mt-3 text-xs text-muted-foreground">No push campaigns sent yet.</p>}</div>
    </section>
      {manageAudiencesOpen && <Sheet onClose={() => setManageAudiencesOpen(false)}>
        <h2 className="text-lg font-extrabold">Create audience list</h2>
        <p className="mt-2 text-sm text-muted-foreground">Save a named list of customer IDs to target with future push campaigns.</p>
        <input value={newAudienceName} onChange={e => setNewAudienceName(e.target.value)} placeholder="List name" className="mt-3 h-9 w-full rounded-lg border border-border px-2 text-sm" />
        <textarea value={newAudienceCustomerIds} onChange={e => setNewAudienceCustomerIds(e.target.value)} placeholder="Customer IDs, comma-separated (optional)" className="mt-2 h-20 w-full resize-none rounded-lg border border-border p-2 text-sm" />
        <p className="mt-1 text-xs text-muted-foreground">Only customers with push permission receive the campaign.</p>
        <div className="mt-3 flex justify-end gap-2"><button onClick={() => setManageAudiencesOpen(false)} className="rounded-lg border border-border px-3 py-1.5 text-xs">Cancel</button><button onClick={createAudience} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground">Create</button></div>
      </Sheet>}
  </div></div>;
}
