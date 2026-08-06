/** Start server-only background jobs when the Next.js Node runtime boots. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startBackgroundJobs } = await import("@/server/jobs/scheduler");
  startBackgroundJobs();
}

