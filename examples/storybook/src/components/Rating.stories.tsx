import type { Meta, StoryObj } from "@storybook/react-vite";
import { Rating, Stars } from "./Rating";

const meta = {
  title: "Components/Rating",
  component: Rating,
  args: { value: 4.9 },
} satisfies Meta<typeof Rating>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Compact: Story = {};
export const FiveStar: StoryObj<typeof Stars> = {
  render: () => <Stars value={4.9} reviews={312} />,
};
