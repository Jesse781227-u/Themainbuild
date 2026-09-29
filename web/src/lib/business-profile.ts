import type {SetupSectionId} from './setup-progress';

export type BusinessProfile={
  ownerName:string;
  businessName:string;
  category:string;
  description:string;
  logo:string;
  banner:string;
  address:string;
  serviceArea:string;
  whatsapp:string;
  website:string;
  inventory:Record<string,string>;
  fulfillment:string[];
  completedAt:string;
};

export const BUSINESS_PROFILE_KEY='relay_business_profile_v1';
type SetupData=Record<SetupSectionId,Record<string,string>>;

const parseList=(value:string)=>{try{const parsed=JSON.parse(value);return Array.isArray(parsed)?parsed.filter(item=>typeof item==='string'):[]}catch{return []}};

export function saveBusinessProfile(data:SetupData){
  const profile:BusinessProfile={
    ownerName:localStorage.getItem('relay_owner_name')||'',
    businessName:data.basic.name.trim(),
    category:data.basic.category==='other'?data.basic.categoryOther.trim():data.basic.category,
    description:data.basic.description.trim(),
    logo:data.branding.logo,
    banner:data.branding.banner,
    address:data.location.address.trim(),
    serviceArea:data.location.serviceArea.trim(),
    whatsapp:data.contact.whatsapp.trim(),
    website:data.contact.website.trim(),
    inventory:{...data.inventory},
    fulfillment:parseList(data.fulfillment.methods),
    completedAt:new Date().toISOString(),
  };
  localStorage.setItem(BUSINESS_PROFILE_KEY,JSON.stringify(profile));
  window.dispatchEvent(new Event('relay-business-profile'));
  return profile;
}

export function readBusinessProfile():BusinessProfile|null{try{const saved=JSON.parse(localStorage.getItem(BUSINESS_PROFILE_KEY)||'null');return saved?{...saved,whatsapp:saved.whatsapp||saved.social?.whatsapp||'',website:saved.website||saved.social?.website||''}:null}catch{return null}}
export function businessInitials(name:string){return name.trim().split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]).join('').toUpperCase()||'R'}
