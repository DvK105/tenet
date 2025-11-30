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
    const contentType = req.headers.get("content-type") || ""
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Expected multipart/form-data" },
        { status: 400 },
      )
    }

    const form = await req.formData()
    const file = form.get("blend")

    if (!file || !(file instanceof File)) {
      return NextResponse.json(
        { error: 'Missing file field "blend"' },
        { status: 400 },
      )
    }

    const ext = getExtension(file.name)
    if (!(ALLOWED_3D_EXTENSIONS as readonly string[]).includes(ext)) {
      return NextResponse.json(
        { error: "Only 3D files are allowed", allowed: ALLOWED_3D_EXTENSIONS },
        { status: 400 },
      )
    }

    // Check file size (50MB limit)
    const maxSize = 50 * 1024 * 1024 // 50MB in bytes
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: `File size exceeds 50MB limit. File size: ${(file.size / 1024 / 1024).toFixed(2)}MB` },
        { status: 400 },
      )
    }

    const supabaseUrl =
      process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
    const supabaseKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
    const bucket =
      process.env.SUPABASE_INPUT_BUCKET_NAME ||
      process.env.SUPABASE_BUCKET_NAME ||
      "renders-input"

    if (!supabaseUrl || !supabaseKey) {
      return NextResponse.json(
        { error: "Supabase environment variables are not configured" },
        { status: 500 },
      )
    }

    const supabase = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    })

    const arrayBuffer = await file.arrayBuffer()
    const buffer = Buffer.from(arrayBuffer)

    const timestamp = Date.now()
    const random = Math.random().toString(36).slice(2)
    const path = `uploads/${timestamp}-${random}.${ext}`

    const { data, error } = await supabase.storage
      .from(bucket)
      .upload(path, buffer, {
        contentType: file.type || "application/octet-stream",
      })

    if (error) {
      return NextResponse.json(
        { error: error.message },
        { status: 500 },
      )
    }

    const storedPath = data?.path ?? path

    // Fire-and-forget event to Inngest so your existing workflow still triggers
    inngest
      .send({
        name: "render/uploaded",
        data: { id: storedPath, filename: file.name },
      })
      .catch((err) => {
        console.error("Failed to send Inngest event render/uploaded:", err)
      })

    return NextResponse.json({
      ok: true,
      // Use the storage path as a stable identifier for the job
      id: storedPath,
      bucket,
      path: storedPath,
      originalName: file.name,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed"
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 },
    )
  }
}
