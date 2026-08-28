import { StyleSheet, View } from "react-native";

/** Deterministic "product art": a solid rounded block with a soft inner circle. No image assets, so it
 *  renders identically on every device. */
export function ProductArt({ color, size = 96 }: { color: string; size?: number }) {
  return (
    <View style={[styles.art, { backgroundColor: color, width: size, height: size, borderRadius: size / 5 }]}>
      <View
        style={[styles.dot, { width: size / 2, height: size / 2, borderRadius: size / 4 }]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  art: { alignItems: "center", justifyContent: "center" },
  dot: { backgroundColor: "rgba(255,255,255,0.35)" },
});
