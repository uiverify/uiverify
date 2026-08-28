import { Pressable, StyleSheet, Text, View } from "react-native";
import { Button } from "../components/Button";
import { ProductArt } from "../components/ProductArt";
import type { Product } from "../data";
import { money, theme } from "../theme";

export function ProductScreen({
  product,
  onBack,
  onAddToCart,
}: {
  product: Product;
  onBack: () => void;
  onAddToCart: () => void;
}) {
  return (
    <View style={styles.screen}>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
        <Text style={styles.backLabel}>← Back</Text>
      </Pressable>
      <View style={styles.hero}>
        <ProductArt color={product.art} size={200} />
      </View>
      <Text style={styles.name}>{product.name}</Text>
      <Text style={styles.blurb}>{product.blurb}</Text>
      <Text style={styles.price}>{money(product.price)}</Text>
      <View style={styles.actions}>
        <Button label="Add to cart" onPress={onAddToCart} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.cream, paddingHorizontal: 20, paddingTop: 24 },
  back: { paddingVertical: 8 },
  backLabel: { fontSize: 16, color: theme.muted },
  hero: { alignItems: "center", paddingVertical: 32 },
  name: { fontSize: 24, fontWeight: "700", color: theme.ink },
  blurb: { marginTop: 6, fontSize: 15, color: theme.muted },
  price: { marginTop: 16, fontSize: 22, fontWeight: "600", color: theme.ink },
  actions: { marginTop: 28 },
});
