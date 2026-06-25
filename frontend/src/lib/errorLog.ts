// A small in-memory ring buffer of recent runtime errors. The "copy" button on
// error toasts pulls from this so a copied report carries enough context
// (recent errors + page + browser) to actually debug from.

interface LogEntry {
  t: string;
  kind: string;
  msg: string;
}

const buffer: LogEntry[] = [];
const MAX = 30;

export function logAppError(kind: string, msg: string): void {
  buffer.push({ t: new Date().toISOString(), kind, msg: String(msg).slice(0, 2000) });
  while (buffer.length > MAX) buffer.shift();
}

export function recentErrors(limit = 12): LogEntry[] {
  return buffer.slice(-limit);
}

let installed = false;
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  window.addEventListener("error", (e) => {
    const where = e.filename ? ` @ ${e.filename}:${e.lineno}:${e.colno}` : "";
    logAppError("error", `${e.message}${where}`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = (e as PromiseRejectionEvent).reason;
    logAppError("unhandledrejection", reason?.stack || reason?.message || String(reason));
  });
}

/** A copy-pasteable report for an error toast: the message + recent errors + context. */
export function buildErrorReport(title: string, description: string): string {
  const lines: string[] = [`LeLab error — ${new Date().toISOString()}`, `Page: ${window.location.href}`];
  if (title) lines.push("", title);
  if (description) lines.push(description);

  const errs = recentErrors();
  if (errs.length) {
    lines.push("", "— recent errors —");
    for (const e of errs) lines.push(`[${e.t}] ${e.kind}: ${e.msg}`);
  }

  lines.push("", "— browser —", navigator.userAgent);
  return lines.join("\n");
}
