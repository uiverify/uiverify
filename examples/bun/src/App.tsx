import { Outlet, Route, Routes } from "react-router-dom";
import { CartProvider } from "@/cart/CartContext";
import { Announce, Footer, Toast } from "@/components/Chrome";
import { Header } from "@/components/Header";
import { Sprite } from "@/components/Sprite";
import { Cart } from "@/pages/Cart";
import { Login } from "@/pages/Login";
import { Product } from "@/pages/Product";
import { Storefront } from "@/pages/Storefront";
import { Success } from "@/pages/Success";

/** The shared shell for every page except the full-bleed sign-in: announcement bar, header, footer. */
function Layout() {
  return (
    <>
      <Announce />
      <Header />
      <Outlet />
      <Footer />
    </>
  );
}

export function App() {
  return (
    <CartProvider>
      <Sprite />
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Storefront />} />
          <Route path="/product/:id" element={<Product />} />
          <Route path="/cart" element={<Cart />} />
          <Route path="/success" element={<Success />} />
          <Route path="*" element={<Storefront />} />
        </Route>
        <Route path="/login" element={<Login />} />
      </Routes>
      <Toast />
    </CartProvider>
  );
}
