"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { ThemeToggle } from "./_theme-toggle";

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  exact?: boolean;
}

interface NavGroup {
  header: string | null;
  items: NavItem[];
}

const iconProps = {
  width: 17,
  height: 17,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const NAV: NavGroup[] = [
  {
    header: "Modes",
    items: [
      {
        href: "/",
        label: "Video Conveyer",
        exact: true,
        icon: (
          <svg {...iconProps}>
            <rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18" />
            <path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5" />
          </svg>
        ),
      },
      {
        href: "/voiceover",
        label: "Voiceover",
        icon: (
          <svg {...iconProps}>
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <path d="M12 19v4M8 23h8" />
          </svg>
        ),
      },
      {
        href: "/reassembly",
        label: "Re-assembly",
        icon: (
          <svg {...iconProps}>
            <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
          </svg>
        ),
      },
    ],
  },
  {
    header: "Work",
    items: [
      {
        href: "/runs",
        label: "Run history",
        icon: (
          <svg {...iconProps}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5M12 7v5l4 2" />
          </svg>
        ),
      },
      {
        href: "/library",
        label: "Library",
        icon: (
          <svg {...iconProps}>
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        ),
      },
    ],
  },
  {
    header: "Setup",
    items: [
      {
        href: "/prompts",
        label: "Channels & Prompts",
        icon: (
          <svg {...iconProps}>
            <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        ),
      },
      {
        href: "/settings",
        label: "Keys & Settings",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        ),
      },
      {
        href: "/advanced",
        label: "Advanced",
        icon: (
          <svg {...iconProps}>
            <path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6" />
          </svg>
        ),
      },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Close the drawer on navigation.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // ESC closes the drawer while it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      {/* Mobile top bar with the hamburger — only shown ≤768px (CSS). */}
      <div className="mobile-topbar">
        <button
          aria-label="Open menu"
          className="btn-ghost btn-sm"
          onClick={() => setOpen(true)}
          style={{ display: "flex", alignItems: "center", padding: 8 }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 24,
              height: 24,
              borderRadius: 6,
              background: "linear-gradient(135deg, var(--accent), #ff8a72)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 800,
              fontSize: 13,
              color: "#fff",
            }}
          >
            C
          </div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Conveyer Hum</div>
        </div>
      </div>

      {/* Drawer backdrop (mobile, when open). */}
      {open && <div className="app-backdrop" onClick={() => setOpen(false)} />}

      <aside className={`app-sidebar${open ? " open" : ""}`}>
      {/* Logo */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "4px 8px 22px" }}>
        <div
          style={{
            width: 30,
            height: 30,
            borderRadius: 8,
            background: "linear-gradient(135deg, var(--accent), #ff8a72)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontWeight: 800,
            fontSize: 15,
            color: "#fff",
            boxShadow: "var(--shadow-sm)",
            flexShrink: 0,
          }}
        >
          C
        </div>
        <div style={{ lineHeight: 1.15 }}>
          <div style={{ fontWeight: 700, fontSize: 14.5, letterSpacing: "-0.02em" }}>
            Conveyer Hum
          </div>
          <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>AI video toolkit</div>
        </div>
        {/* Close button — mobile drawer only (CSS-gated). */}
        <button
          aria-label="Close menu"
          className="sidebar-close btn-ghost btn-sm"
          onClick={() => setOpen(false)}
          style={{ marginLeft: "auto", padding: 6 }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Nav groups */}
      <nav style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {NAV.map((group, gi) => (
          <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {group.header && (
              <div
                style={{
                  fontSize: 10.5,
                  fontWeight: 700,
                  letterSpacing: "0.09em",
                  textTransform: "uppercase",
                  color: "var(--fg-faint)",
                  padding: "0 10px 6px",
                }}
              >
                {group.header}
              </div>
            )}
            {group.items.map((item) => {
              const active = item.exact
                ? pathname === item.href
                : pathname === item.href || pathname.startsWith(item.href + "/");
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  onClick={() => setOpen(false)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    padding: "8px 10px",
                    borderRadius: 8,
                    fontSize: 13.5,
                    fontWeight: active ? 600 : 500,
                    color: active ? "var(--fg)" : "var(--fg-muted)",
                    background: active ? "var(--surface-2)" : "transparent",
                    border: `1px solid ${active ? "var(--border-strong)" : "transparent"}`,
                    textDecoration: "none",
                    transition: "background 0.13s, color 0.13s, border-color 0.13s",
                  }}
                >
                  <span
                    style={{
                      color: active ? "var(--accent)" : "var(--fg-faint)",
                      display: "flex",
                    }}
                  >
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer */}
      <div style={{ marginTop: "auto", paddingTop: 14 }}>
        <div style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}>
          <ThemeToggle />
          <div style={{ fontSize: 11, color: "var(--fg-faint)", padding: "10px 10px 2px" }}>
            v0.1 · runs locally
          </div>
        </div>
      </div>
    </aside>
  );
}
