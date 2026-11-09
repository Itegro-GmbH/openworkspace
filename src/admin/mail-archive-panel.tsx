import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";
import type { AdminMailbox } from "./types";

const QUERY_KEY = ["admin-archive"];

function ageLabel(value: string | Date) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

export function MailArchivePanel({ mailboxes }: { mailboxes: AdminMailbox[] | undefined }) {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => responseJson(await api.api.admin.archive.$get()),
    refetchInterval: 30_000,
  });
  const retry = useMutation({
    mutationFn: async () => responseJson(await api.api.admin.archive.retry.$post()),
    onSuccess: async (result) => {
      toast.success(
        result.attempted
          ? `${result.archived} archived, ${result.failed} still failing`
          : "Nothing to archive",
      );
      await client.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (error) => toast.error(error.message),
  });
  const data = status.data;
  const open = (data?.pending ?? 0) + (data?.failed ?? 0);
  const healthy = data ? data.configured && data.failed === 0 : true;
  const addressById = new Map((mailboxes ?? []).map((box) => [box.id, box.address]));

  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Archive}
        title="Mail archive"
        description="Unalterable journal copy of all incoming and outgoing mail"
      >
        {data ? (
          <Badge variant={healthy ? "outline" : "destructive"}>
            {!data.configured ? "Not configured" : data.failed ? "Needs attention" : "Healthy"}
          </Badge>
        ) : null}
      </AdminPanelHeader>
      <AdminPanelBody className="space-y-4">
        {status.isLoading ? <Skeleton className="h-16 w-full" /> : null}
        {status.isError ? (
          <p className="text-sm text-destructive">Could not load the archive status.</p>
        ) : null}
        {data ? (
          <>
            {!data.configured ? (
              <p className="flex items-start gap-2 text-sm text-destructive">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                The archive bucket is not connected. Mail is still delivered, but nothing is archived.
              </p>
            ) : null}
            <dl className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">Archived</dt>
                <dd className="text-lg font-semibold">{data.archived}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Waiting</dt>
                <dd className="text-lg font-semibold">{data.pending}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Failed</dt>
                <dd className={`text-lg font-semibold ${data.failed ? "text-destructive" : ""}`}>
                  {data.failed}
                </dd>
              </div>
            </dl>
            {open ? (
              <ul className="divide-y divide-border/70 rounded-lg border border-border/70 text-xs">
                {data.open.map((entry) => (
                  <li key={entry.id} className="space-y-0.5 px-3 py-2">
                    <p className="font-medium">
                      {entry.direction === "incoming" ? "Incoming" : "Outgoing"}
                      {" · "}
                      {addressById.get(entry.mailboxId) ?? entry.mailboxId}
                      {" · "}
                      waiting {ageLabel(entry.createdAt)}
                      {entry.attempts ? ` · ${entry.attempts} attempts` : ""}
                    </p>
                    {entry.lastError ? (
                      <p className="break-words text-muted-foreground">{entry.lastError}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="flex items-center justify-between gap-4">
              <p className="text-xs leading-relaxed text-muted-foreground">
                Missing copies are retried automatically every 10 minutes. After fixing the cause,
                archive them right away.
              </p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={retry.isPending}
                onClick={() => retry.mutate()}
              >
                {retry.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
                Archive now
              </Button>
            </div>
          </>
        ) : null}
      </AdminPanelBody>
    </div>
  );
}
