export type RpaActionRequest = {
  system: string;
  action: string;
  correlationId: string;
  input: unknown;
};

export interface RpaExecutor {
  execute(request: RpaActionRequest): Promise<{ executed: boolean; reason: string }>;
}

export const disabledRpaExecutor: RpaExecutor = {
  async execute() {
    return { executed: false, reason: "phase3_rpa_not_enabled" };
  },
};
