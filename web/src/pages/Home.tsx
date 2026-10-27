import {useQuery} from '@tanstack/react-query';
import {Activity,ArrowDownRight,ArrowUpRight,BarChart3,ChevronRight,Users} from 'lucide-react';
import {useEffect,useMemo,useState} from 'react';
import {Bar,BarChart,CartesianGrid,ResponsiveContainer,Tooltip,XAxis,YAxis} from 'recharts';
import {Link} from 'wouter';
import {auth} from '@/lib/firebase';
import {apiBase} from '@/lib/api-base';
import {businessInitials,readBusinessProfile} from '@/lib/business-profile';

type Tab='overview'|'analytic';
type AnalyticPeriod='day'|'week'|'month'|'quarter';
type AnalyticMetric='revenue'|'orders';
type DashboardData={businessName:string;hero?:{overview?:number;weekly?:number;projected?:number;currency:string;comparison?:{value:number;period:string};weeklyComparison?:{value:number;period:string};analyticComparison?:{value:number;period:string}};revenueTrend?:Array<{label:string;value:number}>;weeklyActivity?:Array<{label:string;value:number}>;analyticTrend?:Record<AnalyticPeriod,Array<{label:string;revenue:number;orders:number}>>;recentOrders?:Array<{id:string;customerName:string;relativeTime:string;itemCount:number;total:number;status:string}>;topMovers?:Array<{name:string;orders:number;revenue:number}>;needsAttention?:Array<{id:string;name:string;condition:string}>;target?:{value:number;period:string;reached:number};audience?:{total:number;active:number;newCustomers:number;inactive:number};topCategories?:Array<{name:string;share:number}>};

async function loadDashboard():Promise<DashboardData|null>{
  const businessId=typeof window!=='undefined'?(localStorage.getItem('relay_business_id')||import.meta.env.VITE_BUSINESS_ID):undefined;
  if(!businessId)return null;
  const token=await auth?.currentUser?.getIdToken();
  if(!token)return null;
  const response=await fetch(`${apiBase}/api/v1/businesses/${businessId}/dashboard`,{headers:{Authorization:`Bearer ${token}`,'x-business-id':businessId}});
  if(!response.ok)throw new Error('Dashboard data unavailable');
  const payload=await response.json();
  return payload.data as DashboardData;
}

const money=(value:number|undefined,currency='NGN')=>value===undefined?'—':new Intl.NumberFormat('en-NG',{style:'currency',currency,maximumFractionDigits:0}).format(value);
const hasItems=(items:unknown[]|undefined)=>Boolean(items?.length);

function EmptyCard({title,children,className='' }:{title:string;children:React.ReactNode;className?:string}){return <section className={`rounded-[28px] border border-border/50 bg-card p-5 md:p-6 shadow-soft ${className}`}><div className="flex items-center justify-between mb-5"><h2 className="font-extrabold text-ink">{title}</h2></div>{children}</section>}
function NoData({message='No orders yet — they will show up here.'}:{message?:string}){return <div className="min-h-32 flex items-center justify-center rounded-2xl border border-dashed border-border px-5 text-center text-sm text-muted-foreground">{message}</div>}
function ChartFrame({message='No orders yet — there is not enough data to chart.'}:{message?:string}){return <div className="h-56 rounded-2xl border border-dashed border-border flex items-center justify-center text-center text-sm text-muted-foreground px-5">{message}</div>}
function AnalyticsChart({trend,currency}:{trend:DashboardData['analyticTrend'];currency:string}){
  const [metric,setMetric]=useState<AnalyticMetric>('revenue');
  const [period,setPeriod]=useState<AnalyticPeriod>('week');
  const points=trend?.[period]||[];
  const hasData=points.some(point=>point[metric]>0);
  return <section className="min-w-[min(92vw,48rem)] snap-start rounded-[28px] border border-border/50 bg-card p-5 md:p-6 shadow-soft"><div className="flex flex-wrap items-start justify-between gap-4 mb-5"><div><h2 className="font-extrabold text-ink">Performance</h2><p className="mt-1 text-sm text-muted-foreground">{metric==='revenue'?'Revenue':'Orders'} by {period}.</p></div><div className="flex rounded-full bg-muted p-1">{(['revenue','orders'] as AnalyticMetric[]).map(item=><button key={item} type="button" aria-pressed={metric===item} onClick={()=>setMetric(item)} className={`rounded-full px-3 py-1.5 text-xs font-extrabold transition-colors ${metric===item?'bg-primary text-primary-foreground':'text-muted-foreground'}`}>{item==='revenue'?'Revenue':'Orders'}</button>)}</div></div><div className="flex flex-wrap gap-2 mb-5">{(['day','week','month','quarter'] as AnalyticPeriod[]).map(item=><button key={item} type="button" aria-pressed={period===item} onClick={()=>setPeriod(item)} className={`rounded-full border px-3 py-1.5 text-xs font-extrabold capitalize transition-colors ${period===item?'border-primary bg-primary text-primary-foreground':'border-border bg-card text-muted-foreground hover:bg-muted'}`}>{item}</button>)}</div>{hasData?<div className="h-64"><ResponsiveContainer width="100%" height="100%"><BarChart data={points} margin={{top:8,right:4,left:-16,bottom:0}}><CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="3 3"/><XAxis dataKey="label" tickLine={false} axisLine={false} tick={{fontSize:11}} interval="preserveStartEnd"/><YAxis tickLine={false} axisLine={false} tick={{fontSize:11}} tickFormatter={value=>metric==='revenue'?`${value>=1000?`${Math.round(value/1000)}k`:value}`:String(value)}/><Tooltip cursor={{fill:'hsl(var(--muted))'}} formatter={value=>metric==='revenue'?money(Number(value),currency):`${value} orders`}/><Bar dataKey={metric} fill="hsl(var(--primary))" radius={[8,8,0,0]}/></BarChart></ResponsiveContainer></div>:<NoData message={`No ${metric==='revenue'?'paid revenue':'paid orders'} recorded for this ${period} yet.`}/>}</section>;
}

