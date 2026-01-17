/**
 * Sandbox output utilities - Decode various response formats
 */

/**
 * Decode sandbox text output from various formats
 */
export function decodeSandboxText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf-8");
  if (value instanceof ArrayBuffer) return Buffer.from(value).toString("utf-8");
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer).toString("utf-8");
  return Buffer.from(value as ArrayBuffer).toString("utf-8");
}

/**
 * Convert sandbox file data to Buffer
 */
export function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer);
  if (Array.isArray(data)) return Buffer.from(data);
  
  // Handle serialized Buffer from Inngest step results
  if (
    data &&
    typeof data === "object" &&
    "type" in data &&
    data.type === "Buffer" &&
    "data" in data &&
    Array.isArray(data.data)
  ) {
    return Buffer.from(data.data as number[]);
  }

  // Fallback: convert to string then to buffer
  return Buffer.from(String(data), "binary");
}
