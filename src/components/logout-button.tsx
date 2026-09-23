"use client";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="ghost"
      onClick={async () => {
        await createSupabaseBrowserClient().auth.signOut();
        router.replace("/login");
        router.refresh();
      }}
    >
      Salir
    </button>
  );
}
