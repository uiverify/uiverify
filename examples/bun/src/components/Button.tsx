import type { ButtonHTMLAttributes } from "react";

export type ButtonVariant = "primary" | "ghost" | "dark";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "md" | "lg";
  block?: boolean;
}

/** The shared button: brand-gradient `primary`, neutral `ghost`, or solid `dark`. Icons are passed as
 *  children alongside the label. */
export function Button({ variant = "primary", size = "md", block = false, className = "", children, ...rest }: ButtonProps) {
  const classes = ["btn", `btn-${variant}`, size === "lg" && "btn-lg", block && "btn-block", className]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={classes} {...rest}>
      {children}
    </button>
  );
}
