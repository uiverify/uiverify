import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import {
  addItem,
  cartCount,
  computeTotals,
  isValidPromo,
  lineFromProduct,
  removeItem,
  setQty,
  type CartItem,
  type Totals,
} from "@/lib/cart";
import type { Product } from "@/lib/products";

interface CartValue {
  items: CartItem[];
  count: number;
  totals: Totals;
  promoApplied: boolean;
  toast: string | null;
  add: (product: Product, opts?: { color?: string; size?: string; qty?: number }) => void;
  setQuantity: (key: string, qty: number) => void;
  remove: (key: string) => void;
  applyPromo: (code: string) => boolean;
  dismissToast: () => void;
}

const CartContext = createContext<CartValue | null>(null);

export function CartProvider({ children, initialItems = [] }: { children: ReactNode; initialItems?: CartItem[] }) {
  const [items, setItems] = useState<CartItem[]>(initialItems);
  const [promoApplied, setPromoApplied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showToast = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const add = useCallback<CartValue["add"]>(
    (product, opts) => {
      setItems((cur) => addItem(cur, lineFromProduct(product, opts)));
      showToast(`${product.name} added to cart`);
    },
    [showToast],
  );

  const setQuantity = useCallback<CartValue["setQuantity"]>((key, qty) => {
    setItems((cur) => setQty(cur, key, qty));
  }, []);

  const remove = useCallback<CartValue["remove"]>((key) => {
    setItems((cur) => removeItem(cur, key));
  }, []);

  const applyPromo = useCallback<CartValue["applyPromo"]>((code) => {
    const ok = isValidPromo(code);
    setPromoApplied(ok);
    return ok;
  }, []);

  const dismissToast = useCallback(() => setToast(null), []);

  const value = useMemo<CartValue>(
    () => ({
      items,
      count: cartCount(items),
      totals: computeTotals(items, promoApplied),
      promoApplied,
      toast,
      add,
      setQuantity,
      remove,
      applyPromo,
      dismissToast,
    }),
    [items, promoApplied, toast, add, setQuantity, remove, applyPromo, dismissToast],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartValue {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used within a CartProvider");
  return ctx;
}
