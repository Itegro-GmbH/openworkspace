import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Forward } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, responseJson } from "@/lib/api";
import {
  adminPanelClass,
  AdminPanelBody,
  AdminPanelFooter,
  AdminPanelHeader,
} from "./admin-panel";

export function ForwardDomainSettings({
  forwardDomain,
}: {
  forwardDomain: string | null;
}) {
  const client = useQueryClient();
  const [value, setValue] = useState(forwardDomain ?? "");
  const update = useMutation({
    mutationFn: async (domain: string | null) => responseJson(
      await api.api.admin["forward-domain"].$put({ json: { domain } }),
    ),
    onSuccess: async (result) => {
      toast.success(result.forwardDomain ? "Forward domain saved" : "Forward domain removed");
      await client.invalidateQueries({ queryKey: ["admin-state"] });
    },
    onError: (error) => toast.error(error.message),
  });
  function submit(event: FormEvent) {
    event.preventDefault();
    update.mutate(value.trim() || null);
  }
  return (
    <form className={adminPanelClass} onSubmit={submit}>
      <AdminPanelHeader
        Icon={Forward}
        title="Forwarding domain"
        description="Receive mail for domains hosted elsewhere via forwarding"
      />
      <AdminPanelBody className="space-y-3">
        <Input
          aria-label="Forwarding domain"
          placeholder="fwd.example.com"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <p className="text-xs leading-relaxed text-muted-foreground">
          A subdomain used only for inbound forwarded mail. Point its Cloudflare
          Email Routing catch-all to this Worker. Every mailbox then gets its own
          address on this domain; forward your external mailbox to it and mail
          shows up under the mailbox's real address.
        </p>
      </AdminPanelBody>
      <AdminPanelFooter>
        <Button
          type="submit"
          disabled={update.isPending || value.trim() === (forwardDomain ?? "")}
        >
          {update.isPending ? <LoaderCircle className="animate-spin" /> : null}
          Save
        </Button>
      </AdminPanelFooter>
    </form>
  );
}
