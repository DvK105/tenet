/**
 * Storage types - Supabase and local storage abstractions
 */

export type StorageProvider = "supabase" | "local";

export interface StorageFile {
  name: string;
  path: string;
  size?: number;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface StorageUploadOptions {
  contentType?: string;
  upsert?: boolean;
  cacheControl?: string;
}

export interface StorageUrlOptions {
  expiresIn?: number; // seconds for signed URLs
}

export interface StorageService {
  upload(filePath: string, data: Buffer | ArrayBuffer | string, options?: StorageUploadOptions): Promise<string>;
  exists(filePath: string): Promise<boolean>;
  getUrl(filePath: string, options?: StorageUrlOptions): Promise<string>;
  delete(filePath: string): Promise<void>;
  list(prefix?: string): Promise<StorageFile[]>;
}
