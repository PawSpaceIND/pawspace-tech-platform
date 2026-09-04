export type ModificationServiceType =
  | "grooming"
  | "dog_training"
  | "dog_walking"
  | "boarding"
  | "pet_sitting"
  | "pet_taxi"
  | "relocation";

export interface ModificationFeeQuote {
  policyVersion: "v2-draft-2026-09-04";
  serviceType: ModificationServiceType;
  timeToServiceHours: number;
  grossFeePaise: number;
  ltvAllowancePaise: number;
  netFeePaise: number;
  outcome: "free_modification" | "fee_applies" | "ltv_courtesy_allowance";
}

type ModificationWindow = {
  minimumLeadHours: number;
  feePaise: number;
};

const SLA_RULES: Readonly<
  Record<ModificationServiceType, readonly ModificationWindow[]>
> = {
  grooming: [
    { minimumLeadHours: 24, feePaise: 0 },
    { minimumLeadHours: 6, feePaise: 25_000 },
    { minimumLeadHours: 0, feePaise: 50_000 },
  ],
  dog_training: [
    { minimumLeadHours: 24, feePaise: 0 },
    { minimumLeadHours: 6, feePaise: 50_000 },
    { minimumLeadHours: 0, feePaise: 100_000 },
  ],
  dog_walking: [
    { minimumLeadHours: 12, feePaise: 0 },
    { minimumLeadHours: 4, feePaise: 15_000 },
    { minimumLeadHours: 0, feePaise: 30_000 },
  ],
  boarding: [
    { minimumLeadHours: 72, feePaise: 0 },
    { minimumLeadHours: 24, feePaise: 100_000 },
    { minimumLeadHours: 0, feePaise: 200_000 },
  ],
  pet_sitting: [
    { minimumLeadHours: 48, feePaise: 0 },
    { minimumLeadHours: 24, feePaise: 50_000 },
    { minimumLeadHours: 0, feePaise: 100_000 },
  ],
  pet_taxi: [
    { minimumLeadHours: 12, feePaise: 0 },
    { minimumLeadHours: 3, feePaise: 25_000 },
    { minimumLeadHours: 0, feePaise: 50_000 },
  ],
  relocation: [
    { minimumLeadHours: 168, feePaise: 0 },
    { minimumLeadHours: 72, feePaise: 200_000 },
    { minimumLeadHours: 0, feePaise: 500_000 },
  ],
};

function ltvAllowanceRate(customerLTV: number): number {
  if (customerLTV >= 5_000_000) return 0.5;
  if (customerLTV >= 2_000_000) return 0.25;
  return 0;
}

export function calculateModificationFee(
  serviceType: ModificationServiceType,
  timeToService: number,
  customerLTV: number,
): ModificationFeeQuote {
  if (!Number.isFinite(timeToService) || timeToService < 0) {
    throw new Error("timeToService must be a non-negative number of hours");
  }
  if (!Number.isFinite(customerLTV) || customerLTV < 0) {
    throw new Error("customerLTV must be a non-negative paise amount");
  }

  const matchingWindow = SLA_RULES[serviceType].find(
    (window) => timeToService >= window.minimumLeadHours,
  );

  if (!matchingWindow) {
    throw new Error(`No SLA window configured for service type: ${serviceType}`);
  }

  const grossFeePaise = matchingWindow.feePaise;
  const ltvAllowancePaise = Math.round(
    grossFeePaise * ltvAllowanceRate(customerLTV),
  );
  const netFeePaise = grossFeePaise - ltvAllowancePaise;

  return {
    policyVersion: "v2-draft-2026-09-04",
    serviceType,
    timeToServiceHours: timeToService,
    grossFeePaise,
    ltvAllowancePaise,
    netFeePaise,
    outcome:
      grossFeePaise === 0
        ? "free_modification"
        : ltvAllowancePaise > 0
          ? "ltv_courtesy_allowance"
          : "fee_applies",
  };
}
