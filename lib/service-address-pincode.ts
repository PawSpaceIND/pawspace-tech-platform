/** Extract postal candidates without treating labelled flat/plot/reference numbers as PINs. */
export function serviceAddressPincodes(address: string): string[] {
  if (address.length > 2000) return [];
  const explicit: string[] = [], unlabelled: string[] = [];
  const propertyLabels = new Set(["flat", "unit", "plot", "reference", "ref", "building", "apartment", "house", "block", "survey", "khata", "invoice", "order"]);
  for (const match of address.matchAll(/\b[0-9]{6}\b/g)) {
    const words = address.slice(Math.max(0, match.index - 48), match.index).toLowerCase().match(/[a-z]+/g) || [];
    const previous = words.at(-1) || "", before = words.at(-2) || "";
    const labelledPin = ["pin", "pincode", "postal", "zip", "zipcode"].includes(previous) ||
      (previous === "code" && ["pin", "postal", "zip"].includes(before));
    if (labelledPin) { explicit.push(match[0]); continue; }
    if (propertyLabels.has(previous) || (["no", "number", "id"].includes(previous) && propertyLabels.has(before))) continue;
    unlabelled.push(match[0]);
  }
  // Explicit postal labels outrank ambiguous numbers; otherwise the final unlabelled candidate is conventional.
  return explicit.length ? explicit : unlabelled.slice(-1);
}
