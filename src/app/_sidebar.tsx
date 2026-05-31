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
    header: null,
    items: [
      {
        href: "/",
        label: "Create",
        exact: true,
        icon: (
          <svg {...iconProps}>
            <path d="m15.232 5.232 3.536 3.536M20.5 7.5 7.5 20.5l-4 1 1-4L17.5 4.5a1.414 1.414 0 0 1 3 3z" />
          </svg>
        ),
      },
      {
        href: "/clips",
        label: "Clips",
        icon: (
          <svg {...iconProps}>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="m10 8 5 3-5 3V8z" />
            <path d="M2 21h20" />
          </svg>
        ),
      },
      {
        href: "/library",
        label: "Saved Videos",
        icon: (
          <svg {...iconProps}>
            <path d="M4 19.5V5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-1.5z" />
            <path d="M8 7h6M8 11h7M8 15h5" />
          </svg>
        ),
      },
      {
        href: "/runs",
        label: "Runs",
        icon: (
          <svg {...iconProps}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5M12 7v5l4 2" />
          </svg>
        ),
      },
    ],
  },
  {
    header: null,
    items: [
      {
        href: "/prompts",
        label: "Channels",
        icon: (
          <svg {...iconProps}>
            <path d="M12 2 2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
          </svg>
        ),
      },
      {
        href: "/settings",
        label: "Settings",
        icon: (
          <svg {...iconProps}>
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        ),
      },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false); // desktop icons-only rail
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Restore the persisted desktop-collapsed preference after mount (server
  // renders expanded, so there's no hydration mismatch).
  useEffect(() => {
    try {
      if (localStorage.getItem("sidebar.collapsed") === "1") setCollapsed(true);
    } catch {}
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("sidebar.collapsed", next ? "1" : "0");
      } catch {}
      return next;
    });
  }

  useEffect(() => {
    if (typeof window === "undefined") return;
    const syncDrawer = () => {
      setDrawerOpen(window.location.hash === "#app-sidebar");
    };
    syncDrawer();
    window.addEventListener("hashchange", syncDrawer);
    return () => window.removeEventListener("hashchange", syncDrawer);
  }, []);

  // Keep the hash-driven mobile drawer in sync with route changes.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeDrawer();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  function openDrawer() {
    if (typeof window !== "undefined") {
      window.location.hash = "#app-sidebar";
    }
  }

  function closeDrawer() {
    if (typeof window !== "undefined") {
      window.history.replaceState({}, "", window.location.pathname + window.location.search);
    }
    setDrawerOpen(false);
  }

  return (
    <>
      {/* Mobile top bar with the hamburger — only shown ≤768px (CSS). */}
      <div className="mobile-topbar">
        <button
          aria-label="Open menu"
          className="btn-ghost btn-sm"
          role="button"
          style={{ display: "flex", alignItems: "center", padding: 8 }}
          onClick={openDrawer}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="sidebar-mark" style={{ width: 24, height: 24, fontSize: 13 }}>C</div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Conveyer Hum</div>
        </div>
      </div>

      <aside
        id="app-sidebar"
        className={`app-sidebar${collapsed ? " collapsed" : ""}${drawerOpen ? " open" : ""}`}
      >
        {/* Logo + collapse / close controls */}
        <div className="sidebar-head">
          <div className="sidebar-mark" style={{ width: 30, height: 30, fontSize: 15, boxShadow: "var(--shadow-sm)" }}>
            C
          </div>
          <div className="sidebar-text" style={{ lineHeight: 1.15 }}>
            <div style={{ fontWeight: 700, fontSize: 14.5 }}>Conveyer Hum</div>
            <div style={{ fontSize: 11, color: "var(--fg-faint)" }}>AI video toolkit</div>
          </div>
          {/* Desktop collapse toggle (CSS-gated to ≥768px). */}
          <button
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={!collapsed}
            aria-controls="app-sidebar"
            title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className="sidebar-collapse-toggle btn-ghost btn-sm"
            onClick={toggleCollapsed}
            style={{ marginLeft: "auto", padding: 6 }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
              {collapsed ? <path d="M9 18l6-6-6-6" /> : <path d="M15 18l-6-6 6-6" />}
            </svg>
          </button>
          {/* Close button — mobile drawer only (CSS-gated). */}
          <button
            aria-label="Close menu"
            className="sidebar-close btn-ghost btn-sm"
            style={{ marginLeft: "auto", padding: 6 }}
            onClick={closeDrawer}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Nav groups */}
        <nav style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {NAV.map((group, gi) => (
            <div key={gi} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              {group.header && (
                <div
                  className="sidebar-text"
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
                    onClick={() => {
                      if (drawerOpen) {
                        closeDrawer();
                      }
                    }}
                    className={`sidebar-link${active ? " active" : ""}`}
                    title={item.label}
                    aria-label={item.label}
                  >
                    <span className="sidebar-icon" style={{ color: active ? "var(--accent)" : "var(--fg-faint)" }}>
                      {item.icon}
                    </span>
                    <span className="sidebar-text">{item.label}</span>
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
            <div className="sidebar-text faint" style={{ fontSize: 10.5, padding: "10px 10px 2px" }}>
              v0.1 · local
            </div>
          </div>
        </div>
      </aside>

      {/* Drawer backdrop (mobile, when open). */}
      <a href="#" className="app-backdrop" aria-label="Close mobile menu" onClick={(event) => {
        event.preventDefault();
        closeDrawer();
      }} />
    </>
  );
}
