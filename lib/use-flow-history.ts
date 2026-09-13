"use client";
import { useEffect, useRef } from "react";

type FlowHistoryState = { pawspaceFlow?: { flow: string; stage: number } };

export function useFlowHistory(flow: string, stage: number, setStage: (stage: number) => void) {
  const restoring = useRef(false);
  const initialized = useRef(false);

  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      const value = (event.state as FlowHistoryState | null)?.pawspaceFlow;
      if (value?.flow !== flow || !Number.isInteger(value.stage) || value.stage < 1) return;
      restoring.current = true;
      setStage(value.stage);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [flow, setStage]);

  useEffect(() => {
    const current = (window.history.state as FlowHistoryState | null)?.pawspaceFlow;
    if (!initialized.current) {
      initialized.current = true;
      if (current?.flow !== flow) window.history.replaceState({ ...window.history.state, pawspaceFlow: { flow, stage } }, "");
      return;
    }
    if (restoring.current) { restoring.current = false; return; }
    if (current?.flow === flow && current.stage === stage) return;
    window.history.pushState({ ...window.history.state, pawspaceFlow: { flow, stage } }, "");
  }, [flow, stage]);
}
