import { inngest } from "./client";
import { Sandbox } from "e2b";

export const renderFunction = inngest.createFunction(
  { id: "render-function" },
  { event: "render/invoked" },
  async ({ event, step }) => {
    await step.run("print-message", async () => {
      console.log("render invoked");
    });

    const sandboxId = event.data.sandboxId as string | undefined;

    await step.run("connect-to-e2b-sandbox", async () => {
      if (!sandboxId) {
        throw new Error("sandboxId is required in event data");
      }

      // Connect to existing sandbox instead of creating a new one
      // Extend timeout to ensure sandbox stays alive for rendering
      const sandbox = await Sandbox.connect(sandboxId, {
        timeoutMs: 3600000, // 1 hour timeout
      });
      console.log("Connected to existing E2B sandbox:", sandbox.sandboxId);
      
      // Verify the Blender file exists in the sandbox
      const files = await sandbox.files.list("/tmp");
      const blenderFile = files.find((f) => f.name === "uploaded.blend");
      
      if (!blenderFile) {
        throw new Error("Blender file not found in sandbox");
      }
      
      console.log("Blender file found in sandbox:", blenderFile.name);
      
      // Sandbox is now ready for rendering operations
      // The Blender file is already at /tmp/uploaded.blend
      // Note: Consider closing the sandbox when done with: await sandbox.close()
    });
  }
);
