import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export async function POST() {
  const supabase = await createClient();
  await supabase.auth.signOut();

  const url = new URL("/auth/login", process.env.NEXT_PUBLIC_APP_URL);
  return NextResponse.redirect(url);
}
