"use client";

import Link from "next/link";
import {useEffect, useState} from "react";
import {loadCustomerRelocationCases, type RelocationCaseSummary} from "../../lib/relocation-client";
import styles from "./relocation.module.css";

export default function CustomerRelocationInquiries({customerId, routeScope = "legacy"}: {customerId: string; routeScope?: "legacy" | "v2"}) {
  const [state, setState] = useState<{customerId: string; rows: RelocationCaseSummary[]; error: string} | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => { if (!controller.signal.aborted) setState(null); });
    void loadCustomerRelocationCases(customerId, AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]))
      .then(rows => { if (!controller.signal.aborted) setState({customerId, rows, error: ""}); })
      .catch(problem => { if (!controller.signal.aborted) setState({customerId, rows: [], error: problem instanceof Error ? problem.message : "Unable to load your relocation inquiries."}); });
    return () => controller.abort();
  }, [customerId, attempt]);
  const visible = state?.customerId === customerId ? state : null;
  const path = routeScope === "v2" ? "/v2/relocation" : "/relocation";
  return <section className={styles.card} aria-label="Your relocation inquiries">
    <h2>Your relocation inquiries</h2>
    {!visible ? <p role="status">Loading your saved inquiries…</p> : visible.error ? <><p role="alert">{visible.error}</p><button onClick={() => setAttempt(value => value + 1)}>Retry saved inquiries</button></> : visible.rows.length ? visible.rows.map(item => <article className={styles.row} key={item.id}>
      <h3>{String(item.pet_name || "Pet relocation")}</h3>
      <p>{String(item.origin_city || "")}{item.origin_country ? `, ${String(item.origin_country)}` : ""} → {String(item.destination_city || "")}{item.destination_country ? `, ${String(item.destination_country)}` : ""} · {String(item.target_travel_date || "Date pending")}</p>
      <p>Status: {item.status.replaceAll("_", " ")}</p>
      <Link href={`${path}?caseId=${encodeURIComponent(item.id)}`}>Open inquiry {item.id}</Link>
    </article>) : <p>No relocation inquiries yet.</p>}
  </section>;
}
