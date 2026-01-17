/**
 * Storage service - Unified storage interface for Supabase and local storage
 */

import { writeFile, mkdir, stat } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { createClient } from "@supabase/supabase-js";
import { appConfig, getSupabaseUrl, getSupabaseServiceRoleKey } from "@/config/app.config";
import { blenderConfig } from "@/config/blender.config";
import { StorageError } from "@/lib/errors/render-errors";
import type { StorageFile, StorageUploadOptions, StorageUrlOptions } from "@/types/storage.types";

/**
 * Unified storage service
 */
export class StorageService {
  private supabaseClient: ReturnType<typeof createClient> | null = null;

  constructor() {
    if (appConfig.features.enableSupabaseStorage()) {
      try {
        this.supabaseClient = createClient(getSupabaseUrl(), getSupabaseServiceRoleKey(), {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
        });
      } catch (error) {
        console.warn("Failed to initialize Supabase client:", error);
        this.supabaseClient = null;
      }
    }
  }

  /**
   * Upload file to storage
   */
  async upload(
    filePath: string,
    data: Buffer | ArrayBuffer | string,
    options: StorageUploadOptions & { bucket?: "renders" | "inputs" } = {}
  ): Promise<string> {
    const { bucket = "renders", ...uploadOptions } = options;

    // Try Supabase first if configured
    if (this.supabaseClient && appConfig.features.enableSupabaseStorage()) {
      try {
        const bucketName = bucket === "renders" ? appConfig.storage.rendersBucket : appConfig.storage.inputsBucket;
        const buffer = this.toBuffer(data);

        const { error } = await this.supabaseClient.storage.from(bucketName).upload(filePath, buffer, {
          contentType: uploadOptions.contentType || "application/octet-stream",
          upsert: uploadOptions.upsert ?? true,
          cacheControl: uploadOptions.cacheControl,
        });

        if (error) {
          throw StorageError.fromUpload("supabase", error, { filePath, bucket: bucketName });
        }

        return filePath;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw StorageError.fromUpload("supabase", error, { filePath, bucket });
      }
    }

    // Fallback to local storage
    if (appConfig.features.enableLocalStorage) {
      try {
        const storageDir = bucket === "renders" ? blenderConfig.local.rendersDirectory : join(process.cwd(), "public", bucket);
        await mkdir(storageDir, { recursive: true });
        const fullPath = join(storageDir, filePath);
        const buffer = this.toBuffer(data);
        await writeFile(fullPath, buffer);
        return filePath;
      } catch (error) {
        throw StorageError.fromUpload("local", error, { filePath, bucket });
      }
    }

    throw new StorageError("No storage provider configured", undefined, { filePath });
  }

  /**
   * Check if file exists
   */
  async exists(filePath: string, bucket: "renders" | "inputs" = "renders"): Promise<boolean> {
    // Try Supabase first
    if (this.supabaseClient && appConfig.features.enableSupabaseStorage()) {
      try {
        const bucketName = bucket === "renders" ? appConfig.storage.rendersBucket : appConfig.storage.inputsBucket;
        const { data, error } = await this.supabaseClient.storage.from(bucketName).list("", {
          limit: 1,
          search: filePath,
        });

        if (!error && Array.isArray(data)) {
          return data.some((file) => file.name === filePath);
        }
      } catch {
        // Fall through to local check
      }
    }

    // Fallback to local storage
    if (appConfig.features.enableLocalStorage) {
      const storageDir = bucket === "renders" ? blenderConfig.local.rendersDirectory : join(process.cwd(), "public", bucket);
      const fullPath = join(storageDir, filePath);
      return existsSync(fullPath);
    }

    return false;
  }

