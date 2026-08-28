import { Link } from "react-router-dom";
import { Icon } from "@/components/Icon";
import { ProductArt } from "@/components/ProductArt";

const ORDER = {
  number: "SHP-20841",
  email: "alex@example.com",
  eta: "Tue, Aug 25",
  items: [
    { glyph: "mug", gradient: "g-mug", name: "Sunrise Mug", detail: "Sunrise · 12oz · Qty 1", price: "$24.00" },
    { glyph: "plant", gradient: "g-plant", name: "Fern Planter", detail: "Recycled clay · Small · Qty 1", price: "$32.00" },
  ],
  total: "$56.08",
};

export function Success() {
  return (
    <main>
      <div className="confirm">
        <div className="check">
          <Icon name="i-check" />
        </div>
        <h1>Thank you, Alex!</h1>
        <p className="lead">
          Your order is confirmed. We sent a receipt to <b>{ORDER.email}</b>.
        </p>
        <p className="lead">
          Order <span className="order-no">#{ORDER.number}</span>
        </p>

        <div className="receipt">
          <div className="head">
            <div className="eta">
              <span className="ico">
                <Icon name="i-truck" />
              </span>
              <div>
                <b>Arrives {ORDER.eta}</b>
                <span>Standard shipping · free</span>
              </div>
            </div>
            <span className="tag tag-mint">
              <Icon name="i-check" size={13} /> Paid
            </span>
          </div>
          <div className="items">
            {ORDER.items.map((item) => (
              <div className="ritem" key={item.name}>
                <ProductArt glyph={item.glyph} gradient={item.gradient} />
                <div className="m">
                  <h3>{item.name}</h3>
                  <p>{item.detail}</p>
                </div>
                <span className="rp">{item.price}</span>
              </div>
            ))}
          </div>
          <div className="tot">
            <span>Total paid</span>
            <b>{ORDER.total}</b>
          </div>
        </div>

        <div className="actions">
          <Link className="btn btn-primary btn-lg" to="/">
            Continue shopping
          </Link>
          <Link className="btn btn-ghost btn-lg" to="/success">
            Track order
          </Link>
        </div>
        <p className="track-note">
          Questions about your order? <Link to="/">Visit the help center →</Link>
        </p>
      </div>
    </main>
  );
}
