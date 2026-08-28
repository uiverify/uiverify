import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { render } from "vitest-browser-react";
import { Sprite } from "@/components/Sprite";
import "@/index.css";

/** Render a component for a browser-mode visual test with the sprite (so `<use href="#id">` resolves)
 *  and a router (components use react-router `Link`) in scope, on the app's cream backdrop. */
export function renderScene(ui: ReactNode) {
  return render(
    <div style={{ background: "var(--cream)", padding: 40 }}>
      <Sprite />
      <MemoryRouter>{ui}</MemoryRouter>
    </div>,
  );
}
