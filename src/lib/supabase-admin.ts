import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

export function hasSupabaseConfig(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

let cached:
  | ReturnType<typeof createClient>
  | null = null;

export function getSupabaseAdmin() {
  if (cached) return cached;

  const url = requireEnv("SUPABASE_URL");
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");

  cached = createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });

  return cached;
}

export function tryGetSupabaseAdmin() {
  if (!hasSupabaseConfig()) return null;
  return getSupabaseAdmin();
}

export function getSupabaseRendersBucket(): string {
  return process.env.SUPABASE_STORAGE_BUCKET || "renders";
}

export function getSupabaseInputsBucket(): string {
  return process.env.SUPABASE_INPUTS_BUCKET || "blends";
}

export function isSupabaseInputsBucketPublic(): boolean {
  return process.env.SUPABASE_INPUTS_PUBLIC === "1";
}

export function isSupabaseBucketPublic(): boolean {
  return process.env.SUPABASE_STORAGE_PUBLIC === "1";
}

export async function getRenderObjectUrl(objectPath: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const bucket = getSupabaseRendersBucket();

  if (isSupabaseBucketPublic()) {
    const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    return data.publicUrl;
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, 60 * 60);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Failed to create signed URL");
  }

  return data.signedUrl;
}

export async function getInputObjectUrl(objectPath: string): Promise<string> {
  const supabase = getSupabaseAdmin();
  const bucket = getSupabaseInputsBucket();

  if (isSupabaseInputsBucketPublic()) {
    const { data } = supabase.storage.from(bucket).getPublicUrl(objectPath);
    return data.publicUrl;
  }

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(objectPath, 60 * 60);

  if (error || !data?.signedUrl) {
    throw new Error(error?.message || "Failed to create signed URL");
  }

  return data.signedUrl;
}
