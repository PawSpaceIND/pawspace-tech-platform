"use client";
import { useState } from "react";
import Link from "next/link";

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
const row: React.CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 10 };

function Field({ text, onChange, placeholder }: { text: string; onChange: (v: string) => void; placeholder: string }) {
  return <input style={input} value={text} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />;
}

export default function ServiceIncentivesPage() {
  const [tab, setTab] = useState<Kind>("groomer");
  const [toast, setToast] = useState("");
  const flash = (msg: string) => { setToast(msg); window.setTimeout(() => setToast(""), 3200); };
  const runAction = (action: string, body: Record<string, unknown>, successMsg: string) =>
    callApi(action, body).then((r) => flash(`${successMsg}: ${JSON.stringify(r).slice(0, 200)}`)).catch((e) => flash(`Error: ${e.message}`));

  // Lookup state
  const [lookupEmployee, setLookupEmployee] = useState("");
  const [lookupMonth, setLookupMonth] = useState("2026-08-01");
  const [lookupResult, setLookupResult] = useState<Record<string, unknown> | null>(null);
  const runLookup = () => loadResult(tab, lookupEmployee, lookupMonth).then(setLookupResult).catch((e) => flash(`Error: ${e.message}`));

  // Groomer form state
  const [gHead, setGHead] = useState(""), [gHelper, setGHelper] = useState(""), [gBracket, setGBracket] = useState<"team" | "single">("team"), [gReason, setGReason] = useState("");
  const [gTargetMonth, setGTargetMonth] = useState("2026-08-01"), [gTargetAmount, setGTargetAmount] = useState("");
  const [gAttendDate, setGAttendDate] = useState(""), [gAttendStatus, setGAttendStatus] = useState<"present" | "absent">("absent");
  const [gGpayTotal, setGGpayTotal] = useState(""), [gGpayPending, setGGpayPending] = useState("");
  const [gSpecialAmount, setGSpecialAmount] = useState(""), [gSpecialReason, setGSpecialReason] = useState("");

  // Trainer form state
  const [tTrainer, setTTrainer] = useState(""), [tMeet, setTMeet] = useState(""), [tConverted, setTConverted] = useState("");
  const [tHomeAddr, setTHomeAddr] = useState(""), [tLat, setTLat] = useState(""), [tLng, setTLng] = useState(""), [tHomeReason, setTHomeReason] = useState("");
  const [tTravelDate, setTTravelDate] = useState("");

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
          Every input here is an explicit record with a real reason, never invented. <Link href="/team/people">Back to People</Link>
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
          <div><span style={label}>Employee ID</span><Field text={lookupEmployee} onChange={setLookupEmployee} placeholder="e.g. keeka_head_groomer" /></div>
          <div><span style={label}>Month (YYYY-MM-01)</span><Field text={lookupMonth} onChange={setLookupMonth} placeholder="2026-08-01" /></div>
        </div>
        <button style={btn} onClick={runLookup}>Load {tab} breakdown</button>
        {lookupResult && <pre style={{ marginTop: 14, padding: 12, background: "#f7f3fa", borderRadius: 8, fontSize: 12, overflowX: "auto" }}>{JSON.stringify(lookupResult, null, 2)}</pre>}
      </section>

      {tab === "groomer" && (
        <>
          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Set bracket (Team / Single) - sticky, versioned, needs a real reason</h2>
            <div style={row}>
              <div><span style={label}>Head Groomer ID</span><Field text={gHead} onChange={setGHead} placeholder="head groomer employee ID" /></div>
              <div><span style={label}>Helper ID (team only)</span><Field text={gHelper} onChange={setGHelper} placeholder="helper employee ID" /></div>
              <div><span style={label}>Bracket</span>
                <select style={input} value={gBracket} onChange={(e) => setGBracket(e.target.value as "team" | "single")}>
                  <option value="team">Team</option><option value="single">Single</option>
                </select>
              </div>
            </div>
            <span style={label}>Reason (min 8 characters)</span><Field text={gReason} onChange={setGReason} placeholder="Why this bracket, effective when" />
            <button style={btn} onClick={() => runAction("save_groomer_bracket", { headGroomerId: gHead, bracket: gBracket, helperId: gHelper || null, effectiveFrom: lookupMonth, reason: gReason }, "Bracket saved")}>Save bracket</button>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Monthly target</h2>
            <div style={row}>
              <div><span style={label}>Month</span><Field text={gTargetMonth} onChange={setGTargetMonth} placeholder="2026-08-01" /></div>
              <div><span style={label}>Target amount (₹)</span><Field text={gTargetAmount} onChange={setGTargetAmount} placeholder="145000" /></div>
            </div>
            <button style={btn} onClick={() => runAction("save_groomer_target", { headGroomerId: gHead, monthStart: gTargetMonth, targetAmount: Number(gTargetAmount), reason: "Monthly target published" }, "Target saved")}>Save target</button>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Helper attendance (drives the ₹500 solo-day bonus)</h2>
            <div style={row}>
              <div><span style={label}>Date</span><Field text={gAttendDate} onChange={setGAttendDate} placeholder="2026-08-10" /></div>
              <div><span style={label}>Status</span>
                <select style={input} value={gAttendStatus} onChange={(e) => setGAttendStatus(e.target.value as "present" | "absent")}>
                  <option value="absent">Absent</option><option value="present">Present</option>
                </select>
              </div>
            </div>
            <button style={btn} onClick={() => runAction("record_helper_attendance", { helperId: gHelper, attendanceDate: gAttendDate, status: gAttendStatus }, "Attendance recorded")}>Record attendance</button>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Gpay collection & pending fine</h2>
            <div style={row}>
              <div><span style={label}>Gpay total (₹)</span><Field text={gGpayTotal} onChange={setGGpayTotal} placeholder="15000" /></div>
              <div><span style={label}>Gpay pending (₹)</span><Field text={gGpayPending} onChange={setGGpayPending} placeholder="12000" /></div>
            </div>
            <button style={btn} onClick={() => runAction("save_gpay_ledger", { headGroomerId: gHead, monthStart: gTargetMonth, gpayTotal: Number(gGpayTotal), gpayPending: Number(gGpayPending) }, "Gpay ledger saved")}>Save Gpay ledger</button>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>One-time special incentive</h2>
            <div style={row}>
              <div><span style={label}>Amount (₹)</span><Field text={gSpecialAmount} onChange={setGSpecialAmount} placeholder="1500" /></div>
            </div>
            <span style={label}>Reason (min 8 characters, required)</span><Field text={gSpecialReason} onChange={setGSpecialReason} placeholder="Why this one-time bonus" />
            <button style={btn} onClick={() => runAction("record_groomer_special_incentive", { headGroomerId: gHead, monthStart: gTargetMonth, amount: Number(gSpecialAmount), reason: gSpecialReason }, "Special incentive recorded")}>Record special incentive</button>
          </section>
        </>
      )}

      {tab === "trainer" && (
        <>
          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Record a real Meet & Greet conversion</h2>
            <div style={row}>
              <div><span style={label}>Trainer ID</span><Field text={tTrainer} onChange={setTTrainer} placeholder="trainer employee ID" /></div>
              <div><span style={label}>Meet & Greet booking ID</span><Field text={tMeet} onChange={setTMeet} placeholder="the real meet-greet booking" /></div>
              <div><span style={label}>Converted booking ID</span><Field text={tConverted} onChange={setTConverted} placeholder="the real programme booking that followed" /></div>
            </div>
            <button style={btn} onClick={() => runAction("record_meet_greet_conversion", { trainerId: tTrainer, meetGreetBookingId: tMeet, convertedBookingId: tConverted }, "Conversion recorded")}>Record conversion</button>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Home base (for daily travel & petrol allowance)</h2>
            <div style={row}>
              <div><span style={label}>Address</span><Field text={tHomeAddr} onChange={setTHomeAddr} placeholder="real geocoded address" /></div>
              <div><span style={label}>Latitude</span><Field text={tLat} onChange={setTLat} placeholder="12.9719" /></div>
              <div><span style={label}>Longitude</span><Field text={tLng} onChange={setTLng} placeholder="77.6412" /></div>
            </div>
            <span style={label}>Reason</span><Field text={tHomeReason} onChange={setTHomeReason} placeholder="Initial setup / relocation" />
            <button style={btn} onClick={() => runAction("save_home_base", { providerId: tTrainer, address: tHomeAddr, latitude: Number(tLat), longitude: Number(tLng), effectiveFrom: Date.now(), reason: tHomeReason }, "Home base saved")}>Save home base</button>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Compute a real day&apos;s travel route (home → jobs → home)</h2>
            <div style={row}>
              <div><span style={label}>Travel date</span><Field text={tTravelDate} onChange={setTTravelDate} placeholder="2026-08-12" /></div>
            </div>
            <button style={btn} onClick={() => runAction("compute_daily_travel", { providerId: tTrainer, travelDate: tTravelDate }, "Travel computed")}>Compute daily travel</button>
          </section>
        </>
      )}

      {tab === "sales" && (
        <>
          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Set base vertical (determines the ladder; cross-sold value still counts)</h2>
            <div style={row}>
              <div><span style={label}>Employee ID</span><Field text={sEmployee} onChange={setSEmployee} placeholder="employee ID" /></div>
              <div><span style={label}>Base vertical</span>
                <select style={input} value={sVertical} onChange={(e) => setSVertical(e.target.value as typeof sVertical)}>
                  <option value="grooming_outbound">Grooming - Outbound (pure)</option>
                  <option value="grooming_inbound">Grooming - Inbound</option>
                  <option value="grooming_both">Grooming - Both (inbound + outbound)</option>
                  <option value="training">Training</option>
                </select>
              </div>
              <div><span style={label}>Effective from</span><Field text={sEffectiveFrom} onChange={setSEffectiveFrom} placeholder="2026-08-01" /></div>
            </div>
            <span style={label}>Reason</span><Field text={sBaseReason} onChange={setSBaseReason} placeholder="Why this base vertical" />
            <button style={btn} onClick={() => runAction("save_sales_base", { employeeId: sEmployee, baseVertical: sVertical, effectiveFrom: sEffectiveFrom, reason: sBaseReason }, "Base vertical saved")}>Save base vertical</button>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Attribute a booking to the employee who converted it</h2>
            <p style={{ fontSize: 12, color: "#6e6576" }}>Only bookings attributed here count toward anyone&apos;s number. A customer&apos;s own direct booking is real revenue but is never credited to an individual.</p>
            <div style={row}>
              <div><span style={label}>Booking ID</span><Field text={sBookingId} onChange={setSBookingId} placeholder="real booking ID" /></div>
              <div><span style={label}>Employee ID</span><Field text={sAttribEmployee} onChange={setSAttribEmployee} placeholder="who converted this sale" /></div>
            </div>
            <button style={btn} onClick={() => runAction("attribute_booking", { bookingId: sBookingId, employeeId: sAttribEmployee }, "Booking attributed")}>Attribute booking</button>
          </section>

          <section style={card}>
            <h2 style={{ marginTop: 0, fontSize: 16 }}>Announce a Blitz day (doubles that day&apos;s incentive)</h2>
            <div style={row}>
              <div><span style={label}>Blitz date</span><Field text={sBlitzDate} onChange={setSBlitzDate} placeholder="2026-08-25" /></div>
            </div>
            <span style={label}>Reason</span><Field text={sBlitzReason} onChange={setSBlitzReason} placeholder="e.g. month-end push" />
            <button style={btn} onClick={() => runAction("save_blitz_day", { blitzDate: sBlitzDate, reason: sBlitzReason }, "Blitz day announced")}>Announce Blitz day</button>
          </section>
        </>
      )}

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Shared: one-time special incentive (any employee/role)</h2>
        <div style={row}>
          <div><span style={label}>Employee ID</span><Field text={rEmployee} onChange={setREmployee} placeholder="employee ID" /></div>
          <div><span style={label}>Month</span><Field text={rMonth} onChange={setRMonth} placeholder="2026-08-01" /></div>
          <div><span style={label}>Amount (₹)</span><Field text={rAmount} onChange={setRAmount} placeholder="1000" /></div>
        </div>
        <span style={label}>Reason (min 8 characters, required)</span><Field text={rReason} onChange={setRReason} placeholder="Why this one-time bonus" />
        <button style={btn} onClick={() => runAction("record_special_incentive", { employeeId: rEmployee, monthStart: rMonth, amount: Number(rAmount), reason: rReason }, "Special incentive recorded")}>Record special incentive</button>
      </section>

      <section style={card}>
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Shared: Google review incentive (₹100–₹200, any employee/role)</h2>
        <div style={row}>
          <div><span style={label}>Employee ID</span><Field text={revEmployee} onChange={setRevEmployee} placeholder="employee ID" /></div>
          <div><span style={label}>Review date</span><Field text={revDate} onChange={setRevDate} placeholder="2026-08-15" /></div>
          <div><span style={label}>Amount (₹100–200)</span><Field text={revAmount} onChange={setRevAmount} placeholder="150" /></div>
          <div><span style={label}>Review reference</span><Field text={revRef} onChange={setRevRef} placeholder="optional link/note" /></div>
        </div>
        <button style={btn} onClick={() => runAction("record_review_incentive", { employeeId: revEmployee, reviewDate: revDate, amount: Number(revAmount), reviewReference: revRef || undefined }, "Review incentive recorded")}>Record review incentive</button>
      </section>
    </main>
  );
}
