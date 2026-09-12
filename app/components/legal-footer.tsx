import Link from "next/link";

export default function LegalFooter() {
  return (
    <footer className="legal-footer" aria-label="Legal and privacy links">
      <span>© {new Date().getFullYear()} PawSpace</span>
      <nav>
        <Link href="/legal/privacy">Privacy</Link>
        <Link href="/legal/terms">Terms</Link>
        <Link href="/legal/data-processing">Data Processing & Sub-processors</Link>
      </nav>
    </footer>
  );
}
