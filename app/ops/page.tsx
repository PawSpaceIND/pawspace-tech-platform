import { redirect } from "next/navigation";

/**
 * RETIRED ROUTE — a fabricated "control tower". None of its four views read the database: the
 * command view claimed lakhs of gross sales and a reconciliation rate, the finance view an invented
 * income register, the GST view a fake statutory register and the payroll view a projected payroll
 * cost with an invented headcount. Invented statutory and payroll figures are the most dangerous
 * kind of placeholder, and every one of those views duplicates a real module this page already
 * linked out to.
 *
 * The real equivalents: /team (governed staff front door, live counters), /team/finance
 * (per-vertical reconciliation and settlement), /team/finance-compliance (real TDS and monthly
 * close) and /team/people/payroll (the canonical payroll engine).
 */
export default function RetiredOpsControlTower() {
  redirect("/team");
}
