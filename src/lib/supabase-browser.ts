import { createClient } from "@supabase/supabase-js";

function requirePublicEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

let cached:
  | ReturnType<typeof createClient>
  | null = null;

export function getSupabaseBrowserClient() {
  if (cached) return cached;

  const url = requirePublicEnv("NEXT_PUBLIC_SUPABASE_URL");
  const anonKey = requirePublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

  cached = createClient(url, anonKey);
  return cached;
}

export function getSupabaseInputsBucket(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_INPUTS_BUCKET || "blends";
}
