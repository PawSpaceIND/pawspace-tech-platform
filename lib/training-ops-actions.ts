const recoveryStates = new Set(["scheduled", "accepted", "reschedule_requested"]);
const noShowStates = new Set(["scheduled", "accepted", "on_the_way", "arrived"]);

export function trainingOpsActionsForStatus(status: string) {
  return {
    reschedule: recoveryStates.has(status),
    replaceTrainer: recoveryStates.has(status),
    noShow: noShowStates.has(status),
    cancel: recoveryStates.has(status),
  };
}
