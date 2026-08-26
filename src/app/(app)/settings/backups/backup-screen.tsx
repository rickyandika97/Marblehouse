"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  DatabaseBackup,
  Download,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

type OffsiteLevel = "green" | "amber" | "red";

export type BackupStatusView = {
  lastLocalBackupAt: string | null;
  localBackupIsStale: boolean;
  lastOffsiteCopyAt: string | null;
  offsiteLevel: OffsiteLevel;
  offsiteDaysAgo: number | null;
  archiveCount: number;
  message: string | null;
  latestArchiveFileName: string | null;
};

export type BackupRunView = {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  succeeded: boolean;
  sizeBytes: number | null;
  errorText: string | null;
};

export type BackupArchiveView = {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
};

function formatDateTime(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = -1;
  do {
    value /= 1024;
    i++;
  } while (value >= 1024 && i < units.length - 1);
  return `${value.toFixed(1)} ${units[i]}`;
}

function downloadHref(fileName?: string | null): string {
  return fileName
    ? `/api/backups/download?file=${encodeURIComponent(fileName)}`
    : "/api/backups/download";
}

export function BackupScreen({
  status,
  runs,
  archives,
}: {
  status: BackupStatusView;
  runs: BackupRunView[];
  archives: BackupArchiveView[];
}) {
  const router = useRouter();
  const [backingUp, setBackingUp] = useState(false);
  const [copying, setCopying] = useState(false);

  async function takeBackupNow() {
    setBackingUp(true);
    try {
      const response = await fetch("/api/backups", { method: "POST" });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(body?.error?.message ?? "The backup failed.");
        return;
      }
      toast.success(`Backup complete: ${body.fileName}`);
      router.refresh();
    } finally {
      setBackingUp(false);
    }
  }

  async function recordCopy(fileName: string | null) {
    setCopying(true);
    try {
      const response = await fetch("/api/backups/offsite-copy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(fileName ? { fileName } : {}),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        toast.error(body?.error?.message ?? "Could not record that copy.");
        return;
      }
      toast.success(`Recorded: ${body.fileName} copied off-machine.`);
      router.refresh();
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Backups</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          A backup is written locally every night. Copying it off this
          machine is the only thing that protects the business if this
          computer is lost, stolen or destroyed.
        </p>
      </div>

      {status.localBackupIsStale && (
        <Banner
          tone="critical"
          title="Backups are not running"
          text={
            status.lastLocalBackupAt === null
              ? "No successful backup has ever completed. Nothing on this server is protected."
              : `The last successful backup was ${formatDateTime(status.lastLocalBackupAt)}. Backups should run automatically every night at 02:00.`
          }
        />
      )}

      {status.offsiteLevel !== "green" && (
        <Banner
          tone={status.offsiteLevel === "red" ? "critical" : "warn"}
          title={
            status.offsiteLevel === "red"
              ? "No off-machine backup copy"
              : "Off-machine backup copy is overdue"
          }
          text={
            status.message ??
            "Copy a backup off this machine as soon as possible."
          }
        />
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Take a backup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-sm text-muted-foreground">
                Last local backup
              </dt>
              <dd className="font-medium">
                {formatDateTime(status.lastLocalBackupAt)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">
                Last off-machine copy
              </dt>
              <dd className="font-medium">
                {formatDateTime(status.lastOffsiteCopyAt)}
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">
                Archives kept on disk
              </dt>
              <dd className="font-medium">{status.archiveCount}</dd>
            </div>
          </dl>

          <div className="flex flex-wrap gap-3">
            <Button
              onClick={takeBackupNow}
              disabled={backingUp}
              className="gap-2"
            >
              <DatabaseBackup className="size-4" />
              {backingUp ? "Backing up…" : "Take a backup now"}
            </Button>

            {status.latestArchiveFileName && (
              <>
                <Button
                  variant="outline"
                  render={
                    <a
                      href={downloadHref(status.latestArchiveFileName)}
                    />
                  }
                  className="gap-2"
                >
                  <Download className="size-4" />
                  Download latest backup
                </Button>
                <Button
                  variant="secondary"
                  disabled={copying}
                  onClick={() => recordCopy(status.latestArchiveFileName)}
                  className="gap-2"
                >
                  <CheckCircle2 className="size-4" />
                  {copying ? "Recording…" : "I copied this off-machine"}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Archives on disk</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {archives.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No backup archive exists yet.
            </p>
          ) : (
            <div className="divide-y">
              {archives.map((a) => (
                <div
                  key={a.fileName}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{a.fileName}</div>
                    <div className="text-sm text-muted-foreground">
                      {formatDateTime(a.createdAt)} ·{" "}
                      {formatBytes(a.sizeBytes)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    render={<a href={downloadHref(a.fileName)} />}
                    className="gap-1.5"
                  >
                    <Download className="size-4" />
                    Download
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recent backup runs</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {runs.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No backup has run yet.
            </p>
          ) : (
            <div className="divide-y">
              {runs.map((r) => (
                <div key={r.id} className="space-y-1 px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span
                      className={cn(
                        "font-medium",
                        r.succeeded
                          ? "text-foreground"
                          : "text-red-700 dark:text-red-400"
                      )}
                    >
                      {r.succeeded ? "Succeeded" : "Failed"}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {formatDateTime(r.startedAt)}
                    </span>
                    {r.sizeBytes !== null && (
                      <span className="text-sm text-muted-foreground">
                        · {formatBytes(r.sizeBytes)}
                      </span>
                    )}
                  </div>
                  {r.errorText && (
                    <p className="text-sm text-red-700 dark:text-red-400">
                      {r.errorText}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Banner({
  tone,
  title,
  text,
}: {
  tone: "warn" | "critical";
  title: string;
  text: string;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 rounded-md p-3",
        tone === "critical"
          ? "bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200"
          : "bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200"
      )}
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-0.5 text-sm leading-relaxed">
        <p className="font-semibold">{title}</p>
        <p>{text}</p>
      </div>
    </div>
  );
}
