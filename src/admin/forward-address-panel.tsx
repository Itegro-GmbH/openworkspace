import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, RefreshCw, Forward } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelHeader,
} from "./admin-panel";
import { CopyableValueRow } from "./copyable-value-row";
import type { AdminMailbox } from "./types";

export function ForwardAddressPanel({ mailbox }: { mailbox: AdminMailbox }) {
  const client = useQueryClient();
  const rotate = useMutation({
    mutationFn: async () => responseJson(
      await api.api.admin.mailboxes[":id"]["forward-address"].rotate.$post({
        param: { id: mailbox.id },
      }),
    ),
    onSuccess: async () => {
      toast.success("New forward address generated");
      await client.invalidateQueries({ queryKey: ["admin-state"] });
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <div className={adminPanelClass}>
      <AdminPanelHeader
        Icon={Forward}
        title="Forward address"
        description={`Forward external mail for ${mailbox.address} to this address`}
      />
      <AdminPanelBody>
        <CopyableValueRow label="Address" value={mailbox.forwardAddress} />
        {mailbox.forwardAddress ? null : (
          <p className="pb-2 text-xs text-muted-foreground">
            Set a forwarding domain under Mailboxes first.
          </p>
        )}
        <div className="flex items-start justify-between gap-4 pt-2">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Keep it private. Generating a new address stops the old one from
            delivering; update the forwarding rule afterwards.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={rotate.isPending || !mailbox.forwardAddress}
            onClick={() => rotate.mutate()}
          >
            {rotate.isPending ? <LoaderCircle className="animate-spin" /> : <RefreshCw />}
            Regenerate
          </Button>
        </div>
      </AdminPanelBody>
    </div>
  );
}
