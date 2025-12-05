import { serve } from "inngest/next";
import { inngest } from "../../../inngest/client";
import { renderJobFunctions } from "@/inngest/functions/render-job";

// Create an API that serves zero functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: renderJobFunctions,
});