import { inngest } from "../client"

export const helloOnUpload = inngest.createFunction(
  { id: "hello-on-upload" },
  { event: "render/uploaded" },
  async ({ event, step }) => {
    const { id, filename } = event.data as { id: string; filename: string }
    await step.run("log-hello", async () => {
      console.log(`Inngest hello world for ${filename} (job ${id})`)
    })
    return { ok: true, message: `Hello from Inngest for ${filename}` }
  }
)
