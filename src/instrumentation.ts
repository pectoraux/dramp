// Next.js instrumentation — runs once on server startup.
// Starts the dRamp background engine ticker (market simulation + execution
// advancement). Guarded by a global singleton so hot-reload doesn't spawn
// duplicates.

export async function register() {
  // Only run in the Node.js runtime (not edge).
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.NODE_ENV === "production") {
    // Also start in production builds for completeness.
  }
  // Dynamically import to avoid pulling server-only code into edge bundles.
  const { startEngineTicker } = await import("@/lib/engine/ticker");
  startEngineTicker();
}
