import { Icon } from "./Icon";

/** A minus / value / plus stepper. Controlled: reports the next quantity via `onChange`, clamped to `min`. */
export function QuantityStepper({
  value,
  onChange,
  min = 1,
  className = "qty",
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  className?: string;
}) {
  return (
    <div className={className}>
      <button type="button" aria-label="Decrease quantity" disabled={value <= min} onClick={() => onChange(Math.max(min, value - 1))}>
        <Icon name="i-minus" />
      </button>
      <span aria-live="polite">{value}</span>
      <button type="button" aria-label="Increase quantity" onClick={() => onChange(value + 1)}>
        <Icon name="i-plus" />
      </button>
    </div>
  );
}
