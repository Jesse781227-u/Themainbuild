export type SetupStatus = 'not_started' | 'in_progress' | 'completed' | 'skipped';
export type SetupSectionId = 'basic' | 'social' | 'branding' | 'location' | 'inventory' | 'fulfillment';
export type SetupSection = {id: SetupSectionId; label: string; required: boolean; weight: number};
export type SetupProgress = {rewardGranted: boolean; sections: Record<SetupSectionId, SetupStatus>; lastPromptedAt?: string; reminderScheduledFor?: string};

export const SETUP_SECTIONS: SetupSection[] = [
  {id:'basic',label:'Basic business info',required:true,weight:18},
  {id:'social',label:'Social media links',required:false,weight:16},
  {id:'branding',label:'Logo and banner',required:true,weight:16},
  {id:'location',label:'Location or service area',required:true,weight:15},
  {id:'inventory',label:'First inventory item',required:true,weight:15},
  {id:'fulfillment',label:'Fulfiiment',required:false,weight:8},
];

export const SETUP_KEY = 'relay_setup_progress_v1';
export const emptySetupProgress = (): SetupProgress => ({rewardGranted:true,sections:Object.fromEntries(SETUP_SECTIONS.map(s=>[s.id,'not_started'])) as SetupProgress['sections']});
export function readSetupProgress(): SetupProgress { try { const raw=localStorage.getItem(SETUP_KEY); const saved=raw?JSON.parse(raw):{}; const base=emptySetupProgress(); const sections=Object.fromEntries(SETUP_SECTIONS.map(section=>[section.id,saved.sections?.[section.id]||base.sections[section.id]])) as SetupProgress['sections']; return {...base,...saved,sections}; } catch { return emptySetupProgress(); } }
export function writeSetupProgress(value:SetupProgress){try{localStorage.setItem(SETUP_KEY,JSON.stringify(value));window.dispatchEvent(new Event('relay-setup-progress'));}catch{/* storage is an enhancement, not a gate */}}
export function setupPercent(value=readSetupProgress()){return Math.min(100,12+SETUP_SECTIONS.reduce((total,section)=>total+(['completed','skipped'].includes(value.sections[section.id])?section.weight:0),0));}
export function setupComplete(value=readSetupProgress()){return SETUP_SECTIONS.filter(s=>s.required).every(s=>value.sections[s.id]==='completed') && setupPercent(value)>=100;}
