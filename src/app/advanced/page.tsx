import { redirect } from "next/navigation";

export default function AdvancedRedirect() {
  redirect("/settings?tab=pipeline");
}