export default function Home(){
  const [tab,setTab]=useState<Tab>('overview');
  const [ownerName,setOwnerName]=useState('');
  const [businessProfile,setBusinessProfile]=useState(readBusinessProfile);
  const {data,isLoading}=useQuery({queryKey:['dashboard'],queryFn:loadDashboard,staleTime:60000,retry:false});
  useEffect(()=>{const stored=localStorage.getItem('relay_owner_name')||auth?.currentUser?.displayName||'';setOwnerName(stored);const refreshProfile=()=>setBusinessProfile(readBusinessProfile());window.addEventListener('relay-business-profile',refreshProfile);return()=>window.removeEventListener('relay-business-profile',refreshProfile);},[]);
  const currency=data?.hero?.currency||'NGN';
  const config=useMemo(()=>({overview:{period:'Current week',label:"This Week's Revenue",value:data?.hero?.weekly,comparison:data?.hero?.weeklyComparison},analytic:{period:'Current quarter',label:'Projected Revenue',value:data?.hero?.projected,comparison:data?.hero?.analyticComparison}}[tab]),[data,tab]);

  return <div className="h-full overflow-y-auto bg-surface-alt/30"><div className="max-w-7xl mx-auto p-4 md:p-8 pb-24">
    <div className="mb-6 flex items-center justify-between gap-4"><div><p className="text-xs font-extrabold uppercase tracking-[0.18em] text-primary">Welcome,</p><h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-ink mt-2">{ownerName||'Dashboard'}</h1></div><Link href="/more" aria-label="Open business profile" className="group flex h-12 w-12 flex-none items-center justify-center overflow-hidden rounded-2xl border border-border bg-card shadow-soft transition-transform hover:-translate-y-0.5"><span className="sr-only">Open business profile</span>{businessProfile?.logo?<img src={businessProfile.logo} alt={`${businessProfile.businessName} logo`} className="h-full w-full object-cover"/>:<span className="text-sm font-extrabold text-ink">{businessInitials(businessProfile?.businessName||'Relay')}</span>}</Link></div>
    <section className="rounded-[30px] bg-ink p-6 md:p-8 text-white shadow-[0_18px_40px_rgba(22,33,62,0.22)]"><div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-2"><h2 className="text-lg font-extrabold">{data?.businessName||'Your business'}</h2><span className="rounded-full bg-white/10 px-3 py-1 text-xs font-bold">{config.period}</span></div><p className="mt-8 text-sm text-white/65">{config.label}</p><p className="mt-1 text-4xl md:text-5xl font-extrabold tracking-tight">{isLoading?'…':money(config.value,currency)}</p></div>{config.comparison?<div className={`rounded-full px-3 py-2 text-xs font-extrabold ${config.comparison.value>=0?'bg-lime text-ink':'bg-red-400/20 text-red-100'}`}>{config.comparison.value>=0?<ArrowUpRight size={14} className="inline"/>:<ArrowDownRight size={14} className="inline"/>} {Math.abs(config.comparison.value).toFixed(1)}% vs {config.comparison.period}</div>:<span className="rounded-full bg-white/10 px-3 py-2 text-xs font-bold text-white/65">No prior data</span>}</div></section>
    <div className="mt-5 flex gap-2 rounded-full bg-card p-1.5 w-fit border border-border/50">{(['overview','analytic'] as Tab[]).map(item=><button key={item} onClick={()=>setTab(item)} className={`rounded-full px-4 py-2 text-sm font-extrabold transition-colors ${tab===item?'bg-primary text-primary-foreground':'text-muted-foreground hover:text-foreground'}`}>{item==='overview'?'Overview':'Analytic'}</button>)}</div>
    {tab==='overview'&&<div className="mt-5 flex gap-5 overflow-x-auto pb-3 snap-x snap-mandatory [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <EmptyCard title="Recent Orders" className="min-w-[min(86vw,32rem)] snap-start"><div className="flex justify-end -mt-10 mb-4"><Link href="/shop" className="text-xs font-extrabold text-primary flex items-center">View all<ChevronRight size={14}/></Link></div>{hasItems(data?.recentOrders)?<div className="space-y-3">{data!.recentOrders!.map(order=><div key={order.id} className="flex items-center justify-between gap-3 rounded-2xl bg-muted p-3"><div><p className="font-bold text-sm">{order.customerName}</p><p className="text-xs text-muted-foreground">{order.relativeTime} · {order.itemCount} items</p></div><div className="text-right"><p className="font-extrabold text-sm">{money(order.total,currency)}</p><span className="text-[10px] font-bold uppercase text-muted-foreground">{order.status}</span></div></div>)}</div>:<NoData/>}</EmptyCard>
      <EmptyCard title="This Week's Activity" className="min-w-[min(86vw,38rem)] snap-start"><ChartFrame message="No weekly orders yet — activity will appear here."/></EmptyCard>
      <EmptyCard title="Top Movers This Week" className="min-w-[min(86vw,32rem)] snap-start">{hasItems(data?.topMovers)?<div className="space-y-3">{data!.topMovers!.map(item=><div key={item.name} className="flex justify-between rounded-2xl bg-muted p-3 text-sm"><span className="font-bold">{item.name}</span><span className="text-muted-foreground">{item.orders} orders · {money(item.revenue,currency)}</span></div>)}</div>:<NoData/>}</EmptyCard>
      <EmptyCard title="Busiest Day" className="min-w-[min(86vw,24rem)] snap-start"><NoData message="No weekly activity yet."/></EmptyCard>
      <EmptyCard title="Customer Mix" className="min-w-[min(86vw,24rem)] snap-start"><NoData message="Customer mix will appear after orders arrive."/></EmptyCard>
    </div>}
    {tab==='analytic'&&<div className="mt-5 flex gap-5 overflow-x-auto pb-3 snap-x snap-mandatory [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <AnalyticsChart trend={data?.analyticTrend} currency={currency}/>
      <EmptyCard title="Top Categories" className="min-w-[min(86vw,32rem)] snap-start">{hasItems(data?.topCategories)?<div className="space-y-4">{data!.topCategories!.map(item=><div key={item.name}><div className="flex justify-between text-sm font-bold"><span>{item.name}</span><span>{item.share}%</span></div><div className="h-2 mt-2 rounded-full bg-muted"><div className="h-full rounded-full bg-primary" style={{width:`${item.share}%`}}/></div></div>)}</div>:<NoData message="Categories will appear after paid orders."/>}</EmptyCard>
      <EmptyCard title="Goal Progress" className="min-w-[min(86vw,24rem)] snap-start">{data?.target?<div><p className="text-3xl font-extrabold">{Math.round((data.target.reached/data.target.value)*100)}%</p><div className="h-2 rounded-full bg-muted mt-4"><div className="h-full rounded-full bg-primary" style={{width:`${Math.min(100,(data.target.reached/data.target.value)*100)}%`}}/></div><p className="text-xs text-muted-foreground mt-3">{money(data.target.reached,currency)} of {money(data.target.value,currency)} target reached.</p></div>:<NoData message="Set a revenue target to track progress."/>}</EmptyCard>
      <EmptyCard title="Audience Base" className="min-w-[min(86vw,24rem)] snap-start"><NoData message="Audience segments will appear as customers arrive."/></EmptyCard>
    </div>}
  </div></div>;
}
