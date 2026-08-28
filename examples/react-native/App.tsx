import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { StyleSheet, View } from "react-native";
import { getProduct } from "./src/data";
import { Cart } from "./src/screens/Cart";
import { ProductScreen } from "./src/screens/Product";
import { Storefront } from "./src/screens/Storefront";
import { theme } from "./src/theme";

type Screen = { name: "storefront" } | { name: "product"; id: string } | { name: "cart" };

export default function App() {
  const [screen, setScreen] = useState<Screen>({ name: "storefront" });
  const [cart, setCart] = useState<string[]>([]);

  const product = screen.name === "product" ? getProduct(screen.id) : undefined;

  return (
    <View style={styles.root}>
      {/* Hidden so the device clock/battery never appear in a screenshot — an honest, stable baseline. */}
      <StatusBar hidden />
      {screen.name === "storefront" && (
        <Storefront
          cartCount={cart.length}
          onOpenProduct={(id) => setScreen({ name: "product", id })}
          onOpenCart={() => setScreen({ name: "cart" })}
        />
      )}
      {screen.name === "product" && product && (
        <ProductScreen
          product={product}
          onBack={() => setScreen({ name: "storefront" })}
          onAddToCart={() => {
            setCart((c) => [...c, product.id]);
            setScreen({ name: "cart" });
          }}
        />
      )}
      {screen.name === "cart" && <Cart items={cart} onBack={() => setScreen({ name: "storefront" })} />}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.cream },
});
