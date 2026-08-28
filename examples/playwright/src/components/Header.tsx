import { Link } from "react-router-dom";
import { useCart } from "@/cart/CartContext";
import { Icon } from "./Icon";

/** The Shoppy wordmark, used in the header and footer. */
export function Brand({ size }: { size?: number }) {
  return (
    <Link className="brand" to="/" style={size ? { fontSize: size } : undefined}>
      <span className="dot">
        <Icon name="i-bag" />
      </span>
      Shoppy
    </Link>
  );
}

/** The sticky site header. The cart badge reflects the live cart count from context. */
export function Header() {
  const { count } = useCart();
  return (
    <header className="site-header">
      <div className="wrap bar">
        <Brand />
        <nav className="nav">
          <Link to="/">Shop</Link>
          <Link to="/">New</Link>
          <Link to="/">Collections</Link>
          <Link to="/">Sale</Link>
        </nav>
        <div className="header-actions">
          <button className="icon-btn" aria-label="Search">
            <Icon name="i-search" />
          </button>
          <Link className="icon-btn" to="/cart" aria-label={`Cart, ${count} items`}>
            <Icon name="i-cart" />
            {count > 0 && <span className="cart-count">{count}</span>}
          </Link>
          <div className="avatar">A</div>
        </div>
      </div>
    </header>
  );
}
