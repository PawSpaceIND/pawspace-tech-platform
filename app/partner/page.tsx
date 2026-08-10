import Link from "next/link";
import CanonicalGroomingJobs from "../partner-app/canonical-grooming-jobs";

const linkStyle = {
  display: "inline-block",
  padding: "12px 16px",
  borderRadius: 12,
  textDecoration: "none",
  fontWeight: 800,
} as const;

export default function PartnerUatHub() {
  return (
    <main style={{ padding: 24, maxWidth: 1200, margin: "0 auto", font