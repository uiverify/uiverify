export type Category = "home" | "desk" | "kitchen" | "carry" | "sound";

export interface ColorOption {
  name: string;
  /** gradient utility class, e.g. "g-mug" - also used as the product-art tile color */
  cls: string;
}

export interface Product {
  /** url slug + stable id */
  id: string;
  name: string;
  /** short spec line, e.g. "Stoneware · 12oz" */
  sub: string;
  price: number;
  /** original price when on sale, struck through */
  compareAt?: number;
  rating: number;
  reviews: number;
  /** sprite symbol id without the "p-" prefix */
  glyph: string;
  /** default product-art gradient class */
  gradient: string;
  category: Category;
  badge?: { label: string; tone: "mint" | "coral" | "indigo" };
  /** corner ribbon on the art, e.g. "Sale" */
  ribbon?: string;
  description: string;
  colors: ColorOption[];
  sizes?: string[];
}

export const PRODUCTS: Product[] = [
  {
    id: "sunrise-mug",
    name: "Sunrise Mug",
    sub: "Stoneware · 12oz",
    price: 24,
    rating: 4.9,
    reviews: 312,
    glyph: "mug",
    gradient: "g-mug",
    category: "kitchen",
    badge: { label: "In stock", tone: "mint" },
    description:
      "A hefty 12oz stoneware mug with a hand-dipped reactive glaze, so no two are exactly alike. Keeps your coffee warm longer and feels great in the hand. Microwave and dishwasher safe.",
    colors: [
      { name: "Sunrise", cls: "g-mug" },
      { name: "Fern", cls: "g-mint" },
      { name: "Lilac", cls: "g-violet" },
      { name: "Slate", cls: "g-slate" },
    ],
    sizes: ["8oz", "12oz", "16oz"],
  },
  {
    id: "halo-headphones",
    name: "Halo Headphones",
    sub: "Over-ear · 40h battery",
    price: 95,
    compareAt: 120,
    rating: 4.8,
    reviews: 204,
    glyph: "headphones",
    gradient: "g-headphones",
    category: "sound",
    badge: { label: "Sale", tone: "coral" },
    ribbon: "Sale",
    description:
      "Plush over-ear headphones tuned for warm, room-filling sound. 40 hours on a charge, USB-C fast charge, and a fold-flat frame for travel.",
    colors: [
      { name: "Twilight", cls: "g-headphones" },
      { name: "Slate", cls: "g-slate" },
      { name: "Coral", cls: "g-mug" },
    ],
  },
  {
    id: "fern-planter",
    name: "Fern Planter",
    sub: "Recycled clay · Small",
    price: 32,
    rating: 5.0,
    reviews: 158,
    glyph: "plant",
    gradient: "g-plant",
    category: "home",
    badge: { label: "In stock", tone: "mint" },
    description:
      "A self-watering planter thrown from recycled clay, with a drainage reservoir so you can go a week between waterings. Fits a 4-inch nursery pot.",
    colors: [
      { name: "Fern", cls: "g-plant" },
      { name: "Sand", cls: "g-tote" },
      { name: "Slate", cls: "g-slate" },
    ],
    sizes: ["Small", "Medium", "Large"],
  },
  {
    id: "pocket-speaker",
    name: "Pocket Speaker",
    sub: "Bluetooth · 12h battery",
    price: 68,
    rating: 4.7,
    reviews: 96,
    glyph: "speaker",
    gradient: "g-speaker",
    category: "sound",
    badge: { label: "New", tone: "indigo" },
    description:
      "A palm-sized Bluetooth speaker with a surprisingly big low end and 12 hours of playback. IPX7 water resistant, so it rides along to the beach or the shower.",
    colors: [
      { name: "Orchid", cls: "g-speaker" },
      { name: "Twilight", cls: "g-headphones" },
      { name: "Slate", cls: "g-slate" },
    ],
  },
  {
    id: "terra-bottle",
    name: "Terra Bottle",
    sub: "Insulated · 20oz",
    price: 29,
    rating: 4.9,
    reviews: 271,
    glyph: "bottle",
    gradient: "g-bottle",
    category: "carry",
    badge: { label: "In stock", tone: "mint" },
    description:
      "A double-walled insulated bottle that keeps drinks cold for 24 hours and hot for 12. Powder-coated grip and a leakproof lid that actually seals.",
    colors: [
      { name: "Ember", cls: "g-bottle" },
      { name: "Fern", cls: "g-mint" },
      { name: "Slate", cls: "g-slate" },
    ],
    sizes: ["12oz", "20oz", "32oz"],
  },
  {
    id: "linen-tote",
    name: "Linen Tote",
    sub: "Washed linen · 14L",
    price: 45,
    rating: 4.8,
    reviews: 143,
    glyph: "tote",
    gradient: "g-tote",
    category: "carry",
    badge: { label: "In stock", tone: "mint" },
    description:
      "A washed-linen everyday tote with an interior zip pocket and a base that holds its shape. Roomy enough for a laptop, soft enough to fold away.",
    colors: [
      { name: "Oat", cls: "g-tote" },
      { name: "Fern", cls: "g-mint" },
      { name: "Coral", cls: "g-mug" },
    ],
  },
  {
    id: "glow-lamp",
    name: "Glow Lamp",
    sub: "Warm dimmable · USB-C",
    price: 54,
    rating: 4.9,
    reviews: 88,
    glyph: "lamp",
    gradient: "g-lamp",
    category: "desk",
    badge: { label: "New", tone: "indigo" },
    description:
      "A warm, stepless-dimmable desk lamp with a weighted base and a USB-C port on the back. Remembers your last brightness the next time it turns on.",
    colors: [
      { name: "Amber", cls: "g-lamp" },
      { name: "Fern", cls: "g-mint" },
      { name: "Slate", cls: "g-slate" },
    ],
  },
  {
    id: "ember-candle",
    name: "Ember Candle",
    sub: "Cedar + amber · 45h",
    price: 22,
    rating: 5.0,
    reviews: 219,
    glyph: "candle",
    gradient: "g-candle",
    category: "home",
    badge: { label: "In stock", tone: "mint" },
    description:
      "A hand-poured soy candle with notes of cedar, amber and a hint of smoke. Cotton wick, 45-hour burn, and a reusable tinted glass.",
    colors: [
      { name: "Ember", cls: "g-candle" },
      { name: "Fern", cls: "g-mint" },
      { name: "Amber", cls: "g-lamp" },
    ],
  },
];

export function getProduct(id: string): Product | undefined {
  return PRODUCTS.find((p) => p.id === id);
}
