"use client";
import { useState } from "react";
// R3-G / F4: this "back to the hub" cue was unconditional while /team/people needs people.view, so a
// child screen offered a door its own hub refuses. Same gate as every other link on the platform.
import{StaffGatedLink}from"../../../components/hub-workspace-links";

type Kind = "groomer" | "trainer" | "sales";

async function callApi(action: string, body: Record<string, unknown>) {
  const r = await fetch("/api/service-incentives", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
  const p = await r.json();
  if (!r.ok) throw new Error(p.error || "Request failed");
  return p;
}

async function loadResult(kind: Kind, employeeId: string, monthStart: string) {
  const r = await fetch(`/api/service-incentives?kind=${kind}&employeeId=${encodeURIComponent(employeeId)}&monthStart=${encodeURIComponent(monthStart)}`, { cache: "no-store" });
  const p = await r.json();
  if (!r.ok) throw new Error(p.error || "Load failed");
  return p;
}

const card: React.CSSProperties = { border: "1px solid #e3dbea", borderRadius: 14, padding: 18, background: "white", marginBottom: 16 };
const label: React.CSSProperties = { display: "block", fontSize: 12, fontWeight: 700, color: "#6a2daf", marginBottom: 4, marginTop: 10 };
const input: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid #ddd5e2", borderRadius: 8, fontSize: 13 };
const btn: React.CSSProperties = { marginTop: 12, padding: "9px 16px", border: 0, borderRadius: 8, background: "#6524a0", color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer" };
const btnOff: React.CSSProperties = { opacity: 0.45, cursor: "not-allowed" };
const hint: React.CSSProperties = { margin: "8px 0 0", fontSize: 12, color: "#8a2d2d" };
const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 };
const rankCell: React.CSSProperties = { border: "1px solid #e3dbea", padding: "6px 8px", textAlign: "left", whiteSpace: "nowrap" };

function Field({ text, onChange, placeholder, name }: { text: string; onChange: (v: string) => void; placeholder: string; name?: string }) {
  return <input style={input} name={name} value={text} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

/**
 * Which of a card's own required fields are still blank, named the way the operator sees them.
 *
 * Every money control on this screen used to read its employee id from the BRACKET card and its
 * month from the TARGET card, so filling in only the card in front of you posted headGroomerId:""
 * and the API answered 200 with a row belonging to nobody. Each card now owns its inputs, and this
 * is the gate that keeps a blank identity from being submitted silently in the first place. The API
 * refuses it as well - a disabled button is a courtesy, never the guarantee.
 */
export function missingFields(required: Record<string, string>): string[] {
  return Object.entries(required).filter(([, value]) => !String(value ?? "").trim()).map(([fieldLabel]) => fieldLabel);
}

/** A reason the engines accept: lib/grooming-incentive-engine.ts requires at least 8 characters. */
export function missingReason(reason: string, what = "a reason of at least 8 characters"): string[] {
  return reason.trim().length < 8 ? [what] : [];
}

/** A positive money amount, the way every engine on this route requires it. */
export function missingPositiveAmount(amount: string, what: string): string[] {
  return Number(amount) > 0 ? [] : [what];
}

/*
 * One card, one form. Each builder is a pure function of the fields of the card it belongs to, so a
 * control can no longer quietly read another card's state: there is nothing else in scope to read.
 */
export type BracketForm = { headGroomerId: string; bracket: "team" | "single"; helperId: string; effectiveFrom: string; reason: string };
export const bracketBody = (f: BracketForm) => ({ headGroomerId: f.headGroomerId.trim(), bracket: f.bracket, helperId: f.helperId.trim() || null, effectiveFrom: f.effectiveFrom.trim(), reason: f.reason });

export type TargetForm = { headGroomerId: string; monthStart: string; targetAmount: string };
export const targetBody = (f: TargetForm) => ({ headGroomerId: f.headGroomerId.trim(), monthStart: f.monthStart.trim(), targetAmount: Number(f.targetAmount), reason: "Monthly target published" });

export type AttendanceForm = { helperId: string; attendanceDate: string; status: "present" | "absent" };
export const attendanceBody = (f: AttendanceForm) => ({ helperId: f.helperId.trim(), attendanceDate: f.attendanceDate.trim(), status: f.status });

export type GpayForm = { headGroomerId: string; monthStart: string; gpayTotal: string; gpayPending: string };
export const gpayBody = (f: GpayForm) => ({ headGroomerId: f.headGroomerId.trim(), monthStart: f.monthStart.trim(), gpayTotal: Number(f.gpayTotal), gpayPending: Number(f.gpayPending) });

export type SpecialForm = { headGroomerId: string; monthStart: string; amount: string; reason: string };
export const specialBody = (f: SpecialForm) => ({ headGroomerId: f.headGroomerId.trim(), monthStart: f.monthStart.trim(), amount: Number(f.amount), reason: f.reason });

export type ReviewForm = { headGroomerId: string; monthStart: string };
export const reviewBody = (f: ReviewForm) => ({ headGroomerId: f.headGroomerId.trim(), monthStart: f.monthStart.trim() });

/**
 * `rank_groomers`, which no screen posted.
 *
 * app/api/service-incentives/route.ts has always accepted it and no .tsx in the product sent it, so
 * the month's ranking - and with it the winner bonus each bracket pays at rank 1, 2 and 3 - could
 * only be obtained with curl. It is a HUMAN control rather than a scheduled job:
 * lib/grooming-incentive-engine.ts rankGroomersForMonth() WRITES NOTHING (it computes each groomer's
 * achievement against their published target and sorts), worker/index.ts's `scheduled()` handler
 * never calls it, and the set of people being compared is a manager's choice - which salon, which
 * month, which groomers - not something a cron could know.
 *
 * The ids are entered as a list, and BLANK ENTRIES ARE DROPPED HERE, because one blank id in the
 * list is exactly what the route refuses with "Head groomer is required": it ranks nobody against
 * everybody else. Dropping them means the operator's trailing comma is not a refusal; the route's
 * guard still stands behind it.
 */
export type RankForm = { monthStart: string; headGroomerIds: string };
export const rankIds = (value: string) => String(value ?? "").split(/[\n,]/).map((id) => id.trim()).filter(Boolean);
export const rankBody = (f: RankForm) => ({ monthStart: f.monthStart.trim(), headGroomerIds: rankIds(f.headGroomerIds) });
/** A ranking needs a month and at least one identified head groomer; the engine needs both too. */
export function missingRanking(f: RankForm): string[] {
  return [...missingFields({ Month: f.monthStart }), ...(rankIds(f.headGroomerIds).length ? [] : ["at least one head groomer ID"])];
}

/**
 * A submit control that cannot be fired twice and cannot fire at all while its own card is
 * incomplete. `busy` holds the action currently in flight - any in-flight action disables every
 * control on the screen, because a second write to the same money configuration while the first is
 * still open is exactly how "Save bracket" clicked twice produced two bracket rows, the second of
 * which closed the first on the day it began.
 */
export function ActionButton({ action, busy, missing = [], onRun, children, tone, busyLabel = "Saving…" }: {
  action: string; busy: string; missing?: string[]; onRun: () => void; children: React.ReactNode; tone?: React.CSSProperties; busyLabel?: string;
}) {
  const blocked = missing.length > 0;
  const disabled = blocked || busy !== "";
  return (
    <div>
      <button type="button" disabled={disabled} onClick={onRun} style={{ ...btn, ...(tone || {}), ...(disabled ? btnOff : {}) }}>
        {busy === action ? busyLabel : children}
      </button>
      {blocked && <p style={hint}>Still needs {missing.join(", ")} - nothing is sent until this card is complete.</p>}
    </div>
  );
}

export default function ServiceIncentivesPage() {
  const [tab, setTab] = useState<Kind>("groomer");
  const [toast, setToast] = useState("");
  const [busy, setBusy] = useState("");
  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(""), 3200); };
  const run = (action: string, work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(action);
    work().catch((e: Error) => flash(`Error: ${e.message}`)).finally(() => setBusy(""));
  };
  const runAction = (action: string, body: Record<string, unknown>, successMsg: string) =>
    run(action, () => callApi(action, body).then((r) => flash(`${successMsg}: ${JSON.stringify(r).slice(0, 200)}`)));

  // Lookup panel — its month belongs to this panel and to nothing else.
  const [lookupEmployee, setLookupEmployee] = useState("");
  const [lookupMonth, setLookupMonth] = useState("2026-08-01");
  const [lookupResult, setLookupResult] = useState<Record<string, unknown> | null>(null);
  const runLookup = () => run("lookup", () => loadResult(tab, lookupEmployee.trim(), lookupMonth.trim()).then(setLookupResult));

  // Groomer — bracket card
  const [gHead, setGHead] = useState(""), [gHelper, setGHelper] = useState(""), [gBracket, setGBracket] = useState<"team" | "single">("team"), [gReason, setGReason] = useState(""), [gBracketFrom, setGBracketFrom] = useState("2026-08-01");
  // Groomer — monthly target card
  const [gTargetHead, setGTargetHead] = useState(""), [gTargetMonth, setGTargetMonth] = useState("2026-08-01"), [gTargetAmount, setGTargetAmount] = useState("");
  // Groomer — helper attendance card
  const [gAttendHelper, setGAttendHelper] = useState(""), [gAttendDate, setGAttendDate] = useState(""), [gAttendStatus, setGAttendStatus] = useState<"present" | "absent">("absent");
  // Groomer — Gpay ledger card
  const [gGpayHead, setGGpayHead] = useState(""), [gGpayMonth, setGGpayMonth] = useState("2026-08-01"), [gGpayTotal, setGGpayTotal] = useState(""), [gGpayPending, setGGpayPending] = useState("");
  // Groomer — special incentive card
  const [gSpecialHead, setGSpecialHead] = useState(""), [gSpecialMonth, setGSpecialMonth] = useState("2026-08-01"), [gSpecialAmount, setGSpecialAmount] = useState(""), [gSpecialReason, setGSpecialReason] = useState("");
  // Groomer — incentive review card
  const [gReviewHead, setGReviewHead] = useState(""), [gReviewMonth, setGReviewMonth] = useState("2026-08-01");
  // Ranking card — its own month and its own list of people, like every other card on this screen.
  const [gRankMonth, setGRankMonth] = useState("2026-08-01"), [gRankIds, setGRankIds] = useState("");
  const [gRanking, setGRanking] = useState<{ headGroomerId: string; bracket: string; monthTotal: number; targetAmount: number | null; achievementPercent: number; rank: number; winnerHeadBonus: number; winnerHelperBonus: number }[] | null>(null);

  // Trainer form state
  const [tTrainer, setTTrainer] = useState(""), [tMeet, setTMeet] = useState(""), [tConverted, setTConverted] = useState("");
  const [tHomeProvider, setTHomeProvider] = useState(""), [tHomeAddr, setTHomeAddr] = useState(""), [tLat, setTLat] = useState(""), [tLng, setTLng] = useState(""), [tHomeReason, setTHomeReason] = useState("");
  const [tTravelProvider, setTTravelProvider] = useState(""), [tTravelDate, setTTravelDate] = useState("");

  // Sales form state
  const [sEmployee, setSEmployee] = useState(""), [sVertical, setSVertical] = useState<"training" | "grooming_outbound" | "grooming_inbound" | "grooming_both">("grooming_outbound"), [sBaseReason, setSBaseReason] = useState(""), [sEffectiveFrom, setSEffectiveFrom] = useState("2026-08-01");
  const [sBookingId, setSBookingId] = useState(""), [sAttribEmployee, setSAttribEmployee] = useState("");
  const [sBlitzDate, setSBlitzDate] = useState(""), [sBlitzReason, setSBlitzReason] = useState("");

  // Shared recognition state
  const [rEmployee, setREmployee] = useState(""), [rMonth, setRMonth] = useState("2026-08-01"), [rAmount, setRAmount] = useState(""), [rReason, setRReason] = useState("");
  const [revEmployee, setRevEmployee] = useState(""), [revDate, setRevDate] = useState(""), [revAmount, setRevAmount] = useState(""), [revRef, setRevRef] = useState("");

  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "32px 20px 64px", fontFamily: "system-ui,sans-serif", color: "#24133f" }}>
      {toast && <div style={{ position: "fixed", top: 18, left: "50%", transform: "translateX(-50%)", zIndex: 20, background: "#1a0d2e", color: "white", padding: "11px 18px", borderRadius: 10, fontSize: 13, maxWidth: 500, boxShadow: "0 10px 28px rgba(0,0,0,.35)" }}>{toast}</div>}
      <header style={{ marginBottom: 20 }}>
        <p style={{ fontWeight: 900, letterSpacing: 1.2, margin: 0, color: "#6a2daf" }}>PAWSPACE · PEOPLE</p>
        <h1 style={{ margin: "8px 0", fontSize: 30 }}>Groomer / Trainer / Sales incentive engine</h1>
        <p style={{ maxWidth: 900, color: "#6e6576" }}>
          Real, governed calculation - matches the published rate sheets exactly, sourced from real completed bookings.
          Every input here is an explicit record with a real reason, never invented. Each card below carries its own
          employee and its own dates: nothing is ever saved against a person you did not name on that card.
          <StaffGatedLink href="/team/people" permission="people.view">Back to People</StaffGatedLink>
        </p>
      </header>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {(["groomer", "trainer", "sales"] as Kind[]).map((k) => (
          <button key={k} onClick={() => { setTab(k); setLookupResult(null); }} style={{ padding: "8px 16px", borderRadius: 8, border: tab === k ? "2px solid #6524a0" : "1px solid #ddd5e2", background: tab === k ? "#f2ebfa" : "white", color: "#6524a0", fontWeight: 700, textTransform: "capitalize", cursor: "pointer" }}>{k}</button>
        ))}
      </div>

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Look up a real monthly breakdown</h2>
        <div style={row}>
          <div><span style={label}>Employee ID</span><Field name="lookup-employee" text={lookupEmployee} onChange={setLookupEmployee} placeholder="e.g. keeka_head_groomer" /></div>
          <div><span style={label}>Month (YYYY-MM-01)</span><Field name="lookup-month" text={lookupMonth} onChange={setLookupMonth} placeholder="2026-08-01" /></div>
        </div>
        <ActionButton action="lookup" busy={busy} busyLabel="Loading…" onRun={runLookup}
          missing={missingFields({ "Employee ID": lookupEmployee, "Month": lookupMonth })}>Load {tab} breakdown</ActionButton>
        {lookupResult && <pre style={{ marginTop: 14, padding: 12, background: "#f7f3fa", borderRadius: 8, fontSize: 12, overflowX: "auto" }}>{JSON.stringify(lookupResult, null, 2)}</pre>}
      </section>

      {tab === "groomer" && (
        <>
          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Set bracket (Team / Single) - sticky, versioned, needs a real reason</h2>
            <div style={row}>
              <div><span style={label}>Head Groomer ID</span><Field name="bracket-head" text={gHead} onChange={setGHead} placeholder="head groomer employee ID" /></div>
              <div><span style={label}>Helper ID (team only)</span><Field name="bracket-helper" text={gHelper} onChange={setGHelper} placeholder="helper employee ID" /></div>
              <div><span style={label}>Bracket</span>
                <select style={input} value={gBracket} onChange={(e) => setGBracket(e.target.value as "team" | "single")}>
                  <option value="team">Team</option><option value="single">Single</option>
                </select>
              </div>
              <div><span style={label}>Effective from (YYYY-MM-01)</span><Field name="bracket-effective-from" text={gBracketFrom} onChange={setGBracketFrom} placeholder="2026-08-01" /></div>
            </div>
            <span style={label}>Reason (min 8 characters)</span><Field name="bracket-reason" text={gReason} onChange={setGReason} placeholder="Why this bracket, effective when" />
            <ActionButton action="save_groomer_bracket" busy={busy}
              missing={[
                ...missingFields({ "Head Groomer ID": gHead, "Effective from": gBracketFrom }),
                ...(gBracket === "team" ? missingFields({ "Helper ID (a team bracket needs one)": gHelper }) : []),
                ...missingReason(gReason),
              ]}
              onRun={() => runAction("save_groomer_bracket", bracketBody({ headGroomerId: gHead, bracket: gBracket, helperId: gHelper, effectiveFrom: gBracketFrom, reason: gReason }), "Bracket saved")}>Save bracket</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Monthly target</h2>
            <div style={row}>
              <div><span style={label}>Head Groomer ID</span><Field name="target-head" text={gTargetHead} onChange={setGTargetHead} placeholder="head groomer employee ID" /></div>
              <div><span style={label}>Month</span><Field name="target-month" text={gTargetMonth} onChange={setGTargetMonth} placeholder="2026-08-01" /></div>
              <div><span style={label}>Target amount (₹)</span><Field name="target-amount" text={gTargetAmount} onChange={setGTargetAmount} placeholder="145000" /></div>
            </div>
            <ActionButton action="save_groomer_target" busy={busy}
              missing={[...missingFields({ "Head Groomer ID": gTargetHead, "Month": gTargetMonth }), ...missingPositiveAmount(gTargetAmount, "a target amount above zero")]}
              onRun={() => runAction("save_groomer_target", targetBody({ headGroomerId: gTargetHead, monthStart: gTargetMonth, targetAmount: gTargetAmount }), "Target saved")}>Save target</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Helper attendance (drives the ₹500 solo-day bonus)</h2>
            <div style={row}>
              <div><span style={label}>Helper ID</span><Field name="attendance-helper" text={gAttendHelper} onChange={setGAttendHelper} placeholder="helper employee ID" /></div>
              <div><span style={label}>Date</span><Field name="attendance-date" text={gAttendDate} onChange={setGAttendDate} placeholder="2026-08-10" /></div>
              <div><span style={label}>Status</span>
                <select style={input} value={gAttendStatus} onChange={(e) => setGAttendStatus(e.target.value as "present" | "absent")}>
                  <option value="absent">Absent</option><option value="present">Present</option>
                </select>
              </div>
            </div>
            <ActionButton action="record_helper_attendance" busy={busy}
              missing={missingFields({ "Helper ID": gAttendHelper, "Date": gAttendDate })}
              onRun={() => runAction("record_helper_attendance", attendanceBody({ helperId: gAttendHelper, attendanceDate: gAttendDate, status: gAttendStatus }), "Attendance recorded")}>Record attendance</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Gpay collection & pending fine</h2>
            <div style={row}>
              <div><span style={label}>Head Groomer ID</span><Field name="gpay-head" text={gGpayHead} onChange={setGGpayHead} placeholder="head groomer employee ID" /></div>
              <div><span style={label}>Month</span><Field name="gpay-month" text={gGpayMonth} onChange={setGGpayMonth} placeholder="2026-08-01" /></div>
              <div><span style={label}>Gpay total (₹)</span><Field name="gpay-total" text={gGpayTotal} onChange={setGGpayTotal} placeholder="15000" /></div>
              <div><span style={label}>Gpay pending (₹)</span><Field name="gpay-pending" text={gGpayPending} onChange={setGGpayPending} placeholder="12000" /></div>
            </div>
            <ActionButton action="save_gpay_ledger" busy={busy}
              missing={missingFields({ "Head Groomer ID": gGpayHead, "Month": gGpayMonth, "Gpay total": gGpayTotal, "Gpay pending": gGpayPending })}
              onRun={() => runAction("save_gpay_ledger", gpayBody({ headGroomerId: gGpayHead, monthStart: gGpayMonth, gpayTotal: gGpayTotal, gpayPending: gGpayPending }), "Gpay ledger saved")}>Save Gpay ledger</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>One-time special incentive</h2>
            <div style={row}>
              <div><span style={label}>Head Groomer ID</span><Field name="special-head" text={gSpecialHead} onChange={setGSpecialHead} placeholder="head groomer employee ID" /></div>
              <div><span style={label}>Month</span><Field name="special-month" text={gSpecialMonth} onChange={setGSpecialMonth} placeholder="2026-08-01" /></div>
              <div><span style={label}>Amount (₹)</span><Field name="special-amount" text={gSpecialAmount} onChange={setGSpecialAmount} placeholder="1500" /></div>
            </div>
            <span style={label}>Reason (min 8 characters, required)</span><Field name="special-reason" text={gSpecialReason} onChange={setGSpecialReason} placeholder="Why this one-time bonus" />
            <ActionButton action="record_groomer_special_incentive" busy={busy}
              missing={[...missingFields({ "Head Groomer ID": gSpecialHead, "Month": gSpecialMonth }), ...missingPositiveAmount(gSpecialAmount, "an amount above zero"), ...missingReason(gSpecialReason)]}
              onRun={() => runAction("record_groomer_special_incentive", specialBody({ headGroomerId: gSpecialHead, monthStart: gSpecialMonth, amount: gSpecialAmount, reason: gSpecialReason }), "Special incentive recorded")}>Record special incentive</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Monthly incentive review and achievement</h2>
            <p style={{ color: "#6e6576", fontSize: 13 }}>Save a calculation snapshot for review first. Finalizing is immutable and creates the employee achievement link exactly once; it does not transfer money or run payroll.</p>
            <div style={row}>
              <div><span style={label}>Head Groomer ID</span><Field name="review-head" text={gReviewHead} onChange={setGReviewHead} placeholder="head groomer employee ID" /></div>
              <div><span style={label}>Month</span><Field name="review-month" text={gReviewMonth} onChange={setGReviewMonth} placeholder="2026-08-01" /></div>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <ActionButton action="save_groomer_incentive_draft" busy={busy}
                missing={missingFields({ "Head Groomer ID": gReviewHead, "Month": gReviewMonth })}
                onRun={() => runAction("save_groomer_incentive_draft", reviewBody({ headGroomerId: gReviewHead, monthStart: gReviewMonth }), "Incentive draft saved")}>Save incentive draft</ActionButton>
              <ActionButton action="finalize_groomer_incentive" busy={busy} tone={{ background: "#3d1761" }}
                missing={missingFields({ "Head Groomer ID": gReviewHead, "Month": gReviewMonth })}
                onRun={() => runAction("finalize_groomer_incentive", reviewBody({ headGroomerId: gReviewHead, monthStart: gReviewMonth }), "Reviewed incentive finalized")}>Finalize reviewed incentive</ActionButton>
            </div>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Rank head groomers for the month</h2>
            <p style={{ color: "#6e6576", fontSize: 13 }}>Ranks the head groomers you name by achievement against their own published targets, and shows the winner bonus their bracket pays at that rank. This reads only - it writes no row, pays nothing and does not finalize anybody&apos;s incentive. Only groomers with a published target are ranked.</p>
            <div style={row}>
              <div><span style={label}>Month</span><Field name="rank-month" text={gRankMonth} onChange={setGRankMonth} placeholder="2026-08-01" /></div>
            </div>
            <span style={label}>Head Groomer IDs (one per line, or comma separated)</span>
            <textarea name="rank-ids" value={gRankIds} onChange={(e) => setGRankIds(e.target.value)} placeholder={"head groomer employee ID\nhead groomer employee ID"}
              style={{ width: "100%", minHeight: 70, padding: 8, fontFamily: "monospace", boxSizing: "border-box" }} />
            <ActionButton action="rank_groomers" busy={busy} busyLabel="Ranking…"
              missing={missingRanking({ monthStart: gRankMonth, headGroomerIds: gRankIds })}
              onRun={() => run("rank_groomers", () => callApi("rank_groomers", rankBody({ monthStart: gRankMonth, headGroomerIds: gRankIds }))
                .then((r) => { const ranking = (r as { ranking?: typeof gRanking }).ranking ?? []; setGRanking(ranking); flash(ranking.length ? `Ranked ${ranking.length} head groomer(s)` : "No ranked head groomers: a published monthly target is required to be ranked"); }))}>Rank the month</ActionButton>
            {gRanking && gRanking.length > 0 && (
              <div style={{ overflowX: "auto", marginTop: 10 }}>
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13 }}>
                  <thead><tr><th style={rankCell}>Rank</th><th style={rankCell}>Head groomer</th><th style={rankCell}>Bracket</th><th style={rankCell}>Month total</th><th style={rankCell}>Target</th><th style={rankCell}>Achievement</th><th style={rankCell}>Winner bonus (head / helper)</th></tr></thead>
                  <tbody>{gRanking.map((rowData) => (
                    <tr key={rowData.headGroomerId}>
                      <td style={rankCell}>{rowData.rank}</td>
                      <td style={rankCell}>{rowData.headGroomerId}</td>
                      <td style={rankCell}>{rowData.bracket}</td>
                      <td style={rankCell}>₹{Number(rowData.monthTotal || 0).toLocaleString("en-IN")}</td>
                      <td style={rankCell}>₹{Number(rowData.targetAmount || 0).toLocaleString("en-IN")}</td>
                      <td style={rankCell}>{rowData.achievementPercent}%</td>
                      <td style={rankCell}>₹{Number(rowData.winnerHeadBonus || 0).toLocaleString("en-IN")} / ₹{Number(rowData.winnerHelperBonus || 0).toLocaleString("en-IN")}</td>
                    </tr>))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      {tab === "trainer" && (
        <>
          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Record a real Meet &amp; Greet conversion</h2>
            <div style={row}>
              <div><span style={label}>Trainer ID</span><Field name="conversion-trainer" text={tTrainer} onChange={setTTrainer} placeholder="trainer employee ID" /></div>
              <div><span style={label}>Meet &amp; Greet booking ID</span><Field name="conversion-meet" text={tMeet} onChange={setTMeet} placeholder="the real meet-greet booking" /></div>
              <div><span style={label}>Converted booking ID</span><Field name="conversion-converted" text={tConverted} onChange={setTConverted} placeholder="the real programme booking that followed" /></div>
            </div>
            <ActionButton action="record_meet_greet_conversion" busy={busy}
              missing={missingFields({ "Trainer ID": tTrainer, "Meet & Greet booking ID": tMeet, "Converted booking ID": tConverted })}
              onRun={() => runAction("record_meet_greet_conversion", { trainerId: tTrainer.trim(), meetGreetBookingId: tMeet.trim(), convertedBookingId: tConverted.trim() }, "Conversion recorded")}>Record conversion</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Home base (for daily travel & petrol allowance)</h2>
            <div style={row}>
              <div><span style={label}>Trainer / Provider ID</span><Field name="home-base-provider" text={tHomeProvider} onChange={setTHomeProvider} placeholder="trainer employee ID" /></div>
              <div><span style={label}>Address</span><Field name="home-base-address" text={tHomeAddr} onChange={setTHomeAddr} placeholder="real geocoded address" /></div>
              <div><span style={label}>Latitude</span><Field name="home-base-lat" text={tLat} onChange={setTLat} placeholder="12.9719" /></div>
              <div><span style={label}>Longitude</span><Field name="home-base-lng" text={tLng} onChange={setTLng} placeholder="77.6412" /></div>
            </div>
            <span style={label}>Reason</span><Field name="home-base-reason" text={tHomeReason} onChange={setTHomeReason} placeholder="Initial setup / relocation" />
            <ActionButton action="save_home_base" busy={busy}
              missing={missingFields({ "Trainer / Provider ID": tHomeProvider, "Address": tHomeAddr, "Latitude": tLat, "Longitude": tLng })}
              onRun={() => runAction("save_home_base", { providerId: tHomeProvider.trim(), address: tHomeAddr.trim(), latitude: Number(tLat), longitude: Number(tLng), effectiveFrom: Date.now(), reason: tHomeReason }, "Home base saved")}>Save home base</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Compute a real day&apos;s travel route (home → jobs → home)</h2>
            <div style={row}>
              <div><span style={label}>Trainer / Provider ID</span><Field name="travel-provider" text={tTravelProvider} onChange={setTTravelProvider} placeholder="trainer employee ID" /></div>
              <div><span style={label}>Travel date</span><Field name="travel-date" text={tTravelDate} onChange={setTTravelDate} placeholder="2026-08-12" /></div>
            </div>
            <ActionButton action="compute_daily_travel" busy={busy} busyLabel="Computing…"
              missing={missingFields({ "Trainer / Provider ID": tTravelProvider, "Travel date": tTravelDate })}
              onRun={() => runAction("compute_daily_travel", { providerId: tTravelProvider.trim(), travelDate: tTravelDate.trim() }, "Travel computed")}>Compute daily travel</ActionButton>
          </section>
        </>
      )}

      {tab === "sales" && (
        <>
          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Set base vertical (determines the ladder; cross-sold value still counts)</h2>
            <div style={row}>
              <div><span style={label}>Employee ID</span><Field name="sales-base-employee" text={sEmployee} onChange={setSEmployee} placeholder="employee ID" /></div>
              <div><span style={label}>Base vertical</span>
                <select style={input} value={sVertical} onChange={(e) => setSVertical(e.target.value as typeof sVertical)}>
                  <option value="grooming_outbound">Grooming - Outbound (pure)</option>
                  <option value="grooming_inbound">Grooming - Inbound</option>
                  <option value="grooming_both">Grooming - Both (inbound + outbound)</option>
                  <option value="training">Training</option>
                </select>
              </div>
              <div><span style={label}>Effective from</span><Field name="sales-base-effective-from" text={sEffectiveFrom} onChange={setSEffectiveFrom} placeholder="2026-08-01" /></div>
            </div>
            <span style={label}>Reason</span><Field name="sales-base-reason" text={sBaseReason} onChange={setSBaseReason} placeholder="Why this base vertical" />
            <ActionButton action="save_sales_base" busy={busy}
              missing={missingFields({ "Employee ID": sEmployee, "Effective from": sEffectiveFrom })}
              onRun={() => runAction("save_sales_base", { employeeId: sEmployee.trim(), baseVertical: sVertical, effectiveFrom: sEffectiveFrom.trim(), reason: sBaseReason }, "Base vertical saved")}>Save base vertical</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Attribute a booking to the employee who converted it</h2>
            <p style={{ fontSize: 12, color: "#6e6576" }}>Only bookings attributed here count toward anyone&apos;s number. A customer&apos;s own direct booking is real revenue but is never credited to an individual.</p>
            <div style={row}>
              <div><span style={label}>Booking ID</span><Field name="attribute-booking" text={sBookingId} onChange={setSBookingId} placeholder="real booking ID" /></div>
              <div><span style={label}>Employee ID</span><Field name="attribute-employee" text={sAttribEmployee} onChange={setSAttribEmployee} placeholder="who converted this sale" /></div>
            </div>
            <ActionButton action="attribute_booking" busy={busy}
              missing={missingFields({ "Booking ID": sBookingId, "Employee ID": sAttribEmployee })}
              onRun={() => runAction("attribute_booking", { bookingId: sBookingId.trim(), employeeId: sAttribEmployee.trim() }, "Booking attributed")}>Attribute booking</ActionButton>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Announce a Blitz day (doubles that day&apos;s incentive)</h2>
            <div style={row}>
              <div><span style={label}>Blitz date</span><Field name="blitz-date" text={sBlitzDate} onChange={setSBlitzDate} placeholder="2026-08-25" /></div>
            </div>
            <span style={label}>Reason</span><Field name="blitz-reason" text={sBlitzReason} onChange={setSBlitzReason} placeholder="e.g. month-end push" />
            <ActionButton action="save_blitz_day" busy={busy}
              missing={missingFields({ "Blitz date": sBlitzDate })}
              onRun={() => runAction("save_blitz_day", { blitzDate: sBlitzDate.trim(), reason: sBlitzReason }, "Blitz day announced")}>Announce Blitz day</ActionButton>
          </section>
        </>
      )}

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Shared: one-time special incentive (any employee/role)</h2>
        <div style={row}>
          <div><span style={label}>Employee ID</span><Field name="shared-special-employee" text={rEmployee} onChange={setREmployee} placeholder="employee ID" /></div>
          <div><span style={label}>Month</span><Field name="shared-special-month" text={rMonth} onChange={setRMonth} placeholder="2026-08-01" /></div>
          <div><span style={label}>Amount (₹)</span><Field name="shared-special-amount" text={rAmount} onChange={setRAmount} placeholder="1000" /></div>
        </div>
        <span style={label}>Reason (min 8 characters, required)</span><Field name="shared-special-reason" text={rReason} onChange={setRReason} placeholder="Why this one-time bonus" />
        <ActionButton action="record_special_incentive" busy={busy}
          missing={[...missingFields({ "Employee ID": rEmployee, "Month": rMonth }), ...missingPositiveAmount(rAmount, "an amount above zero"), ...missingReason(rReason)]}
          onRun={() => runAction("record_special_incentive", { employeeId: rEmployee.trim(), monthStart: rMonth.trim(), amount: Number(rAmount), reason: rReason }, "Special incentive recorded")}>Record special incentive</ActionButton>
      </section>

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Shared: Google review incentive (₹100–₹200, any employee/role)</h2>
        <div style={row}>
          <div><span style={label}>Employee ID</span><Field name="review-incentive-employee" text={revEmployee} onChange={setRevEmployee} placeholder="employee ID" /></div>
          <div><span style={label}>Review date</span><Field name="review-incentive-date" text={revDate} onChange={setRevDate} placeholder="2026-08-15" /></div>
          <div><span style={label}>Amount (₹100–200)</span><Field name="review-incentive-amount" text={revAmount} onChange={setRevAmount} placeholder="150" /></div>
          <div><span style={label}>Review reference</span><Field name="review-incentive-reference" text={revRef} onChange={setRevRef} placeholder="optional link/note" /></div>
        </div>
        <ActionButton action="record_review_incentive" busy={busy}
          missing={[...missingFields({ "Employee ID": revEmployee, "Review date": revDate }), ...missingPositiveAmount(revAmount, "an amount above zero")]}
          onRun={() => runAction("record_review_incentive", { employeeId: revEmployee.trim(), reviewDate: revDate.trim(), amount: Number(revAmount), reviewReference: revRef.trim() || undefined }, "Review incentive recorded")}>Record review incentive</ActionButton>
      </section>
    </main>
  );
}
