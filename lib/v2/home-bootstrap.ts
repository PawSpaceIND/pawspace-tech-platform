/** Load public availability independently from the identity → account chain. */
export async function bootstrapHome<Account, Availability>(input: {
  session: () => Promise<unknown>;
  account: () => Promise<Account>;
  availability: () => Promise<Availability>;
  onAccount: (value: Account | null) => void;
  onAvailability: (value: Availability) => void;
  onAccountError: (error: unknown) => void;
  onAvailabilityError: (error: unknown) => void;
  onAccountSettled: () => void;
}) {
  await Promise.all([
    input.availability().then(input.onAvailability).catch(input.onAvailabilityError),
    input.session().then(async session => {
      input.onAccount(session ? await input.account() : null);
    }).catch(input.onAccountError).finally(input.onAccountSettled),
  ]);
}
