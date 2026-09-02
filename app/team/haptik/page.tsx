"use client";
/**
 * Operator console for the Haptik AI voice agents.
 *
 * The integration shipped as APIs only: twelve campaigns, an Interakt WhatsApp path, an inbound
 * enquiry surface and a package-recommendation rule set, none of which had a screen. The practical
 * effect was that launching a campaign meant hand-crafting an HTTP request, and nobody could see
 * whether the WhatsApp the bot promised a customer actually went out. Both are bad ways to run
 * something a customer's phone rings for.
 *
 * The same three properties the voice operator console is built around hold here:
 *
 *   Nothing here can enable calling or messaging. Whether Haptik outbound and Interakt are connected
 *   at all is decided by the environment. This page READS those decisions and disables its own
 *   controls to match, showing the reason instead of letting a button silently do nothing.
 *
 *   A launch is never the first click. "Preview audience" runs the real audience query and returns
 *   only a count and masked rows; the launch button stays disabled until a preview for the CURRENT
 *   campaign AND limit has come back. Changing either clears it, so an operator cannot preview twenty
 *   contacts and dial five thousand.
 *
 *   Every decision shown comes from lib/haptik-console, so it is executed by tests rather than
 *   inferred from this markup.
 *
 * No full customer phone number is rendered anywhere on this page - the APIs return only the last four
 * digits, which is enough to tie a row to a call recording.
 */
import { useCallback, useEffect, useState } from "react";
import { Badge, Button, StatCard, TeamAlert, TeamSection, TeamShell, TeamStatGrid, TeamTable } from "../../components/ui";
import { campaignLaunchDecision, interaktSetupGaps, previewMatchesCampaign, type AudiencePreview } from "../../../lib/haptik-console";

type Campaign = { code: string; label: string; requiresMarketingConsent: boolean; description: string; useCase: number };
type Readiness = { campaign: string; label: string; requiresMarketingConsent: boolean; ready: number; refreshedAt: number | null };
type OutboundState = { campaigns: Campaign[]; readiness: Readiness[]; connected: boolean; quietHours: boolean };
type CallRow = { id: string; campaign: string; contactId: string; phoneLast4: string; status: string; callRef: string | null; reason: string | null; requestedBy: string; createdAt: number };
type InteraktLink = { linkKey: string; label: string; purpose: string; useCase: string; linkConfigured: boolean; templateKey: string; templateApproved: boolean };
type InteraktState = { connected: boolean; reason: string | null; links: InteraktLink[]; sendable: boolean };
type SendRow = { id: string; linkKey: string; templateKey: string; purpose: string; phoneLast4: string; callRef: string | null; status: string; reason: string | null; messageStatus: string | null; createdAt: number };
type InboundState = { categories: Array<{ category: string; label: string; count: number; cases: number }>; transfers: Array<{ status: string; count: number }>; faq: { answered: number; unanswered: number } };
type Briefing = { packageCount: number; ready: boolean; packagesWithoutRules: string[]; rulesPointingAtMissingPackages: string[]; packages: Array<{ packageCode: string; name: string; price: number; currency: string; recommendedFor: Array<{ ruleCode: string }> }> };
type PreviewRow = { contactId: string; phoneLast4: string; name: string };

const IST = (value: unknown) => (Number(value) > 0 ? new Date(Number(value)).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "—");
const statusTone = (status: string): "success" | "warning" | "danger" | "info" | "neutral" =>
  ["dialled", "provider_accepted", "delivered", "queued"].includes(status) ? "success"
    : ["failed", "blocked", "suppressed", "dead_letter"].includes(status) ? "danger"
      : ["retry_pending", "scheduled", "no_queue_configured"].includes(status) ? "warning" : "neutral";

async function get<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: "no-store" });
  const payload = await response.json() as { data?: T; error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload.data as T;
}
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const payload = await response.json() as { data?: T; error?: string };
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload.data as T;
}

