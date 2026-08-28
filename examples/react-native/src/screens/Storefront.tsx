import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { ProductCard } from "../components/ProductCard";
import { PRODUCTS } from "../data";
import { theme } from "../theme";

export function Storefront({
  cartCount,
  onOpenProduct,
  onOpenCart,
}: {
  cartCount: number;
  onOpenProduct: (id: string) => void;
  onOpenCart: () => void;
}) {
  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text style={styles.title}>Shoppy</Text>
        <Pressable accessibilityRole="button" onPress={onOpenCart} style={styles.cartButton}>
          <Text style={styles.cartLabel}>Cart · {cartCount}</Text>
        </Pressable>
      </View>
      <ScrollView contentContainerStyle={styles.grid}>
        {PRODUCTS.map((p) => (
          <ProductCard key={p.id} product={p} onPress={() => onOpenProduct(p.id)} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.cream },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 20,
    paddingTop: 24,
    paddingBottom: 16,
  },
  title: { fontSize: 26, fontWeight: "700", color: theme.ink },
  cartButton: { paddingVertical: 8, paddingHorizontal: 14, borderRadius: 999, backgroundColor: theme.card, borderWidth: 1, borderColor: theme.line },
  cartLabel: { fontSize: 14, fontWeight: "600", color: theme.ink },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", gap: 14, paddingHorizontal: 20, paddingBottom: 40 },
});
