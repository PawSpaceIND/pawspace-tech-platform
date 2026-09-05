"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  evaluateContactEligibility,
  type ContactSafetyDecision,
} from "@/lib/services/contact-safety-gate";
import {
  evaluatePetNextBestService,
  type GrowthServiceCode,
  type PetNextBestServiceRecommendation,
  type ServiceHistoryFact,
} from "@/lib/services/pet-next-best-service";
import type {
  QueuePriorityInput,
  UnifiedWorkItem,
} from "@/lib/types/sales-work-queue";
import { NextBestServiceCard } from "./NextBestServiceCard";
import { UnifiedWorkQueue, type UnifiedWorkQueueCandidate } from "./UnifiedWorkQueue";
import styles from "./cross-sell-command-center.module.css";

type CustomerPet = { id: string; name: string; species: string; breed: string | null };
type CustomerBooking = { id: string; serviceCode: string; status: string; scheduledEnd: string; totalAmount: number };
type CustomerTicket = { category: string; status: string; subject: string };
type CustomerRecord = {
  customerId: string;
  name: string;
  crmStage: string;
  owner: string;
  consent: { marketing: boolean };
  pets: CustomerPet[];
  bookings: CustomerBooking[];
  tickets: CustomerTicket[];
  lifetimeValue: number;
  lastServiceAt: string | null;
  dataQuality: { score: number; issues: string[] };
};
type RevenueActionRow = {
  id: string;
  customer_id: string;
  opportunity_type: string;
  reason: string;
  score: number;
  expected_revenue: number;
  expected_margin?: number | null;
  confidence: number;
  owner: string;
  status: string;
  suppression_json?: string;
  signals_json?: string;
  updated_at?: number;
};
type RevenueSignals = { recencyDays?: number; serviceGaps?: string[] };
type RecommendationView = {
  key: string;
  recommendation: PetNextBestServiceRecommendation;
  householdName: string;
  petName: string;
  safety: ContactSafetyDecision;
};

const OPEN_COMPLAINT_PATTERN = /quality|complaint|safety|incident/i;
const PAYMENT_DISPUTE_PATTERN = /refund|payment|chargeback|dispute/i;
const SERVICE_ALIASES: Readonly<Record<string, GrowthServiceCode>> = {
  grooming: "grooming",
  dog_training: "training",
  training: "training",
  dog_walking: "walking",
  walking: "walking",
  boarding: "boarding",
  pet_sitting: "sitting",
  sitting: "sitting",
  pet_taxi: "taxi",
  taxi: "taxi",
};

