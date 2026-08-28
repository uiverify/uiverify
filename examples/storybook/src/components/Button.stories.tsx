import type { Meta, StoryObj } from "@storybook/react-vite";
import { Button } from "./Button";

const meta = {
  title: "Components/Button",
  component: Button,
  args: { children: "Add to cart", variant: "primary", size: "md" },
  argTypes: {
    variant: { control: "inline-radio", options: ["primary", "ghost", "dark"] },
    size: { control: "inline-radio", options: ["md", "lg"] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const Ghost: Story = { args: { variant: "ghost", children: "Browse all" } };
export const Dark: Story = { args: { variant: "dark", children: "Checkout" } };
export const Large: Story = { args: { size: "lg", children: "Shop the drop" } };
export const Disabled: Story = { args: { disabled: true } };
