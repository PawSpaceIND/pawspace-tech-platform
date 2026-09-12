import Link from "next/link";

export default function LegalLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="legal-shell">
      <header className="legal-header">
        <Link href="/">PawSpace</Link>
        <nav aria-label="Legal documents">
          <Link href="/legal/privacy">Privacy</Link>
          <Link href="/legal/terms">Terms</Link>
          <Link href="/legal/data-processing">Data Processing</Link>
        </nav>
      </header>
      <article className="legal-document">{children}</article>
    </main>
  );
}
