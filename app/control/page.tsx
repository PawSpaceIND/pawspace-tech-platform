"use client";
/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import { useEffect, useState } from "react";
import styles from "./control.module.css";
import CouponsControlPanel from "./coupons-control-panel";
import ReferralsControlPanel from "./referrals-control-panel";
import CityControlPanel from "./city-control-panel";
import AccessControlPanel from "./access-control-panel";
import CustomerDataPanel from "./customer-data-panel";
import GroomingSubscriptionsPanel from "./grooming-subscriptions-panel";
import BusinessIntelligencePanel from "./business-intelligence-panel";
import PlatformAuditPanel from "./platform-audit-panel";
import SchedulingControlPanel from "./scheduling-control-panel";
import PricingControlPanel from "./pricing-control-panel";
import MarketingControlPanel from "./marketing-control-panel";
import FinanceControlPanel from "./finance-control-panel";
import LaunchReadinessPanel from "./launch-readiness-panel";
import BookingLifecyclePanel from "./booking-lifecycle-panel";
type View =
  | "command"
  | "launch"
  | "lifecycle"
  | "audit"
  | "business"
  | "scheduling"
  | "pricing"
  | "marketing"
  | "finance"
  | "access"
  | "access2"
  | "approvals"
  | "master"
  | "cities"
  | "coupons"
  | "referrals"
  | "subscriptions"
  | "data"
  | "data2"
  | "inventory"
  | "quality"
  | "security"
  | "health";
// No badge counts: the sidebar used to carry fixed numbers (12 launch items, 386 subscriptions,
// 1,304 customer records, 9 approvals...) that were literals and never moved. Each module shows its
// own real counts once opened.
const nav: { id: View; label: string; icon: string; count?: number }[] = [
  { id: "command", label: "Control tower", icon: "⌂" },
  { id: "launch", label: "Launch essentials", icon: "◎" },
  { id: "lifecycle", label: "Customer booking lifecycle", icon: "⛓" },
  { id: "audit", label: "Platform audit & release", icon: "✓" },
  { id: "business", label: "Business 360 & reports", icon: "▥" },
  { id: "scheduling", label: "Auto-scheduling", icon: "◷" },
  { id: "pricing", label: "Pricing, packages & slots", icon: "₹" },
  { id: "marketing", label: "Marketing command center", icon: "↗" },
  { id: "finance", label: "Finance, expenses & accounts", icon: "₹" },
  { id: "access2", label: "Users, roles & access", icon: "♟" },
  { id: "approvals", label: "Approvals", icon: "✓" },
  { id: "master", label: "Master settings", icon: "⚙" },
  { id: "cities", label: "Cities & geofences", icon: "◎" },
  {
    id: "subscriptions",
    label: "Grooming subscriptions",
    icon: "◈",
  },
  { id: "coupons", label: "Coupon management", icon: "₹" },
  { id: "referrals", label: "Referral management", icon: "↗" },
  { id: "data2", label: "Customer data & contact", icon: "⇄" },
  { id: "inventory", label: "Inventory & buying", icon: "▦" },
  { id: "quality", label: "Quality & incidents", icon: "◆" },
  { id: "security", label: "Privacy & security", icon: "◇" },
  { id: "health", label: "System health", icon: "⚡" },
];
const roles = [
  ["Super Admin", "2", "All modules + settings", "Critical"],
  ["Operations Manager", "6", "Bookings, staff, tickets", "High"],
  ["CRM & Sales", "14", "Customers, leads, campaigns", "Medium"],
  ["Accounts", "3", "Payments, GST, payouts", "Critical"],
  ["HR & Payroll", "2", "People, attendance, payroll", "High"],
  ["Service Partner", "94", "Assigned jobs and earnings", "Low"],
];
const modules = [
  [
    "Platform audit & release",
    "Evidence, gaps, owners and launch gates",
    "14 areas",
    "audit",
  ],
  [
    "Roles & access",
    "Least privilege, masking and quarterly reviews",
    "Partial",
    "access",
  ],
  [
    "Approval policies",
    "Maker-checker for money, exports, fines and settings",
    "Prototype",
    "approvals",
  ],
  [
    "Master configuration",
    "Services, prices, slots, zones, taxes and commissions",
    "Partial",
    "master",
  ],
  [
    "Data governance",
    "Imports, dedupe, consent, retention and merges",
    "Partial",
    "data",
  ],
  [
    "Inventory & buying",
    "Consumables, food, kits, vendors and wastage",
    "Prototype",
    "inventory",
  ],
  [
    "Quality & incidents",
    "Pet safety, complaints, CAPA and insurance",
    "Prototype",
    "quality",
  ],
  [
    "Privacy & security",
    "MFA, consent, encryption, backup and deletion",
    "P0 gaps",
    "security",
  ],
  [
    "System health",
    "Build gates, integrations and recovery evidence",
    "UAT only",
    "health",
  ],
];
type ApprovalsSummary = { pending: number | null };

