import "./globals.css";
import type { ReactNode } from "react";
import { Sidebar } from "./_sidebar";

export const metadata = {
  title: "Conveyer Hum",
  description: "Local pipeline platform for faceless AI YouTube videos — Grok video + MiniMax voice.",
};

// Applied before first paint so the chosen theme doesn't flash (anti-FOUC).
// Lives as the first node inside <body> — a manual <head> in an App Router
// layout breaks hydration, so it must NOT go there.
const themeScript = `try{if(localStorage.getItem('theme')==='light'){document.documentElement.setAttribute('data-theme','light');}}catch(e){}`;

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        <div className="app-shell">
          <Sidebar />
          <main className="app-main">
            <div className="app-content">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
