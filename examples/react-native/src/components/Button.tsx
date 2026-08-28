import { Pressable, StyleSheet, Text } from "react-native";
import { theme } from "../theme";

export function Button({
  label,
  onPress,
  variant = "primary",
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "ghost";
}) {
  const primary = variant === "primary";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={[styles.base, primary ? styles.primary : styles.ghost]}
    >
      <Text style={[styles.label, primary ? styles.primaryLabel : styles.ghostLabel]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: { paddingVertical: 14, paddingHorizontal: 20, borderRadius: 12, alignItems: "center" },
  primary: { backgroundColor: theme.accent },
  ghost: { backgroundColor: "transparent", borderWidth: 1, borderColor: theme.line },
  label: { fontSize: 16, fontWeight: "600" },
  primaryLabel: { color: "#FFFFFF" },
  ghostLabel: { color: theme.ink },
});