function parseJson<T>(value: string | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function normalizeService(value: string): GrowthServiceCode | null {
  return SERVICE_ALIASES[value.trim().toLowerCase()] ?? null;
}

function openTicketMatches(customer: CustomerRecord, pattern: RegExp): boolean {
  return customer.tickets.some((ticket) => ticket.status !== "resolved" && pattern.test(`${ticket.category} ${ticket.subject}`));
}

function contactSafety(customer: CustomerRecord): ContactSafetyDecision {
  return evaluateContactEligibility({
    marketingOptOut: !customer.consent.marketing,
    openComplaint: openTicketMatches(customer, OPEN_COMPLAINT_PATTERN),
    unresolvedRefundOrPaymentDispute: openTicketMatches(customer, PAYMENT_DISPUTE_PATTERN),
    identityReviewRequired: customer.dataQuality.issues.includes("possible_duplicate"),
    dataQualityReviewRequired: customer.dataQuality.score < 60,
  });
}

function historyFacts(bookings: CustomerBooking[]): ServiceHistoryFact[] {
  const grouped = new Map<GrowthServiceCode, ServiceHistoryFact>();
  for (const booking of bookings) {
    const serviceCode = normalizeService(booking.serviceCode);
    if (!serviceCode) continue;
    const current = grouped.get(serviceCode) ?? { serviceCode, completedCount: 0, lastCompletedAt: null };
    if (booking.status === "completed") {
      current.completedCount += 1;
      const completedAt = Date.parse(booking.scheduledEnd);
      if (!Number.isNaN(completedAt)) current.lastCompletedAt = Math.max(current.lastCompletedAt ?? 0, completedAt);
    }
    grouped.set(serviceCode, current);
  }
  return [...grouped.values()];
}

function queuePriorityInput(customer: CustomerRecord, action: RevenueActionRow | null, safety: ContactSafetyDecision): QueuePriorityInput {
  const signals = parseJson<RevenueSignals>(action?.signals_json, {});
  const updatedAt = Number(action?.updated_at || 0);
  return {
    urgency: Math.max(0, Math.min(100, Number(action?.score ?? 50))),
    confidence: Math.max(0, Math.min(100, Number(action?.confidence ?? 0.5) * 100)),
    expectedRevenue: Math.max(0, Number(action?.expected_revenue ?? 0)),
    expectedContribution: action?.expected_margin == null ? null : Math.max(0, Number(action.expected_margin)),
    customerValue: Math.max(0, Math.min(100, (Number(customer.lifetimeValue) / 50_000) * 100)),
    lifecycleRisk: typeof signals.recencyDays === "number" ? Math.max(0, Math.min(100, (signals.recencyDays / 60) * 100)) : 50,
    capacityAvailability: 50,
    ageHours: updatedAt > 0 ? Math.max(0, (Date.now() - updatedAt) / 3_600_000) : 0,
    managerEscalated: false,
    contactEligibility: action?.status === "suppressed" ? "Suppressed" : safety.eligibility,
  };
}

function queueCandidates(customers: CustomerRecord[], actions: RevenueActionRow[]): UnifiedWorkQueueCandidate[] {
  const customersById = new Map(customers.map((customer) => [customer.customerId, customer]));
  const candidates: UnifiedWorkQueueCandidate[] = [];

  for (const customer of customers) {
    if (customer.bookings.length > 0) continue;
    const safety = contactSafety(customer);
    const item: UnifiedWorkItem = {
      id: `new-lead:${customer.customerId}`,
      workType: "new_lead",
      customerId: customer.customerId,
      petId: customer.pets[0]?.id ?? null,
      ownerId: customer.owner || null,
      expectedRevenue: null,
      expectedContribution: null,
      contactEligibility: safety.eligibility,
      sourceReasonCodes: ["no_completed_booking", ...safety.reasonCodes],
      nextAction: safety.eligibility === "Allowed" ? "Qualify lead" : "Resolve contact safety gate",
      createdAt: 0,
    };
    candidates.push({ item, priorityInput: queuePriorityInput(customer, null, safety), householdName: customer.name, petNames: customer.pets.map((pet) => pet.name), reason: "New canonical lead without a completed booking" });
  }

  for (const action of actions) {
    if (!["win_back", "cross_sell"].includes(action.opportunity_type) || action.status === "completed") continue;
    const customer = customersById.get(action.customer_id);
    if (!customer) continue;
    const safety = contactSafety(customer);
    const effectiveEligibility = action.status === "suppressed" ? "Suppressed" : safety.eligibility;
    const signals = parseJson<RevenueSignals>(action.signals_json, {});
    const suppressionReasons = parseJson<string[]>(action.suppression_json, []);
    const item: UnifiedWorkItem = {
      id: action.id,
      workType: action.opportunity_type === "win_back" ? "win_back" : "cross_sell",
      customerId: customer.customerId,
      petId: customer.pets[0]?.id ?? null,
      opportunityId: action.id,
      serviceCode: action.opportunity_type === "cross_sell" ? signals.serviceGaps?.[0] ?? null : customer.bookings[0]?.serviceCode ?? null,
      ownerId: action.owner || customer.owner || null,
      expectedRevenue: Number.isFinite(Number(action.expected_revenue)) ? Number(action.expected_revenue) : null,
      expectedContribution: action.expected_margin == null ? null : Number(action.expected_margin),
      contactEligibility: effectiveEligibility,
      sourceReasonCodes: [...safety.reasonCodes, ...suppressionReasons],
      nextAction: effectiveEligibility === "Allowed" ? "Open governed outreach" : "Resolve contact safety gate",
      createdAt: Number(action.updated_at || 0),
    };
    candidates.push({ item, priorityInput: { ...queuePriorityInput(customer, action, safety), contactEligibility: effectiveEligibility }, householdName: customer.name, petNames: customer.pets.map((pet) => pet.name), reason: action.reason });
  }
  return candidates;
}

function recommendationViews(customers: CustomerRecord[], actions: RevenueActionRow[]): RecommendationView[] {
  const actionsByCustomer = new Map(actions.map((action) => [action.customer_id, action] as const));
  const views: RecommendationView[] = [];
  const seen = new Set<string>();
  for (const customer of customers) {
    const safety = contactSafety(customer);
    const governed = actionsByCustomer.get(customer.customerId);
    const economics: Partial<Record<GrowthServiceCode, { expectedRevenue: number }>> = {};
    const governedTarget = parseJson<RevenueSignals>(governed?.signals_json, {}).serviceGaps?.[0];
    const normalizedTarget = governedTarget ? normalizeService(governedTarget) : null;
    if (normalizedTarget && governed && Number(governed.expected_revenue) > 0) economics[normalizedTarget] = { expectedRevenue: Number(governed.expected_revenue) };

    for (const pet of customer.pets) {
      const recommendations = evaluatePetNextBestService({
        pet: { petId: pet.id, species: pet.species, breed: pet.breed, ageMonths: null },
        serviceHistory: historyFacts(customer.bookings),
        economics,
        hasOpenComplaint: false,
        hasUnresolvedRefund: false,
      });
      for (const recommendation of recommendations) {
        const key = `${customer.customerId}:${recommendation.targetService}`;
        if (seen.has(key)) continue;
        seen.add(key);
        views.push({ key, recommendation, householdName: customer.name, petName: pet.name, safety });
      }
    }
  }
  return views;
}

function metrics(customers: CustomerRecord[], actions: RevenueActionRow[]) {
  const crossSell = actions.filter((action) => action.opportunity_type === "cross_sell");
  const pipeline = crossSell.filter((action) => !["completed", "suppressed"].includes(action.status)).reduce((sum, action) => sum + Math.max(0, Number(action.expected_revenue) || 0), 0);
  const serviceCustomers = customers.filter((customer) => customer.bookings.some((booking) => booking.status === "completed"));
  const attached = serviceCustomers.filter((customer) => new Set(customer.bookings.filter((booking) => booking.status === "completed").map((booking) => booking.serviceCode)).size > 1);
  const attachRate = serviceCustomers.length ? (attached.length / serviceCustomers.length) * 100 : 0;
  const conversionBase = crossSell.filter((action) => action.status !== "suppressed");
  const conversionRate = conversionBase.length ? (conversionBase.filter((action) => action.status === "completed").length / conversionBase.length) * 100 : 0;
  return { pipeline, attachRate, conversionRate };
}

function money(value: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
}

export default function CrossSellCommandCenter() {
  const [customers, setCustomers] = useState<CustomerRecord[]>([]);
  const [actions, setActions] = useState<RevenueActionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    Promise.all([fetch("/api/customer-360", { cache: "no-store" }), fetch("/api/revenue-intelligence", { cache: "no-store" })])
      .then(async ([customerResponse, actionResponse]) => {
        const customerPayload = await customerResponse.json() as { data?: { records?: CustomerRecord[] }; error?: string };
        const actionPayload = await actionResponse.json() as { data?: { actions?: RevenueActionRow[] }; error?: string };
        if (!customerResponse.ok) throw new Error(customerPayload.error || "Customer 360 unavailable");
        if (!actionResponse.ok) throw new Error(actionPayload.error || "Revenue intelligence unavailable");
        if (!active) return;
        setCustomers(customerPayload.data?.records ?? []);
        setActions(actionPayload.data?.actions ?? []);
      })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : "Growth command center unavailable"); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  const summary = useMemo(() => metrics(customers, actions), [customers, actions]);
  const workQueue = useMemo(() => queueCandidates(customers, actions), [customers, actions]);
  const recommendations = useMemo(() => recommendationViews(customers, actions), [customers, actions]);

  return <main className={styles.shell}><div className={styles.page}>
    <header className={styles.hero}><div><span>V2 · GROWTH & RETENTION OS</span><h1>Cross-Sell Command Center</h1><p>Explainable next-best-service intelligence, one governed work queue, and contact-safety enforcement for the sales and retention team.</p></div><nav aria-label="Command center navigation"><Link href="/team/sales">Customer 360</Link><Link href="/team">Team home</Link></nav></header>
    <section className={styles.metrics} aria-label="Cross-sell metrics"><article><span>Cross-Sell Revenue Pipeline</span><strong>{money(summary.pipeline)}</strong><small>Active governed cross-sell estimates</small></article><article><span>Attach Rate</span><strong>{summary.attachRate.toFixed(1)}%</strong><small>Customers with 2+ completed services</small></article><article><span>Conversion Rate</span><strong>{summary.conversionRate.toFixed(1)}%</strong><small>Completed ÷ non-suppressed cross-sell actions</small></article></section>
    {loading && <div className={styles.state}>Loading canonical growth signals…</div>}{error && <div className={`${styles.state} ${styles.error}`}>{error}</div>}
    {!loading && !error && <><UnifiedWorkQueue candidates={workQueue} /><section className={styles.recommendations} aria-labelledby="next-best-service-title"><header className={styles.sectionHeader}><div><span>EXPLAINABLE CROSS-SELL</span><h2 id="next-best-service-title">Next Best Service</h2></div><small>{recommendations.length} recommendation{recommendations.length === 1 ? "" : "s"}</small></header><div className={styles.recommendationGrid}>{recommendations.map((view) => <NextBestServiceCard key={view.key} recommendation={view.recommendation} householdName={view.householdName} petName={view.petName} safety={view.safety} />)}</div>{recommendations.length === 0 && <div className={styles.emptyState}><strong>No explainable next-best-service recommendation is ready.</strong><span>The engine only emits recommendations supported by canonical service history; missing pet-age or stated-intent signals are not guessed.</span></div>}</section></>}
    <footer className={styles.footnote}>Priority uses the governed V2 scoring contract. Unknown capacity remains neutral; missing pet age, stated intent, economics, and contribution are never fabricated.</footer>
  </div></main>;
}
