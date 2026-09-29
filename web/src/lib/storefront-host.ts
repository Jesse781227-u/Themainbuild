const tenantSlugPattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function getLocalStorefrontSlug(hostname:string):string|null{
  const normalized=hostname.toLowerCase().replace(/\.$/,'');
  if(!normalized.endsWith('.localhost'))return null;
  const slug=normalized.slice(0,-'.localhost'.length);
  return tenantSlugPattern.test(slug)?slug:null;
}
