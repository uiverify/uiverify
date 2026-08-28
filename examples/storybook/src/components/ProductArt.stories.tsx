import type { Meta, StoryObj } from "@storybook/react-vite";
import { ProductArt } from "./ProductArt";

const meta = {
  title: "Components/ProductArt",
  component: ProductArt,
  decorators: [
    (Story) => (
      <div style={{ width: 240, height: 240 }}>
        <Story />
      </div>
    ),
  ],
  args: { glyph: "mug", gradient: "g-mug" },
  argTypes: {
    glyph: {
      control: "select",
      options: ["mug", "bottle", "plant", "speaker", "tote", "lamp", "headphones", "candle"],
    },
  },
} satisfies Meta<typeof ProductArt>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Mug: Story = {};
export const Plant: Story = { args: { glyph: "plant", gradient: "g-plant" } };
export const Headphones: Story = { args: { glyph: "headphones", gradient: "g-headphones" } };
export const Candle: Story = { args: { glyph: "candle", gradient: "g-candle" } };
export const WithRibbon: Story = {
  args: { glyph: "headphones", gradient: "g-headphones" },
  render: (args) => (
    <ProductArt {...args}>
      <span className="ribbon">Sale</span>
    </ProductArt>
  ),
};
