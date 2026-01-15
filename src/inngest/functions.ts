import { inngest } from "./client";

export const renderFunction = inngest.createFunction(
  { id: "render-function" },
  { event: "render/invoked" },
  async ({ event, step }) => {
    await step.run("print-message", async () => {
      console.log("render invoked");
    });
  }
);