export default function Control() {
  const [view, setView] = useState<View>("command");
  // Real approval backlog for the approvals view (see the tile comments below).
  const [approvals, setApprovals] = useState<ApprovalsSummary>({ pending: null });
  useEffect(() => {
    let on = true;
    void fetch("/api/team-overview", { cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<{ data?: { approvals?: ApprovalsSummary } }> : Promise.reject(new Error("unavailable")))
      .then((body) => { if (on && body.data?.approvals) setApprovals({ pending: body.data.approvals.pending ?? null }); })
      .catch(() => { /* leave the tile as "—" rather than inventing a backlog */ });
    return () => { on = false; };
  }, []);
  const [role, setRole] = useState(roles[0]);
  const [toast, setToast] = useState("");
  const [flags, setFlags] = useState([true, true, false, false, true]);
  const notify = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2300);
  };
  const title = nav.find((n) => n.id === view)?.label;
  return (
    <main className={styles.shell}>
      <aside className={styles.side}>
        <Link href="/team" className={styles.brand}>
          <img src="/assets/pawspace-logo.jpeg" alt="PawSpace" />
          <div>
            <strong>Platform Control</strong>
            <span>GOVERN · SECURE · SCALE</span>
          </div>
        </Link>
        <div className={styles.workspace}>
          <span>OWNER WORKSPACE</span>
          <strong>PawSpace India</strong>
          <small>Restricted prototype</small>
        </div>
        <nav>
          {nav.map((n) => (
            <button
              key={n.id}
              className={view === n.id ? styles.active : ""}
              onClick={() => setView(n.id)}
            >
              <i>{n.icon}</i>
              <span>{n.label}</span>
              {n.count && <b>{n.count}</b>}
            </button>
          ))}
        </nav>
        <div className={styles.layers}>
          <span>CONNECTED LAYERS</span>
          <p>● Customer + partner apps</p>
          <p>● Admin + CRM + Finance</p>
          <p>● Automation + integrations</p>
          <p>● Governance + data</p>
        </div>
        <div className={styles.user}>
          <i>KP</i>
          <div>
            <strong>Karthik</strong>
            <small>Owner · highest privilege</small>
          </div>
        </div>
      </aside>
      <section className={styles.main}>
        <header>
          <div>
            <p>PAWSPACE PLATFORM GOVERNANCE</p>
            <h1>{title}</h1>
          </div>
          <button onClick={() => notify("Emergency control panel opened")}>
            Emergency controls
          </button>
        </header>
        {view === "command" && (
          <>
            <section className={styles.hero}>
              <div>
                <span>PLATFORM ASSURANCE · TEST DATA</span>
                <h2>One place to control the whole company.</h2>
                <p>
                  Who can do what, which rule is active, what changed, where
                  data came from, what failed and who must resolve it.
                </p>
              </div>
              <strong>
                UAT<small>launch candidate</small>
              </strong>
              <button onClick={() => setView("audit")}> 
                Open full audit →
              </button>
            </section>
            <section className={styles.metrics}>
              {[
                ["Audited areas", "14", "App to reliability"],
                ["Verified requirements", "84", "Evidence in current build"],
                ["Partial requirements", "90", "Connection or completion due"],
                ["P0 release blockers", "5", "Before public launch"],
              ].map((x) => (
                <article key={x[0]}>
                  <span>{x[0]}</span>
                  <strong>{x[1]}</strong>
                  <small>{x[2]}</small>
                </article>
              ))}
            </section>
            <section className={styles.grid}>
              <div className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>OWNER SIGNALS</span>
                    <h2>Needs attention now</h2>
                  </div>
                </div>
                {[
                  [
                    "Critical",
                    "Accounts access review overdue",
                    "3 payout approvers",
                    "Review",
                  ],
                  [
                    "Data",
                    "Import needs consent mapping",
                    "4,816 contacts",
                    "Fix",
                  ],
                  ["Safety", "Incident awaiting CAPA", "INC-2041", "Open"],
                  ["Stock", "Food tubs below buffer", "3 days left", "Buy"],
                  [
                    "System",
                    "Webhook delay recovered",
                    "12 messages",
                    "Inspect",
                  ],
                ].map((x) => (
                  <button
                    className={styles.signal}
                    key={x[1]}
                    onClick={() => notify(`${x[1]} opened`)}
                  >
                    <i>{x[0]}</i>
                    <div>
                      <strong>{x[1]}</strong>
                      <small>{x[2]}</small>
                    </div>
                    <b>{x[3]} →</b>
                  </button>
                ))}
              </div>
              <aside className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>CONTROL COVERAGE</span>
                    <h2>Assurance areas</h2>
                  </div>
                </div>
                {[
                  ["Identity & access", 94],
                  ["Financial approvals", 97],
                  ["Customer privacy", 88],
                  ["Data reliability", 91],
                  ["Safety & quality", 86],
                  ["Recovery", 93],
                ].map((x) => (
                  <article className={styles.bar} key={x[0] as string}>
                    <span>{x[0] as string}</span>
                    <i>
                      <b style={{ width: `${x[1]}%` }}></b>
                    </i>
                    <strong>{x[1]}</strong>
                  </article>
                ))}
              </aside>
            </section>
            <section className={styles.modules}>
              {modules.map((x) => (
                <article key={x[0]}>
                  <i>◆</i>
                  <strong>{x[0]}</strong>
                  <p>{x[1]}</p>
                  <span>{x[2]}</span>
                  <button onClick={() => setView(x[3] as View)}>Open →</button>
                </article>
              ))}
            </section>
          </>
        )}
        {view === "launch" && <LaunchReadinessPanel />}
        {view === "lifecycle" && <BookingLifecyclePanel />}
        {view === "access" && (
          <>
            <section className={styles.hero}>
              <div>
                <span>ZERO-TRUST ACCESS</span>
                <h2>Every person sees only what their job requires.</h2>
                <p>
                  Customer details are masked, high-risk access is reviewed and
                  privileged sessions require stronger authentication.
                </p>
              </div>
              <button onClick={() => notify("Role builder opened")}>
                ＋ Create role
              </button>
            </section>
            <section className={styles.grid}>
              <div className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>ROLE DIRECTORY</span>
                    <h2>Access profiles</h2>
                  </div>
                  <button onClick={() => notify("Quarterly review started")}>
                    Review access
                  </button>
                </div>
                {roles.map((r) => (
                  <button
                    className={`${styles.role} ${role[0] === r[0] ? styles.selected : ""}`}
                    key={r[0]}
                    onClick={() => setRole(r)}
                  >
                    <strong>{r[0]}</strong>
                    <span>{r[1]} people</span>
                    <span>{r[2]}</span>
                    <b>{r[3]}</b>
                  </button>
                ))}
              </div>
              <aside className={styles.panel}>
                <span className={styles.kicker}>SELECTED ROLE</span>
                <h2>{role[0]}</h2>
                <p className={styles.muted}>
                  {role[1]} assigned identities · {role[3]} risk
                </p>
                {[
                  ["View customer mobile", "Allowed"],
                  [
                    "Export customer data",
                    role[3] === "Low" ? "Blocked" : "Approval",
                  ],
                  [
                    "Create refund",
                    role[0] === "Accounts" ? "Allowed" : "Blocked",
                  ],
                  ["Approve own transaction", "Blocked"],
                  ["View bank account", "Masked"],
                  [
                    "Change settings",
                    role[0] === "Super Admin" ? "Allowed" : "Blocked",
                  ],
                ].map((x) => (
                  <article className={styles.permission} key={x[0]}>
                    <span>{x[0]}</span>
                    <b>{x[1]}</b>
                  </article>
                ))}
                <button
                  className={styles.primary}
                  onClick={() => notify("Role edit entered approval")}
                >
                  Edit with approval
                </button>
              </aside>
            </section>
            <section className={styles.notice}>
              <i>✓</i>
              <div>
                <strong>Separation of duties</strong>
                <p>
                  Payout creator cannot approve payout; refund requester cannot
                  approve refund; payroll processor cannot give final payroll
                  approval.
                </p>
              </div>
            </section>
          </>
        )}
        {view === "approvals" && (
          <>
            <section className={styles.metrics}>
              {[
                // Pending is real: reviewed payroll runs + calculated incentive results + draft
                // commercial terms, all genuinely waiting on a second person. Approval timing and
                // throughput have no canonical source, so they say so rather than inventing one -
                // matching how the infrastructure tiles on this page already report gaps.
                ["Pending", approvals.pending == null ? "—" : String(approvals.pending), approvals.pending == null ? "Approval queues unavailable" : "Awaiting a second approver"],
                ["SLA risk", "Not measured", "Approval timing not recorded"],
                ["Approved today", "Not measured", "Approval throughput not recorded"],
                ["Auto-approved", "None", "Every approval is human"],
              ].map((x) => (
                <article key={x[0]}>
                  <span>{x[0]}</span>
                  <strong>{x[1]}</strong>
                  <small>{x[2]}</small>
                </article>
              ))}
            </section>
            <section className={styles.grid}>
              <div className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>OWNER INBOX</span>
                    <h2>High-impact decisions</h2>
                  </div>
                </div>
                {[
                  ["Refund above limit", "PS-2841 · ₹8,999", "18 min"],
                  ["Partner payout batch", "18 partners · ₹1,27,842", "44 min"],
                  ["Attendance fine reversal", "Sanjay · ₹300", "1h"],
                  ["Export customer data", "8,422 records", "2h"],
                  ["Change grooming price", "Makeover +₹200", "3h"],
                ].map((x) => (
                  <article className={styles.approval} key={x[0]}>
                    <div>
                      <strong>{x[0]}</strong>
                      <small>
                        {x[1]} · {x[2]}
                      </small>
                    </div>
                    <button onClick={() => notify("Evidence opened")}>
                      Review
                    </button>
                    <button onClick={() => notify("Approved with audit note")}>
                      Approve
                    </button>
                  </article>
                ))}
              </div>
              <aside className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>POLICY ENGINE</span>
                    <h2>Maker-checker</h2>
                  </div>
                </div>
                {[
                  ["Refunds", "3 approval levels"],
                  ["Payouts", "Two-person release"],
                  ["Customer exports", "Purpose + expiry"],
                  ["Price changes", "Simulate then publish"],
                  ["Fines", "Evidence + response"],
                  ["Production access", "Time-limited"],
                ].map((x) => (
                  <article className={styles.permission} key={x[0]}>
                    <span>{x[0]}</span>
                    <b>{x[1]}</b>
                  </article>
                ))}
              </aside>
            </section>
          </>
        )}
        {view === "master" && (
          <>
            <section className={styles.hero}>
              <div>
                <span>NO-CODE CONFIGURATION</span>
                <h2>Change rules without changing the app.</h2>
                <p>
                  Every change is versioned, tested against historical orders,
                  approved, scheduled and rollback-ready.
                </p>
              </div>
              <button onClick={() => notify("New draft opened")}>
                ＋ Draft
              </button>
            </section>
            <section className={styles.modules}>
              {[
                ["Service catalogue", "7 services · 38 packages"],
                ["Pricing & discounts", "Peak, off-peak, season and coupon rules", "pricing"],
                ["Slots & capacity", "Service duration, blocking and buffers", "pricing"],
                [
                  "Cities, zones & travel",
                  "Geofence + city price book",
                  "cities",
                ],
                ["Assignment logic", "Skills, route, ratings, workload"],
                ["Commission & incentives", "22 earning rules"],
                ["Cancellation & validity", "16 policies"],
                ["GST & invoicing", "18 controls"],
                ["Notifications", "64 templates · 5 languages"],
                ["Safety SOPs", "31 SOPs"],
              ].map((x) => (
                <article key={x[0]}>
                  <i>⚙</i>
                  <strong>{x[0]}</strong>
                  <p>{x[1]}</p>
                  <span>Version controlled</span>
                  <button
                    onClick={() =>
                      x[2] === "cities"
                        ? setView("cities")
                        : x[2] === "pricing"
                          ? setView("pricing")
                        : notify(`${x[0]} editor opened`)
                    }
                  >
                    Configure →
                  </button>
                </article>
              ))}
            </section>
            <section className={styles.flow}>
              {[
                "Draft",
                "Validate",
                "Simulate",
                "Approve",
                "Publish",
                "Rollback",
              ].map((x, i) => (
                <article key={x}>
                  <i>{i + 1}</i>
                  <strong>{x}</strong>
                </article>
              ))}
            </section>
          </>
        )}
        {view === "audit" && <PlatformAuditPanel />}
        {view === "cities" && <CityControlPanel notify={notify} />}
        {view === "business" && <BusinessIntelligencePanel notify={notify} />}
        {view === "scheduling" && <SchedulingControlPanel notify={notify} />}
        {view === "pricing" && <PricingControlPanel notify={notify} />}
        {view === "marketing" && <MarketingControlPanel notify={notify} />}
        {view === "finance" && <FinanceControlPanel notify={notify} />}
        {view === "access2" && <AccessControlPanel />}
        {view === "data2" && <CustomerDataPanel />}
        {view === "subscriptions" && (
          <GroomingSubscriptionsPanel notify={notify} />
        )}
        {view === "coupons" && <CouponsControlPanel notify={notify} />}
        {view === "referrals" && <ReferralsControlPanel notify={notify} />}
        {view === "data" && (
          <>
            <section className={styles.hero}>
              <div>
                <span>DATA MIGRATION CENTRE</span>
                <h2>Turn 50,000 contacts into trusted profiles.</h2>
                <p>
                  Map fields, remove duplicates, retain history, record consent
                  and import in reversible batches.
                </p>
              </div>
              <strong>
                91.4<small>% quality</small>
              </strong>
            </section>
            <section className={styles.steps}>
              {[
                "Upload",
                "Map fields",
                "Dedupe",
                "Consent",
                "Dry run",
                "Import",
              ].map((x, i) => (
                <article key={x} className={i < 3 ? styles.done : ""}>
                  <i>{i < 3 ? "✓" : i + 1}</i>
                  <strong>{x}</strong>
                </article>
              ))}
            </section>
            <section className={styles.grid}>
              <div className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>CONTACT MASTER</span>
                    <h2>Assessment</h2>
                  </div>
                  <button onClick={() => notify("Report exported")}>
                    Report ↓
                  </button>
                </div>
                {[
                  ["Total rows", "50,284", 100],
                  ["Valid primary mobile", "47,918", 95],
                  ["Duplicate households", "6,482", 13],
                  ["Pet name captured", "31,860", 63],
                  ["Service history", "28,442", 57],
                  ["Consent proven", "45,468", 90],
                  ["Quarantine", "1,218", 2],
                ].map((x) => (
                  <article className={styles.stat} key={x[0] as string}>
                    <span>{x[0] as string}</span>
                    <i>
                      <b style={{ width: `${x[2]}%` }}></b>
                    </i>
                    <strong>{x[1]}</strong>
                  </article>
                ))}
              </div>
              <aside className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>MERGE PREVIEW</span>
                    <h2>Possible duplicate</h2>
                  </div>
                </div>
                <article className={styles.record}>
                  <span>CRM</span>
                  <strong>Ananya Rao · Bruno</strong>
                  <small>99969 48102 · Grooming subscription</small>
                </article>
                <article className={styles.record}>
                  <span>SPREADSHEET</span>
                  <strong>Ananya R · Bruno</strong>
                  <small>9996948102 · Training lead</small>
                </article>
                <div className={styles.result}>
                  <strong>Proposed Customer 360</strong>
                  <p>
                    Normalize phone, retain both source histories and combine
                    grooming + training journeys.
                  </p>
                  <button onClick={() => notify("Merge rule approved")}>
                    Approve merge
                  </button>
                </div>
              </aside>
            </section>
          </>
        )}
        {view === "inventory" && (
          <>
            <section className={styles.metrics}>
              {[
                ["Inventory value", "₹8.42L", "Central + field kits"],
                ["Below reorder", "7", "2 critical"],
                ["Open POs", "₹1.28L", "4 vendors"],
                ["Wastage", "₹18,420", "1.8% consumption"],
              ].map((x) => (
                <article key={x[0]}>
                  <span>{x[0]}</span>
                  <strong>{x[1]}</strong>
                  <small>{x[2]}</small>
                </article>
              ))}
            </section>
            <section className={styles.grid}>
              <div className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>STOCK CONTROL</span>
                    <h2>Consumables, food and kits</h2>
                  </div>
                  <button onClick={() => notify("Purchase request opened")}>
                    ＋ Request
                  </button>
                </div>
                {[
                  ["500 ml food tubs", "320 / 500", "3 days", "Critical"],
                  ["Oatmeal shampoo · 5L", "18 / 12", "14 days", "Healthy"],
                  ["Disposable towels", "420 / 600", "5 days", "Low"],
                  ["Training treat pouches", "34 / 20", "21 days", "Healthy"],
                  ["Pet seat covers", "22 / 15", "18 days", "Healthy"],
                  ["Sanitiser", "12 / 10", "9 days", "Watch"],
                ].map((x) => (
                  <article className={styles.stock} key={x[0]}>
                    <div>
                      <strong>{x[0]}</strong>
                      <small>Available / reorder</small>
                    </div>
                    <b>{x[1]}</b>
                    <span>{x[2]}</span>
                    <i>{x[3]}</i>
                  </article>
                ))}
              </div>
              <aside className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>AUTOMATED BUYING</span>
                    <h2>Replenishment</h2>
                  </div>
                </div>
                {[
                  ["500 ml tubs", "1,500 units", "₹18,750"],
                  ["Disposable towels", "2,000", "₹22,000"],
                  ["Grooming gloves", "500 pairs", "₹12,500"],
                  ["Disinfectant", "60 litres", "₹19,800"],
                ].map((x) => (
                  <article className={styles.purchase} key={x[0]}>
                    <div>
                      <strong>{x[0]}</strong>
                      <small>{x[1]}</small>
                    </div>
                    <b>{x[2]}</b>
                    <button onClick={() => notify("Vendor comparison opened")}>
                      Compare
                    </button>
                  </article>
                ))}
              </aside>
            </section>
            <section className={styles.modules}>
              {[
                ["Purchase workflow", "Request → quote → approve → PO"],
                ["Goods receipt", "Batch, expiry, quantity and quality"],
                ["Staff kit custody", "Issue, consume, return and damage"],
                ["Food production", "Ingredients, batch, yield and expiry"],
                ["Wastage", "Reason, photo, approval and cost"],
                ["Vendors", "Price, quality, lead time and GST"],
              ].map((x) => (
                <article key={x[0]}>
                  <i>▦</i>
                  <strong>{x[0]}</strong>
                  <p>{x[1]}</p>
                  <button>Open →</button>
                </article>
              ))}
            </section>
          </>
        )}
        {view === "quality" && (
          <>
            <section className={styles.hero}>
              <div>
                <span>PET SAFETY & QUALITY</span>
                <h2>Detect, respond, learn and prevent.</h2>
                <p>
                  Incidents connect to booking, pet, provider, product batch,
                  evidence, customer updates and corrective action.
                </p>
              </div>
              <button onClick={() => notify("Incident form opened")}>
                ＋ Report
              </button>
            </section>
            <section className={styles.grid}>
              <div className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>ACTIVE CASES</span>
                    <h2>Incident & CAPA queue</h2>
                  </div>
                </div>
                {[
                  [
                    "High",
                    "Skin irritation after grooming",
                    "Bruno · PS-2841",
                    "Investigating",
                  ],
                  [
                    "Medium",
                    "Sitter medication 30 min late",
                    "Milo · ST-1192",
                    "CAPA due",
                  ],
                  [
                    "Low",
                    "Taxi reached wrong gate",
                    "Coco · TX-1882",
                    "Resolved",
                  ],
                ].map((x) => (
                  <button
                    className={styles.case}
                    key={x[1]}
                    onClick={() => notify("Case timeline opened")}
                  >
                    <i>{x[0]}</i>
                    <div>
                      <strong>{x[1]}</strong>
                      <small>{x[2]}</small>
                    </div>
                    <b>{x[3]}</b>
                  </button>
                ))}
              </div>
              <aside className={styles.panel}>
                <span className={styles.kicker}>INC-2041</span>
                <h2>Skin irritation after grooming</h2>
                <p className={styles.muted}>
                  Customer safe · product batch quarantined · groomer statement
                  pending.
                </p>
                {[
                  "Customer triage completed",
                  "Veterinary consultation offered",
                  "Product batch traced",
                  "Provider statement requested",
                  "Corrective action owner assigned",
                ].map((x) => (
                  <article className={styles.permission} key={x}>
                    <span>✓ {x}</span>
                  </article>
                ))}
                <button
                  className={styles.primary}
                  onClick={() => notify("Customer update sent")}
                >
                  Send customer update
                </button>
              </aside>
            </section>
            <section className={styles.modules}>
              {[
                ["Service-proof QA", "Before/after evidence"],
                ["Provider score", "Ratings, complaints and SOP"],
                ["Product traceability", "Batch by order"],
                ["Complaint recovery", "Resolve and confirm"],
                ["CAPA library", "Root cause and prevention"],
                ["Insurance", "Documents and claims"],
              ].map((x) => (
                <article key={x[0]}>
                  <i>◆</i>
                  <strong>{x[0]}</strong>
                  <p>{x[1]}</p>
                  <span>Active</span>
                </article>
              ))}
            </section>
          </>
        )}
        {view === "security" && (
          <>
            <section className={styles.hero}>
              <div>
                <span>PRIVACY, SECURITY & CONTINUITY</span>
                <h2>Protect customer trust before automation scales.</h2>
                <p>
                  Consent, masking, encryption, MFA, retention, backups, vendor
                  reviews and privacy requests become platform rules.
                </p>
              </div>
              <strong>
                93<small>% ready</small>
              </strong>
            </section>
            <section className={styles.modules}>
              {[
                ["Consent & opt-out", "Channel, purpose, source and timestamp"],
                ["Privacy requests", "Access, correct and delete"],
                ["Sensitive-data masking", "Phone, address, bank and PAN"],
                ["Authentication", "OTP, MFA and device review"],
                ["Encryption & secrets", "Keys, vault and rotation"],
                ["Backup & recovery", "Daily backup and restore drills"],
                ["Security incidents", "Detect, contain and investigate"],
                ["Retention", "Anonymise and deletion proof"],
                ["Vendor risk", "Contracts, access and offboarding"],
              ].map((x) => (
                <article key={x[0]}>
                  <i>◇</i>
                  <strong>{x[0]}</strong>
                  <p>{x[1]}</p>
                  <span>Control ready</span>
                  <button onClick={() => notify(`${x[0]} controls opened`)}>
                    Review →
                  </button>
                </article>
              ))}
            </section>
            <section className={styles.notice}>
              <i>!</i>
              <div>
                <strong>Production rule</strong>
                <p>
                  External vendors receive only the minimum data needed, for a
                  documented purpose, with access revocation and audit evidence.
                </p>
              </div>
            </section>
          </>
        )}
        {view === "health" && (
          <>
            <section className={styles.hero}>
              <div>
                <span>RELEASE OBSERVABILITY · TEST MODE</span>
                <h2>Build healthy · production telemetry not connected</h2>
                <p>
                  These checks verify the review build and sandbox contracts.
                  They do not claim live-customer uptime, delivery, payment,
                  location or backup evidence.
                </p>
              </div>
              <strong>
                ●<small>UAT only</small>
              </strong>
            </section>
            <section className={styles.metrics}>
              {[
                ["Production uptime", "Not measured", "Monitoring required"],
                ["Live failed events", "Not connected", "Event queue required"],
                ["Live queue depth", "Not connected", "Worker required"],
                ["Restore evidence", "Missing", "P0 release blocker"],
              ].map((x) => (
                <article key={x[0]}>
                  <span>{x[0]}</span>
                  <strong>{x[1]}</strong>
                  <small>{x[2]}</small>
                </article>
              ))}
            </section>
            <section className={styles.health}>
              {[
                [
                  "Customer booking",
                  "Verified prototype",
                  "Build gate",
                  "Test journeys",
                ],
                [
                  "Admin, CRM & Ops",
                  "Partial",
                  "Build gate",
                  "Mixed DB + fixtures",
                ],
                ["Razorpay events", "Sandbox contract", "—", "Not connected"],
                ["RazorpayX payouts", "Sandbox contract", "—", "Not connected"],
                [
                  "WhatsApp / LimeChat",
                  "Integration-ready",
                  "—",
                  "Not connected",
                ],
                ["Notification queue", "Designed", "—", "Worker missing"],
                ["Maps & tracking", "Simulated GPS/ETA", "—", "Not connected"],
                [
                  "Customer database",
                  "Partial persistence",
                  "—",
                  "Canonical store missing",
                ],
              ].map((x) => (
                <article key={x[0]}>
                  <strong>{x[0]}</strong>
                  <span>{x[1]}</span>
                  <b>{x[2]}</b>
                  <small>{x[3]}</small>
                  <button onClick={() => setView("audit")}>Audit →</button>
                </article>
              ))}
            </section>
            <section className={styles.grid}>
              <div className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>SAFE ROLLOUT</span>
                    <h2>Feature flags</h2>
                  </div>
                </div>
                {[
                  ["New checkout", "Internal UAT"],
                  ["Family wallet", "Test records"],
                  ["Automatic payouts", "Off · sandbox only"],
                  ["AI voice outbound", "Off · consent review"],
                  ["Tracking v2", "Simulated"],
                ].map((x, i) => (
                  <article className={styles.flag} key={x[0]}>
                    <button
                      className={flags[i] ? styles.on : ""}
                      onClick={() =>
                        setFlags((a) => a.map((v, j) => (i === j ? !v : v)))
                      }
                    >
                      <i></i>
                    </button>
                    <div>
                      <strong>{x[0]}</strong>
                      <small>{x[1]}</small>
                    </div>
                    <b>{flags[i] ? "Test on" : "Off"}</b>
                  </article>
                ))}
              </div>
              <aside className={styles.panel}>
                <div className={styles.head}>
                  <div>
                    <span>RECOVERY EVIDENCE</span>
                    <h2>Business continuity</h2>
                  </div>
                </div>
                {[
                  ["Database backup", "Not configured"],
                  ["Restore drill", "Not run"],
                  ["Webhook replay", "Sandbox contract"],
                  ["Fallback messaging", "Designed"],
                  ["Manual booking SOP", "Needs sign-off"],
                  ["Emergency owner access", "Prototype"],
                ].map((x) => (
                  <article className={styles.permission} key={x[0]}>
                    <span>{x[0]}</span>
                    <b>{x[1]}</b>
                  </article>
                ))}
              </aside>
            </section>
          </>
        )}
      </section>
      {toast && <div className={styles.toast}>✓ {toast}</div>}
    </main>
  );
}
