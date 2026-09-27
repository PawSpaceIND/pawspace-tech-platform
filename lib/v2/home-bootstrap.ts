/** Load independent sections; a newer bootstrap or unmount invalidates every older callback. */
export async function bootstrapHome<Account, Availability>(input: {
  session: () => Promise<unknown>;
  account: () => Promise<Account>;
  availability: () => Promise<Availability>;
  onAccount: (value: Account | null) => void;
  onAvailability: (value: Availability) => void;
  onAccountError: (error: unknown) => void;
  onAvailabilityError: (error: unknown) => void;
  onAccountSettled: () => void;
  isCurrent?: () => boolean;
}) {
  const current = () => input.isCurrent?.() ?? true;
  await Promise.all([
    input.availability().then(value => { if (current()) input.onAvailability(value); })
      .catch(error => { if (current()) input.onAvailabilityError(error); }),
    input.session().then(async session => {
      if (!current()) return;
      const account = session ? await input.account() : null;
      if (current()) input.onAccount(account);
    }).catch(error => { if (current()) input.onAccountError(error); })
      .finally(() => { if (current()) input.onAccountSettled(); }),
  ]);
}
