import { parseLocation, describeLocation } from './api/src/services/location';
for (const t of ['yaba', "it's in Lagos, Yaba, near Tejuosho market", 'Lagos, Yaba', '12 Herbert Macaulay Way, Yaba, Lagos', 'Lagos', 'we are at Wuse 2 abuja', 'Shop 14, Computer Village, Ikeja', 'Bodija', 'Ojodu Berger, Lagos', 'VI', 'near Tejuosho market', 'Ibadan, Bodija, opposite UI gate', 'Yaba Lagos', 'Oke Afa'])
  console.log(t.padEnd(45), JSON.stringify(parseLocation(t)), '|', describeLocation(parseLocation(t)));
