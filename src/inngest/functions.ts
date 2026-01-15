import { inngest } from "./client";
import { Sandbox } from "e2b";

export const renderFunction = inngest.createFunction(
  { id: "render-function" },
  { event: "render/invoked" },
  async ({ event, step }) => {
    await step.run("print-message", async () => {
      console.log("render invoked");
    });

    await step.run("initialize-e2b-sandbox", async () => {
      const sandbox = await Sandbox.create({ 
        template: "blender-headless-template" 
      });
      console.log("E2B sandbox initialized:", sandbox.sandboxId);
      // Sandbox will be available for subsequent operations
      // Note: Consider closing the sandbox when done with: await sandbox.close()
    });
  }
);
