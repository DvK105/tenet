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

export function getSupabaseBrowserClient(): ReturnType<typeof createClient> | null {
  if (cached) return cached;

  try {
    const url = requirePublicEnv("NEXT_PUBLIC_SUPABASE_URL");
    const anonKey = requirePublicEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");

    cached = createClient(url, anonKey);
    return cached;
  } catch (error) {
    // Return null instead of throwing to prevent toast notifications
    // The calling code should handle this gracefully
    console.warn("Supabase client not configured:", error instanceof Error ? error.message : String(error));
    return null;
  }
}

export function getSupabaseInputsBucket(): string {
  return process.env.NEXT_PUBLIC_SUPABASE_INPUTS_BUCKET || "blends";
}
