import {
  evaluateContactEligibility,
  type ContactSafetyInput,
} from "@/lib/services/contact-safety-gate";
import type { PetNextBestServiceRecommendation } from "@/lib/services/pet-next-best-service";
import { NextBestServiceCard as ExistingNextBestServiceCard } from "@/app/components/sales/NextBestServiceCard";

interface NextBestServiceCardProps {
  recommendation: PetNextBestServiceRecommendation;
  householdName: string;
  petName: string;
  safetyInput: ContactSafetyInput;
}

export function NextBestServiceCard({
  recommendation,
  householdName,
  petName,
  safetyInput,
}: NextBestServiceCardProps) {
  const safety = evaluateContactEligibility(safetyInput);

  return (
    <ExistingNextBestServiceCard
      recommendation={recommendation}
      householdName={householdName}
      petName={petName}
      safety={safety}
    />
  );
}
