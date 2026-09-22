/**
 * Relay Storefront Styles — theme tokens.
 *
 * 20 storefront looks sharing the same commerce engine (navigation, cart,
 * checkout, product pages, payment flow). Only the visual language changes.
 *
 * Consume with useTheme(themeId) or by mapping tokens to CSS custom
 * properties on the storefront root:
 *
 *   const t = themes.find(x => x.id === 'kitchen-table')!;
 *   Object.entries(cssVars(t)).forEach(([k,v]) => root.style.setProperty(k,v));
 */

export type StorefrontCategory =
  | "Restaurant & Café"
  | "Fashion"
  | "Beauty"
  | "Retail"
  | "Services";

export interface StorefrontTheme {
  id: string;
  name: string;
  category: StorefrontCategory;
  tagline: string;
  perfectFor: string[];
  colors: {
    bg: string;
    surface: string;
    ink: string;
    muted: string;
    accent: string;
    accentInk: string;
    border: string;
  };
  fonts: { heading: string; body: string };
  radius: { card: string; button: string; image: string };
  /** Composition knobs — the shared engine reads these to pick layout variants. */
  hero:
    | "photo-rounded-warm" | "photo-full-editorial" | "playful-blob" | "dark-glow"
    | "edge-to-edge-photo" | "minimal-luxury" | "oversized-bold" | "compact-banner"
    | "soft-gradient" | "premium-clean" | "dark-gold" | "airy-fresh"
    | "clean-banner" | "price-first-banner" | "utility-strip" | "multi-banner"
    | "trust-hero" | "corporate-grid" | "refined-serif" | "utility-service";
  /** Products per row on mobile storefront. */
  grid: 1 | 2 | 3;
  cardStyle: string;
  buttonStyle: string;
  sample: "food" | "fashion" | "beauty" | "retail" | "services";
}

