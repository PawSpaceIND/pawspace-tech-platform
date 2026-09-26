"use client";
import { useEffect } from "react";
import { PawSpaceDevice } from "../../lib/mobile/index";

type Device = Pick<typeof PawSpaceDevice, "isNative" | "getPlatform">;

/** Inside the PawSpace app shell, marks <html data-pawspace-native="ios|android"> so V2's native-only styles apply. On the web nothing is set. */
export function markNativeShell(root: Pick<HTMLElement, "dataset">, device: Device = PawSpaceDevice): boolean {
  if (!device.isNative()) return false;
  root.dataset.pawspaceNative = device.getPlatform();
  return true;
}

export default function V2NativeShell() {
  useEffect(() => { markNativeShell(document.documentElement); }, []);
  return null;
}
