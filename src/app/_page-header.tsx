import Link from "next/link";
import type { ReactNode } from "react";

export function PageBackLink({ href, className }: { href: string; className?: string }) {
  const classes = ["btn-secondary", "btn-sm", "page-back-link", className].filter(Boolean).join(" ");

  return (
    <Link className={classes} href={href} aria-label="Back">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M19 12H5" />
        <path d="m12 19-7-7 7-7" />
      </svg>
      <span>Back</span>
    </Link>
  );
}

export function PageHeader({
  backHref,
  eyebrow,
  title,
  description,
  actions,
}: {
  backHref?: string;
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      {backHref && <PageBackLink href={backHref} />}
      <div className="page-header-row">
        <div className="page-header-copy">
          {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
          <h1>{title}</h1>
          {description && <p className="muted">{description}</p>}
        </div>
        {actions && <div className="page-header-actions">{actions}</div>}
      </div>
    </header>
  );
}
