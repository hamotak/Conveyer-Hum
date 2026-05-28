import { redirect } from "next/navigation";

// Advanced settings were merged into the consolidated /settings page (Prompt 8).
// Keep this route alive so old bookmarks land on the relevant tab instead of 404.
export default function AdvancedRedirect() {
  redirect("/settings?tab=pipeline");
}
