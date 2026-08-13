// Next.js instrumentation — runs once on server startup.
// Starts the dRamp background engine ticker (market simulation + execution
// advancement) in long-running servers (dev / self-hosted). On Vercel
// (serverless), we skip the persistent ticker and rely on on-demand
// advancement wired into the read endpoints (advanceActiveExecutions /
// advanceOneOnDemand), which fires on each polled request.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  // Skip the persistent ticker on Vercel — serverless functions are
  // short-lived and setInterval wouldn't persist. The UI polls every 2s,
  // triggering on-demand advancement instead.
  if (process.env.VERCEL) return;
  const { startEngineTicker } = await import("@/lib/engine/ticker");
  startEngineTicker();
}
