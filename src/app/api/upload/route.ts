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
