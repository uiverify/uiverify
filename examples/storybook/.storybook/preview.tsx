import type { Preview } from "@storybook/react-vite";
import { MemoryRouter } from "react-router-dom";
import { Sprite } from "../src/components/Sprite";
import "../src/index.css";

/** Every story renders the inlined sprite (so product/icon `<use href="#id">` resolves) and a router
 *  (cards use react-router `Link`), on the app's cream backdrop. */
const preview: Preview = {
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <div style={{ background: "var(--cream)", padding: 40, borderRadius: 16 }}>
        <Sprite />
        <MemoryRouter>
          <Story />
        </MemoryRouter>
      </div>
    ),
  ],
};

export default preview;