  /**
   * Get URL for file
   */
  async getUrl(filePath: string, options: StorageUrlOptions & { bucket?: "renders" | "inputs" } = {}): Promise<string> {
    const { bucket = "renders", expiresIn = 3600 } = options;

    // Try Supabase first
    if (this.supabaseClient && appConfig.features.enableSupabaseStorage()) {
      try {
        const bucketName = bucket === "renders" ? appConfig.storage.rendersBucket : appConfig.storage.inputsBucket;
        const isPublic = bucket === "renders" ? appConfig.storage.isRendersBucketPublic : appConfig.storage.isInputsBucketPublic;

        if (isPublic) {
          const { data } = this.supabaseClient.storage.from(bucketName).getPublicUrl(filePath);
          return data.publicUrl;
        }

        const { data, error } = await this.supabaseClient.storage
          .from(bucketName)
          .createSignedUrl(filePath, expiresIn);

        if (error || !data?.signedUrl) {
          throw StorageError.fromUrlGeneration("supabase", error, { filePath, bucket: bucketName });
        }

        return data.signedUrl;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw StorageError.fromUrlGeneration("supabase", error, { filePath, bucket });
      }
    }

    // Fallback to local storage (relative URL)
    if (appConfig.features.enableLocalStorage) {
      return `/${bucket === "renders" ? "renders" : bucket}/${filePath}`;
    }

    throw new StorageError("No storage provider configured", undefined, { filePath });
  }

  /**
   * Get file size
   */
  async getFileSize(filePath: string, bucket: "renders" | "inputs" = "renders"): Promise<number | undefined> {
    // Try Supabase first
    if (this.supabaseClient && appConfig.features.enableSupabaseStorage()) {
      try {
        const bucketName = bucket === "renders" ? appConfig.storage.rendersBucket : appConfig.storage.inputsBucket;
        const { data, error } = await this.supabaseClient.storage.from(bucketName).list("", {
          limit: 1,
          search: filePath,
        });

        if (!error && Array.isArray(data)) {
          const file = data.find((f) => f.name === filePath);
          return file?.metadata?.size ? Number(file.metadata.size) : undefined;
        }
      } catch {
        // Fall through to local check
      }
    }

    // Fallback to local storage
    if (appConfig.features.enableLocalStorage) {
      try {
        const storageDir = bucket === "renders" ? blenderConfig.local.rendersDirectory : join(process.cwd(), "public", bucket);
        const fullPath = join(storageDir, filePath);
        if (existsSync(fullPath)) {
          const stats = await stat(fullPath);
          return stats.size;
        }
      } catch {
        // Ignore
      }
    }

    return undefined;
  }

  /**
   * Delete file
   */
  async delete(filePath: string, bucket: "renders" | "inputs" = "renders"): Promise<void> {
    // Try Supabase first
    if (this.supabaseClient && appConfig.features.enableSupabaseStorage()) {
      try {
        const bucketName = bucket === "renders" ? appConfig.storage.rendersBucket : appConfig.storage.inputsBucket;
        const { error } = await this.supabaseClient.storage.from(bucketName).remove([filePath]);
        if (error) {
          throw new StorageError(`Failed to delete from Supabase: ${error.message}`, "supabase", { filePath, bucket: bucketName });
        }
        return;
      } catch (error) {
        if (error instanceof StorageError) throw error;
        throw StorageError.fromUpload("supabase", error, { filePath, bucket });
      }
    }

    // Local storage deletion not implemented for safety
    throw new StorageError("File deletion not supported for local storage", "local", { filePath });
  }

  /**
   * List files
   */
  async list(prefix = "", bucket: "renders" | "inputs" = "renders"): Promise<StorageFile[]> {
    // Try Supabase first
    if (this.supabaseClient && appConfig.features.enableSupabaseStorage()) {
      try {
        const bucketName = bucket === "renders" ? appConfig.storage.rendersBucket : appConfig.storage.inputsBucket;
        const { data, error } = await this.supabaseClient.storage.from(bucketName).list(prefix);

        if (error || !Array.isArray(data)) {
          return [];
        }

        return data.map((file) => ({
          name: file.name,
          path: file.name,
          size: file.metadata?.size ? Number(file.metadata.size) : undefined,
          isDirectory: false, // Supabase doesn't provide this info
        }));
      } catch {
        // Fall through to empty result
      }
    }

    // Local storage listing not implemented
    return [];
  }

  /**
   * Convert data to Buffer
   */
  private toBuffer(data: Buffer | ArrayBuffer | string): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (typeof data === "string") return Buffer.from(data, "binary");
    return Buffer.from(String(data), "binary");
  }
}

// Singleton instance
let storageServiceInstance: StorageService | null = null;

/**
 * Get storage service instance
 */
export function getStorageService(): StorageService {
  if (!storageServiceInstance) {
    storageServiceInstance = new StorageService();
  }
  return storageServiceInstance;
}
