"use client";
import ReconciliationWorkspace from "./reconciliation-workspace";
import StaffModule from "../../../components/staff-workspace/StaffModule";

/** Read-only Finance view of payment exceptions, reconciliation needing attention and stuck captures. */
export default function PaymentReconciliationPage() {
  return <StaffModule><ReconciliationWorkspace /></StaffModule>;
}