export const themes: StorefrontTheme[] = [
  {
    "id": "kitchen-table",
    "name": "Kitchen Table",
    "category": "Restaurant & Café",
    "tagline": "Warm, modern and inviting",
    "perfectFor": [
      "Restaurants",
      "Cafés",
      "Smoothie bars",
      "Breakfast spots"
    ],
    "colors": {
      "bg": "#faf6f0",
      "surface": "#ffffff",
      "ink": "#2b1e14",
      "muted": "#7a6a5c",
      "accent": "#c2410c",
      "accentInk": "#ffffff",
      "border": "#ecdfd0"
    },
    "fonts": {
      "heading": "'Fraunces', Georgia, serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "20px",
      "button": "999px",
      "image": "16px"
    },
    "hero": "photo-rounded-warm",
    "grid": 2,
    "cardStyle": "rounded-shadow",
    "buttonStyle": "pill",
    "sample": "food"
  },
  {
    "id": "corner-bistro",
    "name": "Corner Bistro",
    "category": "Restaurant & Café",
    "tagline": "Elegant and premium",
    "perfectFor": [
      "Fine dining",
      "Wine bars",
      "Hotels",
      "Premium restaurants"
    ],
    "colors": {
      "bg": "#f4f1ec",
      "surface": "#ffffff",
      "ink": "#1a1613",
      "muted": "#6b625a",
      "accent": "#5b4636",
      "accentInk": "#f4f1ec",
      "border": "#e2dcd2"
    },
    "fonts": {
      "heading": "'Cormorant Garamond', 'Playfair Display', serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "4px",
      "button": "2px",
      "image": "2px"
    },
    "hero": "photo-full-editorial",
    "grid": 1,
    "cardStyle": "editorial-serif",
    "buttonStyle": "sharp",
    "sample": "food"
  },
  {
    "id": "fresh-menu",
    "name": "Fresh Menu",
    "category": "Restaurant & Café",
    "tagline": "Bright and energetic",
    "perfectFor": [
      "Juice bars",
      "Ice cream shops",
      "Dessert shops",
      "Fast casual"
    ],
    "colors": {
      "bg": "#fffdf5",
      "surface": "#ffffff",
      "ink": "#1a1a1a",
      "muted": "#666",
      "accent": "#22c55e",
      "accentInk": "#052e1a",
      "border": "#f0eadd"
    },
    "fonts": {
      "heading": "'Sora', system-ui, sans-serif",
      "body": "'DM Sans', system-ui, sans-serif"
    },
    "radius": {
      "card": "24px",
      "button": "999px",
      "image": "20px"
    },
    "hero": "playful-blob",
    "grid": 2,
    "cardStyle": "playful-color",
    "buttonStyle": "pill",
    "sample": "food"
  },
  {
    "id": "night-market",
    "name": "Night Market",
    "category": "Restaurant & Café",
    "tagline": "Dark and bold",
    "perfectFor": [
      "BBQ",
      "Shawarma",
      "Burger joints",
      "Street food",
      "Lounges"
    ],
    "colors": {
      "bg": "#0b0b0f",
      "surface": "#15151c",
      "ink": "#f5f5f7",
      "muted": "#8a8a95",
      "accent": "#f59e0b",
      "accentInk": "#0b0b0f",
      "border": "#25252f"
    },
    "fonts": {
      "heading": "'Space Grotesk', system-ui, sans-serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "14px",
      "button": "10px",
      "image": "12px"
    },
    "hero": "dark-glow",
    "grid": 2,
    "cardStyle": "dark-glow",
    "buttonStyle": "rounded-glow",
    "sample": "food"
  },
  {
    "id": "sunset",
    "name": "Sunset",
    "category": "Fashion",
    "tagline": "Editorial and lifestyle",
    "perfectFor": [
      "Clothing",
      "Footwear",
      "Accessories"
    ],
    "colors": {
      "bg": "#ffffff",
      "surface": "#faf8f5",
      "ink": "#111",
      "muted": "#6b6b6b",
      "accent": "#111",
      "accentInk": "#fff",
      "border": "#eee"
    },
    "fonts": {
      "heading": "'Instrument Serif', Georgia, serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "0px",
      "button": "0px",
      "image": "0px"
    },
    "hero": "edge-to-edge-photo",
    "grid": 2,
    "cardStyle": "editorial-clean",
    "buttonStyle": "sharp",
    "sample": "fashion"
  },
  {
    "id": "studio",
    "name": "Studio",
    "category": "Fashion",
    "tagline": "Minimal luxury",
    "perfectFor": [
      "Premium fashion",
      "Designer boutiques",
      "Luxury brands"
    ],
    "colors": {
      "bg": "#f6f5f2",
      "surface": "#ffffff",
      "ink": "#171717",
      "muted": "#8a8a8a",
      "accent": "#171717",
      "accentInk": "#f6f5f2",
      "border": "#e8e6e0"
    },
    "fonts": {
      "heading": "'Archivo', system-ui, sans-serif",
      "body": "'Archivo', system-ui, sans-serif"
    },
    "radius": {
      "card": "2px",
      "button": "999px",
      "image": "2px"
    },
    "hero": "minimal-luxury",
    "grid": 2,
    "cardStyle": "minimal-clean",
    "buttonStyle": "pill-outline",
    "sample": "fashion"
  },
  {
    "id": "runway",
    "name": "Runway",
    "category": "Fashion",
    "tagline": "High fashion",
    "perfectFor": [
      "Seasonal collections",
      "Designer launches",
      "Streetwear"
    ],
    "colors": {
      "bg": "#f2f2f2",
      "surface": "#ffffff",
      "ink": "#000",
      "muted": "#666",
      "accent": "#e11d48",
      "accentInk": "#fff",
      "border": "#e5e5e5"
    },
    "fonts": {
      "heading": "'Bebas Neue', Impact, sans-serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "0px",
      "button": "0px",
      "image": "0px"
    },
    "hero": "oversized-bold",
    "grid": 1,
    "cardStyle": "lookbook",
    "buttonStyle": "sharp-inverted",
    "sample": "fashion"
  },
  {
    "id": "urban-rack",
    "name": "Urban Rack",
    "category": "Fashion",
    "tagline": "Modern retail",
    "perfectFor": [
      "General fashion stores",
      "Sneaker shops",
      "Multi-brand retailers"
    ],
    "colors": {
      "bg": "#ffffff",
      "surface": "#fafafa",
      "ink": "#111",
      "muted": "#6b6b6b",
      "accent": "#2563eb",
      "accentInk": "#fff",
      "border": "#e5e5e5"
    },
    "fonts": {
      "heading": "'Manrope', system-ui, sans-serif",
      "body": "'Manrope', system-ui, sans-serif"
    },
    "radius": {
      "card": "10px",
      "button": "10px",
      "image": "8px"
    },
    "hero": "compact-banner",
    "grid": 2,
    "cardStyle": "compact-badge",
    "buttonStyle": "rounded",
    "sample": "fashion"
  },
  {
    "id": "soft-petals",
    "name": "Soft Petals",
    "category": "Beauty",
    "tagline": "Feminine and elegant",
    "perfectFor": [
      "Beauty stores",
      "Cosmetics",
      "Skincare"
    ],
    "colors": {
      "bg": "#fdf6f4",
      "surface": "#ffffff",
      "ink": "#3b1f2b",
      "muted": "#8a6b74",
      "accent": "#e879a3",
      "accentInk": "#ffffff",
      "border": "#f5e2e0"
    },
    "fonts": {
      "heading": "'DM Serif Display', Georgia, serif",
      "body": "'Nunito Sans', system-ui, sans-serif"
    },
    "radius": {
      "card": "28px",
      "button": "999px",
      "image": "24px"
    },
    "hero": "soft-gradient",
    "grid": 2,
    "cardStyle": "soft-rounded",
    "buttonStyle": "pill",
    "sample": "beauty"
  },
  {
    "id": "glow-studio",
    "name": "Glow Studio",
    "category": "Beauty",
    "tagline": "Premium beauty",
    "perfectFor": [
      "Makeup brands",
      "Skin clinics",
      "Beauty boutiques"
    ],
    "colors": {
      "bg": "#f7f4ef",
      "surface": "#ffffff",
      "ink": "#2a241f",
      "muted": "#8a8177",
      "accent": "#c8a97e",
      "accentInk": "#2a241f",
      "border": "#ece7de"
    },
    "fonts": {
      "heading": "'Cormorant Garamond', Georgia, serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "6px",
      "button": "999px",
      "image": "4px"
    },
    "hero": "premium-clean",
    "grid": 2,
    "cardStyle": "minimal-cream",
    "buttonStyle": "pill-outline",
    "sample": "beauty"
  },
  {
    "id": "velvet",
    "name": "Velvet",
    "category": "Beauty",
    "tagline": "Dark luxury",
    "perfectFor": [
      "Perfume stores",
      "Luxury cosmetics",
      "Premium salons"
    ],
    "colors": {
      "bg": "#0f0a10",
      "surface": "#1a1218",
      "ink": "#f5ecdc",
      "muted": "#a09285",
      "accent": "#d4af37",
      "accentInk": "#0f0a10",
      "border": "#2a1f28"
    },
    "fonts": {
      "heading": "'Playfair Display', Georgia, serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "8px",
      "button": "2px",
      "image": "4px"
    },
    "hero": "dark-gold",
    "grid": 2,
    "cardStyle": "dark-gold",
    "buttonStyle": "sharp-gold",
    "sample": "beauty"
  },
  {
    "id": "blossom",
    "name": "Blossom",
    "category": "Beauty",
    "tagline": "Fresh and modern",
    "perfectFor": [
      "Hair products",
      "Nail studios",
      "Organic beauty"
    ],
    "colors": {
      "bg": "#f0fbf4",
      "surface": "#ffffff",
      "ink": "#0f2e1a",
      "muted": "#5d7a68",
      "accent": "#16a34a",
      "accentInk": "#ffffff",
      "border": "#d5eedb"
    },
    "fonts": {
      "heading": "'Outfit', system-ui, sans-serif",
      "body": "'Outfit', system-ui, sans-serif"
    },
    "radius": {
      "card": "24px",
      "button": "999px",
      "image": "20px"
    },
    "hero": "airy-fresh",
    "grid": 2,
    "cardStyle": "rounded-airy",
    "buttonStyle": "pill",
    "sample": "beauty"
  },
  {
    "id": "clean-bright",
    "name": "Clean & Bright",
    "category": "Retail",
    "tagline": "Universal retail",
    "perfectFor": [
      "Convenience stores",
      "General retail",
      "Electronics"
    ],
    "colors": {
      "bg": "#ffffff",
      "surface": "#f7f8fa",
      "ink": "#0f172a",
      "muted": "#64748b",
      "accent": "#0ea5e9",
      "accentInk": "#ffffff",
      "border": "#e5e7eb"
    },
    "fonts": {
      "heading": "'Inter', system-ui, sans-serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "12px",
      "button": "10px",
      "image": "10px"
    },
    "hero": "clean-banner",
    "grid": 2,
    "cardStyle": "clean-card",
    "buttonStyle": "rounded",
    "sample": "retail"
  },
  {
    "id": "bold-shelf",
    "name": "Bold Shelf",
    "category": "Retail",
    "tagline": "Product-first",
    "perfectFor": [
      "Electronics",
      "Home appliances",
      "Hardware"
    ],
    "colors": {
      "bg": "#fffbea",
      "surface": "#ffffff",
      "ink": "#111827",
      "muted": "#4b5563",
      "accent": "#ea580c",
      "accentInk": "#ffffff",
      "border": "#f4e9b8"
    },
    "fonts": {
      "heading": "'Archivo Black', Impact, sans-serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "8px",
      "button": "8px",
      "image": "6px"
    },
    "hero": "price-first-banner",
    "grid": 2,
    "cardStyle": "big-price",
    "buttonStyle": "bold",
    "sample": "retail"
  },
  {
    "id": "warehouse",
    "name": "Warehouse",
    "category": "Retail",
    "tagline": "High-volume catalogue",
    "perfectFor": [
      "Supermarkets",
      "Wholesale",
      "Office supplies"
    ],
    "colors": {
      "bg": "#f9fafb",
      "surface": "#ffffff",
      "ink": "#111827",
      "muted": "#6b7280",
      "accent": "#0f766e",
      "accentInk": "#ffffff",
      "border": "#e5e7eb"
    },
    "fonts": {
      "heading": "'IBM Plex Sans', system-ui, sans-serif",
      "body": "'IBM Plex Sans', system-ui, sans-serif"
    },
    "radius": {
      "card": "6px",
      "button": "6px",
      "image": "4px"
    },
    "hero": "utility-strip",
    "grid": 3,
    "cardStyle": "compact-dense",
    "buttonStyle": "rounded-small",
    "sample": "retail"
  },
  {
    "id": "marketplace",
    "name": "Marketplace",
    "category": "Retail",
    "tagline": "Busy but organised",
    "perfectFor": [
      "Department stores",
      "Multi-category retailers",
      "Large inventories"
    ],
    "colors": {
      "bg": "#f3f4f6",
      "surface": "#ffffff",
      "ink": "#111827",
      "muted": "#6b7280",
      "accent": "#7c3aed",
      "accentInk": "#ffffff",
      "border": "#e5e7eb"
    },
    "fonts": {
      "heading": "'Plus Jakarta Sans', system-ui, sans-serif",
      "body": "'Plus Jakarta Sans', system-ui, sans-serif"
    },
    "radius": {
      "card": "12px",
      "button": "999px",
      "image": "10px"
    },
    "hero": "multi-banner",
    "grid": 2,
    "cardStyle": "market-tile",
    "buttonStyle": "pill",
    "sample": "retail"
  },
  {
    "id": "signature",
    "name": "Signature",
    "category": "Services",
    "tagline": "Professional and trustworthy",
    "perfectFor": [
      "Consultants",
      "Agencies",
      "Accountants"
    ],
    "colors": {
      "bg": "#ffffff",
      "surface": "#f8fafc",
      "ink": "#0f172a",
      "muted": "#475569",
      "accent": "#1e40af",
      "accentInk": "#ffffff",
      "border": "#e2e8f0"
    },
    "fonts": {
      "heading": "'Fraunces', Georgia, serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "14px",
      "button": "10px",
      "image": "10px"
    },
    "hero": "trust-hero",
    "grid": 1,
    "cardStyle": "service-card",
    "buttonStyle": "rounded",
    "sample": "services"
  },
  {
    "id": "horizon",
    "name": "Horizon",
    "category": "Services",
    "tagline": "Corporate",
    "perfectFor": [
      "Cleaning services",
      "Security companies",
      "Logistics"
    ],
    "colors": {
      "bg": "#f5f7fa",
      "surface": "#ffffff",
      "ink": "#0b1a2b",
      "muted": "#475569",
      "accent": "#0369a1",
      "accentInk": "#ffffff",
      "border": "#dbe3ec"
    },
    "fonts": {
      "heading": "'Space Grotesk', system-ui, sans-serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "10px",
      "button": "8px",
      "image": "8px"
    },
    "hero": "corporate-grid",
    "grid": 1,
    "cardStyle": "corporate-icon",
    "buttonStyle": "rounded",
    "sample": "services"
  },
  {
    "id": "concierge",
    "name": "Concierge",
    "category": "Services",
    "tagline": "Premium service",
    "perfectFor": [
      "Lawyers",
      "Architects",
      "Interior designers"
    ],
    "colors": {
      "bg": "#f5f2ec",
      "surface": "#ffffff",
      "ink": "#1c1a17",
      "muted": "#7a7266",
      "accent": "#1c1a17",
      "accentInk": "#f5f2ec",
      "border": "#e5dfd3"
    },
    "fonts": {
      "heading": "'Cormorant Garamond', Georgia, serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "2px",
      "button": "2px",
      "image": "2px"
    },
    "hero": "refined-serif",
    "grid": 1,
    "cardStyle": "refined-line",
    "buttonStyle": "sharp",
    "sample": "services"
  },
  {
    "id": "workshop",
    "name": "Workshop",
    "category": "Services",
    "tagline": "Practical and informative",
    "perfectFor": [
      "Mechanics",
      "Repair shops",
      "Contractors",
      "Technicians"
    ],
    "colors": {
      "bg": "#f4f4f0",
      "surface": "#ffffff",
      "ink": "#1a1a1a",
      "muted": "#525252",
      "accent": "#eab308",
      "accentInk": "#1a1a1a",
      "border": "#e2e2dc"
    },
    "fonts": {
      "heading": "'Barlow Condensed', Impact, sans-serif",
      "body": "'Inter', system-ui, sans-serif"
    },
    "radius": {
      "card": "6px",
      "button": "6px",
      "image": "4px"
    },
    "hero": "utility-service",
    "grid": 1,
    "cardStyle": "spec-card",
    "buttonStyle": "bold",
    "sample": "services"
  }
];

export const themesById: Record<string, StorefrontTheme> = Object.fromEntries(
  themes.map(t => [t.id, t])
);

/** Accept the compact template names used by older storefront records. */
export const templateAliases: Record<string, string> = {
  menu: "kitchen-table",
  book: "soft-petals",
  market: "runway",
  drop: "sunset",
  studio: "studio",
  everyday: "clean-bright",
};

export function resolveThemeId(value?: string): string {
  return templateAliases[value || ""] || value || themes[0].id;
}

/** Maps theme tokens to CSS custom properties for the commerce engine root. */
export function cssVars(t: StorefrontTheme): Record<string, string> {
  return {
    "--bg": t.colors.bg,
    "--surface": t.colors.surface,
    "--ink": t.colors.ink,
    "--muted": t.colors.muted,
    "--accent": t.colors.accent,
    "--accent-ink": t.colors.accentInk,
    "--border": t.colors.border,
    "--r-card": t.radius.card,
    "--r-btn": t.radius.button,
    "--r-img": t.radius.image,
    "--f-head": t.fonts.heading,
    "--f-body": t.fonts.body,
  };
}
