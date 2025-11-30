import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { inngest } from "@/inngest/client"

export const runtime = "nodejs"
// Note: File size limits are handled in the handler below
// Next.js App Router doesn't use the config export

const ALLOWED_3D_EXTENSIONS = [
  "blend",
  "fbx",
  "obj",
  "stl",
  "gltf",
  "glb",
  "c4d",
  "ma",
  "mb",
  "hip",
] as const

function getExtension(filename: string): string {
  const parts = filename.split(".")
  return parts.length > 1 ? parts[parts.length - 1].toLowerCase() : ""
}

export async function POST(req: Request) {
  try {
    console.log("[upload] Received upload request")

    // Validate content type
    const contentType = req.headers.get("content-type") || ""
    if (!contentType.includes("multipart/form-data")) {
      console.error("[upload] Invalid content type:", contentType)
      return NextResponse.json(
        { error: "Expected multipart/form-data", received: contentType },
        { status: 400 },
      )
    }

    // Parse form data
    let form: FormData
    try {
      form = await req.formData()
    } catch (err) {
      console.error("[upload] Failed to parse form data:", err)
      return NextResponse.json(
        { error: "Failed to parse form data", details: err instanceof Error ? err.message : String(err) },
        { status: 400 },
      )
    }

    // Get file from form
    const file = form.get("blend")
    if (!file || !(file instanceof File)) {
      console.error("[upload] Missing or invalid file field")
      return NextResponse.json(
        { error: 'Missing file field "blend" or file is not a File instance' },
        { status: 400 },
      )
    }

    console.log(`[upload] File received: ${file.name}, size: ${file.size} bytes, type: ${file.type}`)

    // Validate file extension
    const ext = getExtension(file.name)
    if (!ext) {
      console.error("[upload] File has no extension:", file.name)
      return NextResponse.json(
        { error: "File must have an extension", filename: file.name },
        { status: 400 },
      )
    }

    if (!(ALLOWED_3D_EXTENSIONS as readonly string[]).includes(ext)) {
      console.error("[upload] Invalid file extension:", ext)
      return NextResponse.json(
        {
          error: "File type not allowed",
          received: ext,
          allowed: ALLOWED_3D_EXTENSIONS,
        },
        { status: 400 },
      )
    }

    // Check file size (50MB limit)
    const maxSize = 50 * 1024 * 1024 // 50MB in bytes
    if (file.size > maxSize) {
      const fileSizeMB = (file.size / 1024 / 1024).toFixed(2)
      console.error(`[upload] File size exceeds limit: ${fileSizeMB}MB > 50MB`)
      return NextResponse.json(
        {
          error: "File size exceeds 50MB limit",
          fileSize: `${fileSizeMB}MB`,
          maxSize: "50MB",
        },
        { status: 413 }, // Payload Too Large
      )
    }

    if (file.size === 0) {
      console.error("[upload] File is empty")
      return NextResponse.json(
        { error: "File is empty" },
        { status: 400 },
      )
    }

    // Get environment variables
    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    const bucket =
      process.env.SUPABASE_INPUT_BUCKET_NAME ||
      process.env.SUPABASE_BUCKET_NAME ||
      "renders-input"

    if (!supabaseUrl || !supabaseKey) {
      console.error("[upload] Supabase environment variables not configured", {
        hasUrl: !!supabaseUrl,
        hasKey: !!supabaseKey,
      })
      return NextResponse.json(
        {
          error: "Supabase environment variables are not configured",
          hasUrl: !!supabaseUrl,
          hasKey: !!supabaseKey,
        },
        { status: 500 },
      )
    }

    // Create Supabase client
    let supabase
    try {
      supabase = createClient(supabaseUrl, supabaseKey, {
        auth: { persistSession: false },
      })
    } catch (err) {
      console.error("[upload] Failed to create Supabase client:", err)
      return NextResponse.json(
        {
          error: "Failed to initialize Supabase client",
          details: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      )
    }

    // Convert file to buffer
    let arrayBuffer: ArrayBuffer
    let buffer: Buffer
    try {
      arrayBuffer = await file.arrayBuffer()
      buffer = Buffer.from(arrayBuffer)
      console.log(`[upload] File converted to buffer: ${buffer.length} bytes`)
    } catch (err) {
      console.error("[upload] Failed to convert file to buffer:", err)
      return NextResponse.json(
        {
          error: "Failed to process file",
          details: err instanceof Error ? err.message : String(err),
        },
        { status: 500 },
      )
    }

    // Generate unique path
    const timestamp = Date.now()
    const random = Math.random().toString(36).slice(2)
    const path = `uploads/${timestamp}-${random}.${ext}`
    console.log(`[upload] Generated storage path: ${path}`)

    // Upload to Supabase
    let uploadResult
    try {
      uploadResult = await supabase.storage.from(bucket).upload(path, buffer, {
        contentType: file.type || "application/octet-stream",
      })
    } catch (err) {
      console.error("[upload] Supabase upload failed:", err)
      return NextResponse.json(
        {
          error: "Failed to upload file to storage",
          details: err instanceof Error ? err.message : String(err),
          bucket,
          path,
        },
        { status: 500 },
      )
    }

    if (uploadResult.error) {
      console.error("[upload] Supabase upload error:", uploadResult.error)
      return NextResponse.json(
        {
          error: "Storage upload failed",
          message: uploadResult.error.message,
          bucket,
          path,
        },
        { status: 500 },
      )
    }

    const storedPath = uploadResult.data?.path ?? path
    console.log(`[upload] File uploaded successfully: ${storedPath}`)

    // Send event to Inngest
    try {
      await inngest.send({
        name: "render/uploaded",
        data: { id: storedPath, filename: file.name },
      })
      console.log(`[upload] Inngest event sent successfully for: ${storedPath}`)
    } catch (err) {
      // Log error but don't fail the upload - the file is already stored
      console.error("[upload] Failed to send Inngest event:", err)
      // Still return success since file was uploaded
    }

    return NextResponse.json({
      ok: true,
      id: storedPath,
      bucket,
      path: storedPath,
      originalName: file.name,
      fileSize: file.size,
    })
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : "Upload failed"
    const errorStack = err instanceof Error ? err.stack : undefined
    console.error("[upload] Unexpected error:", errorMessage, errorStack)
    return NextResponse.json(
      {
        ok: false,
        error: errorMessage,
        ...(process.env.NODE_ENV === "development" && { stack: errorStack }),
      },
      { status: 500 },
    )
  }
}
