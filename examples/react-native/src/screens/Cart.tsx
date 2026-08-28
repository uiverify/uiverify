import { Pressable, StyleSheet, Text, View } from "react-native";
import { ProductArt } from "../components/ProductArt";
import { getProduct } from "../data";
import { money, theme } from "../theme";

export function Cart({ items, onBack }: { items: string[]; onBack: () => void }) {
  const products = items.map(getProduct).filter((p): p is NonNullable<typeof p> => p != null);
  const total = products.reduce((sum, p) => sum + p.price, 0);

  return (
    <View style={styles.screen}>
      <Pressable accessibilityRole="button" onPress={onBack} style={styles.back}>
        <Text style={styles.backLabel}>← Back</Text>
      </Pressable>
      <Text style={styles.title}>Your cart</Text>
      {products.length === 0 ? (
        <Text style={styles.empty}>Your cart is empty.</Text>
      ) : (
        <View style={styles.list}>
          {products.map((p, i) => (
            <View key={`${p.id}-${i}`} style={styles.row}>
              <ProductArt color={p.art} size={56} />
              <Text style={styles.name}>{p.name}</Text>
              <Text style={styles.price}>{money(p.price)}</Text>
            </View>
          ))}
        </View>
      )}
      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Total</Text>
        <Text style={styles.totalValue}>{money(total)}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.cream, paddingHorizontal: 20, paddingTop: 24 },
  back: { paddingVertical: 8 },
  backLabel: { fontSize: 16, color: theme.muted },
  title: { fontSize: 24, fontWeight: "700", color: theme.ink, marginBottom: 16 },
  empty: { fontSize: 15, color: theme.muted },
  list: { gap: 12 },
  row: { flexDirection: "row", alignItems: "center", gap: 14, backgroundColor: theme.card, borderRadius: 14, padding: 12, borderWidth: 1, borderColor: theme.line },
  name: { flex: 1, fontSize: 16, fontWeight: "600", color: theme.ink },
  price: { fontSize: 15, color: theme.muted },
  totalRow: { flexDirection: "row", justifyContent: "space-between", marginTop: 24, paddingTop: 16, borderTopWidth: 1, borderTopColor: theme.line },
  totalLabel: { fontSize: 18, fontWeight: "600", color: theme.ink },
  totalValue: { fontSize: 18, fontWeight: "700", color: theme.ink },
});
