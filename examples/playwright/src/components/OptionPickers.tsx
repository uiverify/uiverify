import type { ColorOption } from "@/lib/products";

/** Color swatches. Each swatch shows its gradient; the selected one gets a ring. Controlled via `onChange`. */
export function SwatchPicker({
  colors,
  value,
  onChange,
}: {
  colors: ColorOption[];
  value: string;
  onChange: (name: string) => void;
}) {
  return (
    <div className="swatches">
      {colors.map((c) => (
        <button
          key={c.name}
          type="button"
          aria-label={c.name}
          aria-pressed={c.name === value}
          className={`sw ${c.cls} ${c.name === value ? "active" : ""}`.trim()}
          onClick={() => onChange(c.name)}
        />
      ))}
    </div>
  );
}

/** Size chips. Controlled via `onChange`. */
export function SizePicker({
  sizes,
  value,
  onChange,
}: {
  sizes: string[];
  value: string;
  onChange: (size: string) => void;
}) {
  return (
    <div className="sizes">
      {sizes.map((s) => (
        <button
          key={s}
          type="button"
          aria-pressed={s === value}
          className={`sz ${s === value ? "active" : ""}`.trim()}
          onClick={() => onChange(s)}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
