import { execFile } from "node:child_process";

export type Notifier = (title: string, body: string) => Promise<string | undefined>;

export const desktopNotifier: Notifier = (title, body) =>
  new Promise((resolve) => {
    execFile(
      "notify-send",
      ["-a", "web-agent", "-u", "critical", "--", title, body],
      (error, _stdout, stderr) =>
        resolve(error ? `${String(stderr).trim().split("\n")[0] || error.message}` : undefined),
    );
  });
