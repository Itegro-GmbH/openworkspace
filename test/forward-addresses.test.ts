import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import {
  ensureForwardLocalPart,
  generateForwardLocalPart,
  resolveForwardRecipient,
  setForwardDomain,
} from "../worker/mail/forward-addresses";

describe("generateForwardLocalPart", () => {
  it("keeps a sanitized readable prefix plus an unguessable suffix", () => {
    const a = generateForwardLocalPart("Schackmann.Luca");
    const b = generateForwardLocalPart("Schackmann.Luca");
    expect(a).toMatch(/^schackmann-luca-[a-z2-7]{16}$/);
    expect(a).not.toBe(b);
    expect(generateForwardLocalPart("***")).toMatch(/^[a-z2-7]{16}$/);
  });
});

describe("forward address resolution", () => {
  let mailboxId: string;
  let address: string;

  beforeAll(async () => {
    const bootstrap = await exports.default.fetch(
      new Request("http://example.test/api/auth/mock/bootstrap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Forward Admin", email: "forward-admin@example.test" }),
      }),
    );
    const cookie = bootstrap.headers.get("set-cookie")?.split(";", 1)[0]!;
    const list = await exports.default.fetch(
      new Request("http://example.test/api/mail/mailboxes", { headers: { cookie } }),
    );
    const body = await list.json() as { mailboxes: Array<{ id: string; address: string }> };
    mailboxId = body.mailboxes[0]!.id;
    address = body.mailboxes[0]!.address;
  });

  it("ignores everything while no forward domain is configured", async () => {
    await setForwardDomain(env.DB, null);
    expect(await resolveForwardRecipient(env.DB, "x@fwd.example.test")).toBeNull();
  });

  it("maps a forward-domain recipient to the real mailbox address", async () => {
    await setForwardDomain(env.DB, "fwd.example.test");
    const localPart = await ensureForwardLocalPart(env.DB, mailboxId, "inbox");
    const resolved = await resolveForwardRecipient(
      env.DB,
      `${localPart.toUpperCase()}@FWD.example.test`,
    );
    expect(resolved).toEqual({ id: mailboxId, address });
  });

  it("does not resolve other domains or unknown local parts", async () => {
    await setForwardDomain(env.DB, "fwd.example.test");
    const localPart = await ensureForwardLocalPart(env.DB, mailboxId, "inbox");
    expect(await resolveForwardRecipient(env.DB, `${localPart}@other.example.test`)).toBeNull();
    expect(await resolveForwardRecipient(env.DB, "nope@fwd.example.test")).toBeNull();
  });

  it("invalidates the old address when rotated", async () => {
    await setForwardDomain(env.DB, "fwd.example.test");
    const oldPart = await ensureForwardLocalPart(env.DB, mailboxId, "inbox");
    const newPart = await ensureForwardLocalPart(env.DB, mailboxId, "inbox", true);
    expect(newPart).not.toBe(oldPart);
    expect(await resolveForwardRecipient(env.DB, `${oldPart}@fwd.example.test`)).toBeNull();
    expect((await resolveForwardRecipient(env.DB, `${newPart}@fwd.example.test`))?.id).toBe(mailboxId);
  });
});
