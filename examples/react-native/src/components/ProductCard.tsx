import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Product } from "../data";
import { money, theme } from "../theme";
import { ProductArt } from "./ProductArt";

export function ProductCard({ product, onPress }: { product: Product; onPress?: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={product.name} style={styles.card}>
      <ProductArt color={product.art} />
      <View style={styles.meta}>
        <Text style={styles.name}>{product.name}</Text>
        <Text style={styles.price}>{money(product.price)}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    width: "48%",
    backgroundColor: theme.card,
    borderRadius: 16,
    padding: 14,
    alignItems: "center",
    borderWidth: 1,
    borderColor: theme.line,
  },
  meta: { marginTop: 12, alignItems: "center" },
  name: { fontSize: 15, fontWeight: "600", color: theme.ink },
  price: { marginTop: 4, fontSize: 14, color: theme.muted },
});
