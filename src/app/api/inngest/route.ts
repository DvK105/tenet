import { serve } from "inngest/next";
import { inngest } from "../../../inngest/client";
import { renderFunction } from "../../../inngest/functions";

export const runtime = "nodejs";
export const maxDuration = 300;

// Create an API that serves Inngest functions
export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    renderFunction,
  ],
});