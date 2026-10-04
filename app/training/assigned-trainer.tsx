"use client";
import { useEffect, useState } from "react";
import { ASSIGNED_TRAINER, type TrainerAssignmentView } from "../../lib/training-assignment-view";

/**
 * The assigned trainer's public display name, resolved from the public provider profile by the assignment's
 * providerId. Nothing is fetched while the assignment is pending, so no provisional or internal identity can
 * ever be shown. Null until resolved (or when there is nothing to resolve).
 */
export function useAssignedTrainerName(view: TrainerAssignmentView | null | undefined): string | null {
  const providerId = view?.state === "assigned" ? view.providerId : null;
  const [name, setName] = useState<{ providerId: string; name: string } | null>(null);
  useEffect(() => {
    if (!providerId) return;
    const controller = new AbortController();
    void fetch(`/api/provider-public-profile?${new URLSearchParams({ providerId })}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => { const body = await response.json(); return response.ok && body?.data?.displayName ? String(body.data.displayName) : null; })
      .then((resolved) => { if (resolved && !controller.signal.aborted) setName({ providerId, name: resolved }); })
      .catch(() => undefined);
    return () => controller.abort();
  }, [providerId]);
  return providerId && name?.providerId === providerId ? name.name : null;
}

/** The words for the trainer slot: the public name once assigned and resolved, else the view's honest label. */
export default function AssignedTrainerName({ view }: { view: TrainerAssignmentView }) {
  const name = useAssignedTrainerName(view);
  return <>{view.state === "assigned" ? name ?? ASSIGNED_TRAINER : view.label}</>;
}
