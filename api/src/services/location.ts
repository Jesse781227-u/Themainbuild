// Reading a shop's location from how owners actually type it:
//   "yaba" · "Lagos, Yaba" · "it's in Lagos, Yaba, near Tejuosho market" · "12 Herbert Macaulay Way, Yaba"
// → { city: 'Lagos', area: 'Yaba', street: '12 Herbert Macaulay Way', landmark: 'Tejuosho Market' }
// Well-known areas give their city (Yaba → Lagos, Wuse → Abuja), so "yaba" alone is enough.
export interface Location { city: string | null; area: string | null; street: string | null; landmark: string | null }

// area (lower case) → city. The city is also the state for Lagos, Abuja (FCT) and most others here.
const AREAS: Record<string, string> = {};
const add = (city: string, areas: string) => { for (const a of areas.split(',')) AREAS[a.trim().toLowerCase()] = city; };
add('Lagos', 'Yaba, Ikeja, Lekki, Ajah, Surulere, Victoria Island, VI, Ikoyi, Obalende, Lagos Island, Marina, Idumota, Oshodi, Isolo, Ojota, Ketu, Mile 12, Ikorodu, Maryland, Gbagada, Magodo, Ogba, Agege, Ikotun, Egbeda, Festac, Amuwo Odofin, Mushin, Ilupeju, Palmgrove, Somolu, Shomolu, Bariga, Akoka, Ebute Metta, Oyingbo, Apapa, Ajegunle, Badagry, Ojo, Alaba, Satellite Town, Okota, Ejigbo, Ipaja, Iyana Ipaja, Alimosho, Sangotedo, Chevron, Ikota, Osapa, Agungi, Oniru, Ilasan, Jakande, Abraham Adesanya, Ojodu, Berger, Omole, Opebi, Allen, Alausa, Anthony, Ogudu, Ifako, Idimu, Igando, Ojuelegba, Costain, Iganmu, Orile, Ladipo, Ogombo, Abule Egba, Ayobo, Epe, Ibeju Lekki, Tejuosho, Sabo, Onike, Iwaya, Fadeyi, Oregun, Dolphin Estate, Parkview, Banana Island');
add('Abuja', 'Wuse, Wuse 2, Garki, Maitama, Asokoro, Gwarinpa, Jabi, Utako, Kubwa, Lugbe, Lokogoma, Apo, Gudu, Durumi, Wuye, Kado, Life Camp, Katampe, Mabushi, Dutse, Bwari, Karu, Nyanya, Mararaba, Galadimawa, Kuje, Gwagwalada, Dei-Dei, Jahi, Guzape, Idu, Kaura, Area 1, Area 11, Central Area');
add('Ibadan', 'Bodija, Dugbe, Ring Road, Challenge, Mokola, Sango, Agodi, Iwo Road, Oluyole, Akobo, Apata, Ojoo, Agbowo, UI, Samonda, Jericho, Eleyele, Felele, Oke Ado, Adamasingba, Gbagi');
add('Port Harcourt', 'GRA, Rumuokoro, Rumuola, Trans Amadi, Choba, Eliozu, Rumuodara, Ada George, Rumuigbo, Woji, Elelenwo, Diobu, Mile 1, Mile 3, Borokiri, Rumuibekwe, Peter Odili, Rumuomasi');
add('Benin City', 'Ugbowo, Uselu, Ikpoba Hill, Sapele Road, Ring Road Benin, Airport Road, Ekenwan, Aduwawa, Oba Market');
add('Enugu', 'Independence Layout, New Haven, Trans Ekulu, Abakpa, Emene, Uwani, Achara Layout, Ogui, Coal Camp, Asata, Thinkers Corner, Gariki');
add('Kano', 'Nassarawa, Sabon Gari, Fagge, Tarauni, Gwale, Bompai, Kofar Mata, Zoo Road');
add('Abeokuta', 'Kuto, Panseke, Oke Ilewo, Ibara, Asero, Adigbe, Lafenwa');

const CITIES: Record<string, string> = {};
for (const c of ['Lagos', 'Abuja', 'Ibadan', 'Port Harcourt', 'Benin City', 'Enugu', 'Kano', 'Kaduna', 'Abeokuta', 'Owerri', 'Uyo', 'Calabar', 'Jos', 'Ilorin', 'Warri', 'Akure', 'Onitsha', 'Asaba', 'Awka', 'Osogbo', 'Ogbomoso', 'Ado Ekiti', 'Ilesa', 'Ife', 'Sagamu', 'Ota', 'Lokoja', 'Makurdi', 'Minna', 'Sokoto', 'Maiduguri', 'Yola', 'Bauchi', 'Zaria', 'Aba', 'Umuahia', 'Abakaliki', 'Yenagoa', 'Nnewi', 'Ijebu Ode']) CITIES[c.toLowerCase()] = c;
// Other names people use for the same place.
Object.assign(CITIES, { 'ph': 'Port Harcourt', 'portharcourt': 'Port Harcourt', 'benin': 'Benin City', 'fct': 'Abuja', 'lag': 'Lagos', 'ibd': 'Ibadan', 'lagos state': 'Lagos', 'oyo': 'Ibadan', 'oyo state': 'Ibadan', 'rivers': 'Port Harcourt', 'rivers state': 'Port Harcourt', 'ogun': 'Abeokuta', 'edo': 'Benin City', 'kano state': 'Kano', 'enugu state': 'Enugu' });
const ALIASES: Record<string, string> = { 'vi': 'Victoria Island', 'v.i': 'Victoria Island', 'v.i.': 'Victoria Island', 'v/i': 'Victoria Island', 'ui': 'University of Ibadan', 'festac town': 'Festac', 'wuse ii': 'Wuse 2', 'garki 2': 'Garki', 'garki ii': 'Garki' };

