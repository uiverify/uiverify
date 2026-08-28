import { useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuantityStepper } from "./QuantityStepper";

const meta = {
  title: "Components/QuantityStepper",
  component: QuantityStepper,
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return <QuantityStepper {...args} value={value} onChange={setValue} />;
  },
  args: { value: 1, min: 1, onChange: () => {} },
} satisfies Meta<typeof QuantityStepper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AtMinimum: Story = { args: { value: 1 } };
export const WithQuantity: Story = { args: { value: 3 } };
