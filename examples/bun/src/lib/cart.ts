import type { Product } from "./products";

/** One line in the cart. `key` folds product + chosen color/size so the same mug in two colors is two lines. */
export interface CartItem {
  key: string;
  productId: string;
  name: string;
  glyph: string;
  gradient: string;
  price: number;
  color?: string;
  size?: string;
  qty: number;
}

export interface Totals {
  subtotal: number;
  shipping: number;
  tax: number;
  discount: number;
  total: number;
}

export const FREE_SHIPPING_THRESHOLD = 50;
export const FLAT_SHIPPING = 4;
export const TAX_RATE = 0.08;
export const PROMO_CODE = "SPRING15";
export const PROMO_RATE = 0.15;

export function cartKey(productId: string, color?: string, size?: string): string {
  return [productId, color ?? "", size ?? ""].join("|");
}

export function lineFromProduct(product: Product, opts: { color?: string; size?: string; qty?: number } = {}): CartItem {
  const { color, size, qty = 1 } = opts;
  return {
    key: cartKey(product.id, color, size),
    productId: product.id,
    name: product.name,
    glyph: product.glyph,
    gradient: product.gradient,
    price: product.price,
    color,
    size,
    qty,
  };
}

/** Add a line, merging quantities when an identical line (same key) is already present. Pure - returns a new array. */
export function addItem(items: CartItem[], item: CartItem): CartItem[] {
  const existing = items.find((i) => i.key === item.key);
  if (!existing) return [...items, item];
  return items.map((i) => (i.key === item.key ? { ...i, qty: i.qty + item.qty } : i));
}

/** Set a line's quantity. A quantity of 0 or less removes the line. */
export function setQty(items: CartItem[], key: string, qty: number): CartItem[] {
  if (qty <= 0) return removeItem(items, key);
  return items.map((i) => (i.key === key ? { ...i, qty } : i));
}

export function removeItem(items: CartItem[], key: string): CartItem[] {
  return items.filter((i) => i.key !== key);
}

export function cartCount(items: CartItem[]): number {
  return items.reduce((n, i) => n + i.qty, 0);
}

export function subtotal(items: CartItem[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Full order math: flat shipping under the free-shipping threshold, tax on the subtotal, and an optional promo. */
export function computeTotals(items: CartItem[], promoApplied = false): Totals {
  const sub = subtotal(items);
  const shipping = sub > 0 && sub < FREE_SHIPPING_THRESHOLD ? FLAT_SHIPPING : 0;
  const tax = round2(sub * TAX_RATE);
  const discount = promoApplied ? round2(sub * PROMO_RATE) : 0;
  const total = round2(sub + shipping + tax - discount);
  return { subtotal: round2(sub), shipping, tax, discount, total };
}

export function isValidPromo(code: string): boolean {
  return code.trim().toUpperCase() === PROMO_CODE;
}