const FILLER = /^(?:(?:it'?s|it is|we'?re|we are|i'?m|i am|my (?:shop|store|business) is|our (?:shop|store|business) is|the (?:shop|store) is|we'?re located|located|address(?: is)?|in|at|on|inside|around)\b[\s,:]*)+/i;
const LANDMARK = /[\s,]+(?:near|opposite|opp\.?|beside|close to|behind|next to|after|before|adjacent to|across from)\s+(.+)$/i;
const STREETY = /\d|\b(street|st|road|rd|way|avenue|ave|close|crescent|cres|lane|ln|drive|dr|plaza|estate|junction|building|bldg|complex|mall|market|shop|suite|block|plot|floor|off)\b/i;

// "tejuosho market" → "Tejuosho Market"; known short forms keep their capitals ("VI", "GRA", "UI").
export function tidyPlace(s: string) {
  const t = s.replace(/\s+/g, ' ').replace(/^[\s,.;:-]+|[\s,.;:-]+$/g, '').slice(0, 80);
  if (/^[A-Z]{2,4}$/.test(t)) return t;
  return t.split(' ').map(w => (/^(gra|ui|vi|fct|ph)$/i.test(w) ? w.toUpperCase() : /^\d/.test(w) || (w !== w.toLowerCase() && w !== w.toUpperCase()) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join(' ');
}

const areaName = (s: string) => ALIASES[s.toLowerCase()] ?? tidyPlace(s);

export function parseLocation(raw: string): Location {
  let text = raw.replace(/\s+/g, ' ').trim().replace(/[.!]+$/, '').replace(FILLER, '');
  const out: Location = { city: null, area: null, street: null, landmark: null };
  const lm = LANDMARK.exec(` ${text}`);
  if (lm) { out.landmark = tidyPlace(lm[1]); text = ` ${text}`.slice(0, lm.index).trim(); }
  else if (/^(near|opposite|beside|close to|behind|next to)\s+/i.test(text)) { out.landmark = tidyPlace(text.replace(/^\S+(\s+to)?\s+/i, '')); text = ''; }
  const parts = text.split(/\s*,\s*|\s+-\s+|\s*\/\s*|\n/).map(p => p.replace(FILLER, '').replace(/\s+(state|nigeria)$/i, '').trim()).filter(p => p && !/^nigeria$/i.test(p));
  const rest: string[] = [];
  for (const p of parts) {
    const k = p.toLowerCase();
    if (!out.city && CITIES[k]) { out.city = CITIES[k]; continue; }
    if (!out.area && (AREAS[k] || ALIASES[k])) { out.area = areaName(p); continue; }
    // "Yaba Lagos" in one part.
    const two = Object.keys(CITIES).find(c => k.endsWith(` ${c}`));
    if (two && !out.city && (AREAS[k.slice(0, -two.length - 1)] || !STREETY.test(k))) { out.city = CITIES[two]; if (!out.area) out.area = areaName(p.slice(0, -two.length - 1)); continue; }
    rest.push(p);
  }
  // Unknown parts: the first plain one is the area; the rest ("Shop 14", "Computer Village") the street.
  // Addresses go street → area → city, so with no known area it's the last plain part.
  const areaAt = out.area ? -1 : rest.map(p => !STREETY.test(p)).lastIndexOf(true);
  rest.forEach((p, i) => {
    if (i === areaAt) out.area = areaName(p);
    else out.street = out.street ? `${out.street}, ${tidyPlace(p)}` : tidyPlace(p);
  });
  if (out.area && !out.city) out.city = AREAS[out.area.toLowerCase()] ?? null;
  // A city given as the area ("Lagos" alone) is the city.
  if (out.area && !out.city && CITIES[out.area.toLowerCase()]) { out.city = CITIES[out.area.toLowerCase()]; out.area = null; }
  return out;
}

export const knownCity = (s: string) => CITIES[s.trim().toLowerCase().replace(/\s+state$/, '')] ?? null;
// An area Relay knows (with its city): "Gbagada" → "Lagos". Unknown areas are read back to check.
export const knownArea = (s: string) => AREAS[s.trim().toLowerCase()] ?? (ALIASES[s.trim().toLowerCase()] ? AREAS[ALIASES[s.trim().toLowerCase()].toLowerCase()] ?? null : null);

// "12 Herbert Macaulay Way, Yaba, Lagos — near Tejuosho Market"
export function describeLocation(l: Partial<Location>) {
  const main = [l.street, l.area, l.city].filter(Boolean).join(', ');
  return `${main}${l.landmark ? `${main ? ' — ' : ''}near ${l.landmark}` : ''}`;
}

// A customer's address with short forms spelled out, so "VI" finds a "Victoria Island" zone.
export function expandAliases(address: string) {
  return address.replace(/\b(v\.?\s?i\.?|v\/i)(?=[\s,.]|$)/gi, 'Victoria Island').replace(/\bwuse ii\b/gi, 'Wuse 2');
}
