import express from "express";
import { serve } from "inngest/express";
// Reuse the existing Inngest client and functions from the main app
import { inngest } from "../../src/inngest/client";
import { renderJob } from "../../src/inngest/functions/render-job";
const app = express();
// Create the Inngest HTTP handler
const inngestHandler = serve({
    client: inngest,
    functions: [renderJob],
});
// Mount under /api/inngest to mirror your Vercel route
app.use("/api/inngest", inngestHandler);
const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
    console.log(`[inngest-server] Listening on http://localhost:${port}/api/inngest`);
});
