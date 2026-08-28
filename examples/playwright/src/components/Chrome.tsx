import { useCart } from "@/cart/CartContext";
import { Brand } from "./Header";
import { Icon } from "./Icon";

/** The top announcement bar. */
export function Announce() {
  return (
    <div className="announce">
      Free shipping on orders over <b>$50</b> · Spring drop is live ✦
    </div>
  );
}

/** The site footer. */
export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap bar">
        <Brand size={20} />
        <span>© 2026 Shoppy Inc.</span>
        <span style={{ marginLeft: "auto" }}>Shipping · Returns · Privacy · Contact</span>
      </div>
    </footer>
  );
}

/** The add-to-cart confirmation toast, driven by cart context. Renders nothing when idle. */
export function Toast() {
  const { toast } = useCart();
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <Icon name="i-check" /> {toast}
    </div>
  );
}