export default function HaptikConsolePage() {
  const [outbound, setOutbound] = useState<OutboundState | null>(null);
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [interakt, setInterakt] = useState<InteraktState | null>(null);
  const [sends, setSends] = useState<SendRow[]>([]);
  const [inbound, setInbound] = useState<InboundState | null>(null);
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [campaign, setCampaign] = useState("");
  const [limit, setLimit] = useState(25);
  const [preview, setPreview] = useState<(AudiencePreview & { rows: PreviewRow[] }) | null>(null);
  const [linkForm, setLinkForm] = useState({ linkKey: "", url: "" });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const [outboundState, callRows, interaktState, sendRows, inboundState, briefingState] = await Promise.all([
      get<OutboundState>("/api/haptik-outbound"),
      get<CallRow[]>("/api/haptik-outbound?mode=calls&limit=50"),
      get<InteraktState>("/api/interakt"),
      get<SendRow[]>("/api/interakt?mode=sends&limit=50"),
      get<InboundState>("/api/haptik-config?mode=inbound"),
      get<Briefing>("/api/haptik-config"),
    ]);
    return { outboundState, callRows, interaktState, sendRows, inboundState, briefingState };
  }, []);

  const apply = useCallback((next: Awaited<ReturnType<typeof load>>) => {
    setOutbound(next.outboundState); setCalls(next.callRows); setInterakt(next.interaktState);
    setSends(next.sendRows); setInbound(next.inboundState); setBriefing(next.briefingState);
  }, []);

  useEffect(() => {
    let active = true;
    void load().then(
      next => { if (active) apply(next); },
      caught => { if (active) setError(caught instanceof Error ? caught.message : String(caught)); },
    );
    return () => { active = false; };
  }, [load, apply]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label); setError(""); setNotice("");
    try { await action(); } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); } finally { setBusy(""); }
  };

  // Editing the campaign or the limit invalidates the preview that authorised a launch.
  const chooseCampaign = (code: string) => { setCampaign(code); setPreview(null); };
  const chooseLimit = (value: number) => { setLimit(value); setPreview(null); };

  const decision = campaignLaunchDecision({
    connected: Boolean(outbound?.connected), connectionReason: outbound?.connected ? null : "Haptik outbound is not connected (HAPTIK_OUTBOUND_API_KEY / HAPTIK_OUTBOUND_URL not configured).",
    campaign, limit, preview, quietHours: Boolean(outbound?.quietHours),
  });
  const previewIsCurrent = previewMatchesCampaign(preview, campaign, limit);
  const gaps = interakt ? interaktSetupGaps(interakt) : [];

  const previewAudience = () => run("preview", async () => {
    const data = await get<{ campaign: string; size: number; audience: PreviewRow[] }>(`/api/haptik-outbound?mode=audience&campaign=${encodeURIComponent(campaign)}&limit=${limit}`);
    setPreview({ campaign, limit, size: data.size, at: Date.now(), rows: data.audience.slice(0, 10) });
    setNotice(`${data.size} contact(s) are eligible for ${campaign} right now.`);
  });

  const launch = () => run("launch", async () => {
    const data = await post<{ dialled: number; skipped: number; failed: number; audience: number; reason?: string }>("/api/haptik-outbound", { campaign, limit });
    setNotice(data.reason || `Dialled ${data.dialled}, skipped ${data.skipped}, failed ${data.failed} of ${data.audience}.`);
    setPreview(null);
    apply(await load());
  });

  const saveLink = () => run("link", async () => {
    await post("/api/interakt", { action: "set_link", linkKey: linkForm.linkKey, url: linkForm.url });
    setNotice(`Saved the ${linkForm.linkKey} link.`);
    setLinkForm({ linkKey: "", url: "" });
    apply(await load());
  });

  const dispatchQueued = () => run("dispatch", async () => {
    const data = await post<{ dispatched?: number; failed?: number; reason?: string; status?: string }>("/api/interakt", { action: "dispatch" });
    setNotice(data.reason || `Dispatched ${data.dispatched ?? 0}, failed ${data.failed ?? 0}.`);
    apply(await load());
  });

  const readinessFor = (code: string) => outbound?.readiness.find(r => r.campaign === code) || null;
  const totalReady = (outbound?.readiness || []).reduce((sum, r) => sum + r.ready, 0);
  const whatsappBlocked = sends.filter(s => ["blocked", "suppressed"].includes(s.status)).length;

  return (
    <TeamShell
      eyebrow="AI voice"
      title="Haptik voice agents"
      description="The twelve outbound journeys, the inbound agent and the Interakt WhatsApp path. Calling is always human-launched from here."
      nav={[{ href: "/team/voice", label: "Voice operator console" }, { href: "/team/ai", label: "AI workspace" }, { href: "/team", label: "Team", primary: true }]}
      status={<>
        {error && <TeamAlert tone="error">{error}</TeamAlert>}
        {notice && <TeamAlert tone="success">{notice}</TeamAlert>}
        {outbound && !outbound.connected && <TeamAlert tone="info">Haptik outbound is not connected. Audiences are still computed so you can see who would be called, but nothing can be dialled.</TeamAlert>}
        {outbound?.quietHours && <TeamAlert tone="info">Quiet hours are in force (21:00–09:00 IST). No outbound calls are placed.</TeamAlert>}
      </>}
    >
      <TeamStatGrid>
        <StatCard label="Campaigns" value={String(outbound?.campaigns.length ?? 0)} meta="Solution-document journeys" />
        <StatCard label="Contacts ready" value={String(totalReady)} meta="Across every campaign" />
        <StatCard label="Outbound" value={outbound?.connected ? "Connected" : "Not connected"} meta={outbound?.quietHours ? "Quiet hours" : "Dialling window open"} />
        <StatCard label="WhatsApp" value={interakt?.sendable ? "Ready" : "Setup needed"} meta={`${whatsappBlocked} blocked send(s)`} />
      </TeamStatGrid>

      <TeamSection title="Launch a campaign" note="Preview the audience for this campaign and limit, then launch. A launch never runs on an unpreviewed audience.">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Campaign</span>
            <select value={campaign} onChange={event => chooseCampaign(event.target.value)}>
              <option value="">Choose a campaign…</option>
              {(outbound?.campaigns || []).map(c => <option key={c.code} value={c.code}>{c.useCase}. {c.label}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Max contacts</span>
            <input type="number" min={1} max={5000} value={limit} onChange={event => chooseLimit(Number(event.target.value))} />
          </label>
          <Button variant="secondary" disabled={!campaign || busy === "preview"} onClick={previewAudience}>{busy === "preview" ? "Previewing…" : "Preview audience"}</Button>
          <Button disabled={!decision.allowed || busy === "launch"} onClick={launch}>{busy === "launch" ? "Launching…" : "Launch calls"}</Button>
        </div>
        {!decision.allowed && decision.detail && <TeamAlert tone="info">{decision.detail}</TeamAlert>}
        {campaign && <p>{(outbound?.campaigns || []).find(c => c.code === campaign)?.description}{readinessFor(campaign)?.requiresMarketingConsent ? " Requires express marketing consent." : ""}</p>}
        {previewIsCurrent && preview && (
          <TeamTable
            head={["Contact", "Phone", "Name"]}
            rows={preview.rows.map(row => [row.contactId, `••••${row.phoneLast4}`, row.name])}
            empty="Nobody is currently eligible for this campaign."
          />
        )}
      </TeamSection>

      <TeamSection title="Campaign readiness" note="Refreshed by the background sweep. The sweep never dials — it only counts.">
        <TeamTable
          head={["#", "Campaign", "Consent", "Ready", "Refreshed"]}
          rows={(outbound?.campaigns || []).map(c => {
            const readiness = readinessFor(c.code);
            return [
              String(c.useCase), c.label,
              <Badge key={c.code} tone={c.requiresMarketingConsent ? "warning" : "neutral"}>{c.requiresMarketingConsent ? "Marketing consent" : "Own enquiry"}</Badge>,
              String(readiness?.ready ?? 0), IST(readiness?.refreshedAt),
            ];
          })}
        />
      </TeamSection>

      <TeamSection title="WhatsApp (Interakt)" note="Every journey that ends in “we'll WhatsApp you the details” needs a configured link and an approved template." actions={<Button variant="secondary" disabled={busy === "dispatch"} onClick={dispatchQueued}>{busy === "dispatch" ? "Dispatching…" : "Dispatch queued"}</Button>}>
        {gaps.length > 0 && <TeamAlert tone="info">{gaps.join(" ")}</TeamAlert>}
        <TeamTable
          head={["Link", "Journey", "Purpose", "Link", "Template"]}
          rows={(interakt?.links || []).map(link => [
            link.label, link.useCase, link.purpose,
            <Badge key={`${link.linkKey}-l`} tone={link.linkConfigured ? "success" : "danger"}>{link.linkConfigured ? "Configured" : "Missing"}</Badge>,
            <Badge key={`${link.linkKey}-t`} tone={link.templateApproved ? "success" : "warning"}>{link.templateApproved ? link.templateKey : "Not approved"}</Badge>,
          ])}
        />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
          <label style={{ display: "grid", gap: 4 }}>
            <span>Link</span>
            <select value={linkForm.linkKey} onChange={event => setLinkForm(current => ({ ...current, linkKey: event.target.value }))}>
              <option value="">Choose a link…</option>
              {(interakt?.links || []).map(link => <option key={link.linkKey} value={link.linkKey}>{link.label}</option>)}
            </select>
          </label>
          <label style={{ display: "grid", gap: 4, flex: "1 1 320px" }}>
            <span>Destination (https)</span>
            <input value={linkForm.url} onChange={event => setLinkForm(current => ({ ...current, url: event.target.value }))} placeholder="https://pawspace.in/…" />
          </label>
          <Button variant="secondary" disabled={!linkForm.linkKey || !linkForm.url || busy === "link"} onClick={saveLink}>{busy === "link" ? "Saving…" : "Save link"}</Button>
        </div>
      </TeamSection>

      <TeamSection title="WhatsApp sends" note="What the bot promised on a call, and whether it reached the customer.">
        <TeamTable
          head={["Link", "Phone", "Status", "Message", "Reason", "When"]}
          rows={sends.map(send => [
            send.linkKey, `••••${send.phoneLast4}`,
            <Badge key={send.id} tone={statusTone(send.status)}>{send.status}</Badge>,
            send.messageStatus || "—", send.reason || "—", IST(send.createdAt),
          ])}
          empty="No WhatsApp sends requested yet."
        />
      </TeamSection>

      <TeamSection title="Outbound call log" note="Every attempt, including the ones the guardrails skipped.">
        <TeamTable
          head={["Campaign", "Contact", "Phone", "Status", "Reason", "Launched by", "When"]}
          rows={calls.map(call => [
            call.campaign, call.contactId, `••••${call.phoneLast4}`,
            <Badge key={call.id} tone={statusTone(call.status)}>{call.status}</Badge>,
            call.reason || "—", call.requestedBy, IST(call.createdAt),
          ])}
          empty="No outbound calls placed yet."
        />
      </TeamSection>

      <TeamSection title="Inbound agent" note="Enquiries the inbound voice agent filed, and what it could not answer.">
        <TeamStatGrid>
          <StatCard label="FAQ answered" value={String(inbound?.faq.answered ?? 0)} meta="From approved knowledge only" />
          <StatCard label="FAQ unanswered" value={String(inbound?.faq.unanswered ?? 0)} meta="Bot refused to guess" />
          <StatCard label="Transfers" value={String((inbound?.transfers || []).reduce((sum, t) => sum + t.count, 0))} meta={(inbound?.transfers || []).map(t => `${t.status}: ${t.count}`).join(" · ") || "None"} />
        </TeamStatGrid>
        <TeamTable
          head={["Category", "Enquiries", "Cases opened"]}
          rows={(inbound?.categories || []).filter(c => c.count > 0).map(c => [c.label, String(c.count), String(c.cases)])}
          empty="The inbound agent has not filed an enquiry yet."
        />
      </TeamSection>

      <TeamSection title="Grooming package recommendations" note="What the bot may recommend, computed from the live catalogue and the governed rule set.">
        {briefing && !briefing.ready && <TeamAlert tone="info">The bot cannot recommend a package yet. {briefing.packagesWithoutRules.length > 0 && `No rule reaches: ${briefing.packagesWithoutRules.join(", ")}. `}{briefing.rulesPointingAtMissingPackages.length > 0 && `Rules point at packages the catalogue no longer sells: ${briefing.rulesPointingAtMissingPackages.join(", ")}.`}</TeamAlert>}
        <TeamTable
          head={["Package", "Price", "Rules"]}
          rows={(briefing?.packages || []).map(p => [p.name || p.packageCode, `${p.currency} ${p.price}`, String(p.recommendedFor.length)])}
          empty="No active grooming packages in the catalogue."
        />
      </TeamSection>
    </TeamShell>
  );
}
