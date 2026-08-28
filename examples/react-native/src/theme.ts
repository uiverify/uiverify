export const theme = {
  cream: "#FBF7F0",
  ink: "#2A2320",
  muted: "#8A7E76",
  accent: "#C6603D",
  card: "#FFFFFF",
  line: "#EFE7DB",
} as const;

export const money = (n: number): string => `$${n}`;
