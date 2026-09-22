"use client";

/**
 * /team/whatsapp itself answered 404 while its three children rendered, so a tester who trimmed the
 * URL or walked the route tree hit a dead end (EMP-10). This is the index for the section: it names
 * what each child does and links to it. It reads nothing and claims nothing about delivery state.
 */
import Link from "next/link";
import OpsShell from "../../components/ops-shell/OpsShell";
import teamStyles from "../team-console.module.css";

const SECTIONS = [
  {
    href: "/team/whatsapp/analytics",
    title: "Analytics",
    body: "Canonical WhatsApp funnel, automation containment, SLA, consent suppression and source attribution.",
  },
  {
    href: "/team/whatsapp/templates",
    title: "Templates",
    body: "Approved message templates, their languages and the approval state each one carries.",
  },
  {
    href: "/team/whatsapp/automation",
    title: "Automation",
    body: "Governed automation rules, their triggers and the consent each rule requires before it may send.",
  },
];

export default function WhatsAppSectionIndex() {
  return (
    <OpsShell
      eyebrow="PawSpace team · WhatsApp"
      title="WhatsApp workspace"
      description="Analytics, templates and automation for the governed WhatsApp channel. Outbound delivery stays subject to consent and to the channel configuration of this environment."
    >
      <section className={teamStyles.panel}>
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 12 }}>
          {SECTIONS.map((section) => (
            <li key={section.href}>
              <Link href={section.href} style={{ display: "block", padding: 14, borderRadius: 12, border: "1px solid #e5dcef", textDecoration: "none", color: "inherit" }}>
                <strong style={{ display: "block" }}>{section.title}</strong>
                <span style={{ fontSize: 13 }}>{section.body}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </OpsShell>
  );
}
