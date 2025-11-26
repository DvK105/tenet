import { NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

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

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  const bucket = process.env.SUPABASE_BUCKET_NAME || "renders"

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

  return NextResponse.json({
    ok: true,
    // Use the storage path as a stable identifier for the job
    id: storedPath,
    bucket,
    path: storedPath,
    originalName: file.name,
  })
}

import { NextResponse } from "next/server"
import { inngest } from "@/inngest/client"

export const runtime = "nodejs"

export async function POST(req: Request) {
  try {
    const contentType = req.headers.get("content-type") || ""
    if (!contentType.includes("multipart/form-data")) {
      return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 })
    }

    const form = await req.formData()
    const file = form.get("blend")

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'Upload a file in field "blend"' }, { status: 400 })
    }

    const filename = file.name
    if (!filename.toLowerCase().endsWith(".blend")) {
      return NextResponse.json({ error: 'Only .blend files are accepted in field "blend"' }, { status: 400 })
    }
    const id = crypto.randomUUID()

    // Fire-and-forget event to Inngest
    inngest
      .send({
        name: "render/uploaded",
        data: { id, filename },
      })
      .catch((err) => {
        console.error("Failed to send Inngest event render/uploaded:", err)
      })

    return NextResponse.json({ ok: true, id, name: filename })
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed"
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
