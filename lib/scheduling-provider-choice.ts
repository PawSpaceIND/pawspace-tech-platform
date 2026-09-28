/** Customer intent narrows matching; it never grants permission or overrides an Operations policy. */
export type ProviderSelection = "auto" | "specific";
type ChoiceInput = { providerSelection?: unknown; preferredProviderId?: unknown };
type PreferredMode = "strict" | "preference" | "disabled";

export function providerChoiceProblem(input: ChoiceInput): string | null {
  if (input.providerSelection === undefined) return null; // Existing V1 callers retain their policy semantics.
  if (input.providerSelection !== "auto" && input.providerSelection !== "specific") return "Choose automatic matching or a specific provider.";
  if (input.providerSelection === "specific" && (typeof input.preferredProviderId !== "string" || !input.preferredProviderId.trim())) return "Choose the specific provider before reserving.";
  if (input.providerSelection === "auto" && input.preferredProviderId !== undefined && input.preferredProviderId !== "") return "Automatic matching cannot also lock a provider.";
  return null;
}

export function preferredModeForChoice(input: ChoiceInput, policyMode: PreferredMode): PreferredMode {
  return input.providerSelection === "specific" ? "strict" : policyMode;
}

/** A caller cannot reuse an already held group while changing what the customer authorized. */
export function providerChoiceMatchesStored(input: ChoiceInput, stored: ChoiceInput): boolean {
  if (input.providerSelection === undefined && stored.providerSelection === undefined) return true;
  const mode = (choice: ChoiceInput) => choice.providerSelection ?? (choice.preferredProviderId ? "specific" : "auto");
  return mode(input) === mode(stored) && (mode(input) === "auto" || input.preferredProviderId === stored.preferredProviderId);
}
