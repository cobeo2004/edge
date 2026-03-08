/**
 * Forcefully kills the process with the given ID.
 * On Linux/Unix, this means sending the process the SIGKILL signal.
 */
export function forceKill(pid: number) {
  try {
    const signal = "SIGKILL";
    process.kill(pid, signal);
  } catch (e: any) {
    // Allow this call to fail with
    // ESRCH, which meant that the process
    // to be killed was already dead.
    // But re-throw on other codes.
    if (e.code !== "ESRCH") {
      throw e;
    }
  }
}
