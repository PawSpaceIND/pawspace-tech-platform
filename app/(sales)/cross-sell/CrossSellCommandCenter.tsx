import ExistingCrossSellCommandCenter from "@/app/components/sales/CrossSellCommandCenter";

export const CROSS_SELL_COMMAND_CENTER_METRICS = [
  "Revenue Pipeline",
  "Attach Rate",
  "Conversion Rate",
] as const;

export default function CrossSellCommandCenter() {
  return <ExistingCrossSellCommandCenter />;
}
