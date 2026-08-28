import type { Meta, StoryObj } from "@storybook/react-vite";
import { getProduct } from "@/lib/products";
import { ProductCard } from "./ProductCard";

const mug = getProduct("sunrise-mug");
const headphones = getProduct("halo-headphones");
const speaker = getProduct("pocket-speaker");
if (!mug || !headphones || !speaker) throw new Error("expected demo products in the catalog");

const meta = {
  title: "Components/ProductCard",
  component: ProductCard,
  decorators: [
    (Story) => (
      <div style={{ width: 280 }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ProductCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InStock: Story = { args: { product: mug } };
export const OnSale: Story = { args: { product: headphones } };
export const New: Story = { args: { product: speaker } };
