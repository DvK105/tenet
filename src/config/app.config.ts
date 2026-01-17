/**
 * Application configuration - Centralized environment variable management
 */

function getEnv(name: string, defaultValue?: string): string | undefined {
  return process.env[name] ?? defaultValue;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required but not set`);
  }
  return value;
}

function getEnvAsBoolean(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (!value) return defaultValue;
  return value === "1" || value.toLowerCase() === "true";
}

function getEnvAsNumber(name: string, defaultValue?: number): number | undefined {
  const value = process.env[name];
  if (!value) return defaultValue;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Application configuration
 */
export const appConfig = {
  // Supabase configuration
  supabase: {
    url: getEnv("SUPABASE_URL"),
    serviceRoleKey: getEnv("SUPABASE_SERVICE_ROLE_KEY"),
    anonKey: getEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    urlPublic: getEnv("NEXT_PUBLIC_SUPABASE_URL"),
    isConfigured: () => Boolean(getEnv("SUPABASE_URL") && getEnv("SUPABASE_SERVICE_ROLE_KEY")),
  },

  // Storage buckets
  storage: {
    rendersBucket: getEnv("SUPABASE_STORAGE_BUCKET", "renders"),
    inputsBucket: getEnv("SUPABASE_INPUTS_BUCKET", "blends"),
    inputsBucketPublic: getEnv("NEXT_PUBLIC_SUPABASE_INPUTS_BUCKET", "blends"),
    isRendersBucketPublic: getEnvAsBoolean("SUPABASE_STORAGE_PUBLIC", false),
    isInputsBucketPublic: getEnvAsBoolean("SUPABASE_INPUTS_PUBLIC", false),
  },

  // E2B configuration
  e2b: {
    template: getEnv("E2B_TEMPLATE", "blender-headless-template"),
    defaultTimeoutMs: getEnvAsNumber("E2B_DEFAULT_TIMEOUT_MS", 3_600_000), // 1 hour
  },

  // Feature flags
  features: {
    enableLocalStorage: getEnvAsBoolean("ENABLE_LOCAL_STORAGE", true),
    enableSupabaseStorage: () => Boolean(getEnv("SUPABASE_URL") && getEnv("SUPABASE_SERVICE_ROLE_KEY")),
  },

  // API configuration
  api: {
    maxDuration: getEnvAsNumber("API_MAX_DURATION", 300), // 5 minutes
    defaultTimeout: getEnvAsNumber("API_DEFAULT_TIMEOUT", 8000), // 8 seconds
  },
} as const;

/**
 * Get Supabase URL (admin or public)
 */
export function getSupabaseUrl(): string {
  return requireEnv("SUPABASE_URL");
}

/**
 * Get Supabase service role key
 */
export function getSupabaseServiceRoleKey(): string {
  return requireEnv("SUPABASE_SERVICE_ROLE_KEY");
}

/**
 * Get Supabase anon key (public)
 */
export function getSupabaseAnonKey(): string {
  return requireEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY");
}
