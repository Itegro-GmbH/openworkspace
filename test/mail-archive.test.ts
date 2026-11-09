import { env } from "cloudflare:workers";
import PostalMime from "postal-mime";
import { describe, expect, it } from "vitest";
import {
  archiveObjectKey,
  archiveWithoutBlocking,
  markArchiveFailed,
  recordArchiveEntry,
  unarchivedSourceKeys,
  writeToArchive,
} from "../worker/mail/archive";
import { archiveStatus, retryArchiveEntries } from "../worker/mail/archive-maintenance";
import { buildOutgoingEml } from "../worker/mail/outgoing-eml";

const encoder = new TextEncoder();

describe("outgoing archive copy", () => {
  it("round-trips recipients, threading, unicode and attachments", async () => {
    const eml = buildOutgoingEml({
      messageId: "abc@example.test",
      sentAt: new Date("2026-11-09T12:00:00Z"),
      from: { name: "Lüca Schäckmann", email: "luca@webspired.de" },
      to: [{ name: "Kunde", email: "kunde@example.test" }],
      cc: ["cc@example.test"],
      bcc: ["hidden@example.test"],
      subject: "Angebot für Größe ß",
      text: "Hallo Welt – ä ö ü",
      html: "<p>Hallo <b>Welt</b></p>",
      headers: { "In-Reply-To": "<prev@example.test>", References: "<prev@example.test>" },
      attachments: [{
        disposition: "attachment",
        filename: "Übersicht.pdf",
        type: "application/pdf",
        content: encoder.encode("%PDF-fake").buffer,
      }],
    });
    const parsed = await PostalMime.parse(eml);
    expect(parsed.subject).toBe("Angebot für Größe ß");
    expect(parsed.from?.address).toBe("luca@webspired.de");
    expect(parsed.to?.[0]?.address).toBe("kunde@example.test");
    expect(parsed.cc?.[0]?.address).toBe("cc@example.test");
    expect(parsed.messageId).toBe("<abc@example.test>");
    expect(parsed.inReplyTo).toBe("<prev@example.test>");
    expect(parsed.text?.trim()).toBe("Hallo Welt – ä ö ü");
    expect(parsed.html).toContain("<b>Welt</b>");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("Übersicht.pdf");
    expect(new TextDecoder().decode(parsed.attachments[0]!.content as ArrayBuffer)).toBe("%PDF-fake");
  });

  it("builds plain text only messages", async () => {
    const eml = buildOutgoingEml({
      messageId: null,
      sentAt: new Date(),
      from: "a@example.test",
      to: "b@example.test",
      subject: "Hi",
      text: "Only text",
    });
    const parsed = await PostalMime.parse(eml);
    expect(parsed.text?.trim()).toBe("Only text");
    expect(parsed.html).toBeUndefined();
  });
});

describe("archive journal", () => {
  const raw = encoder.encode("From: a@example.test\r\nSubject: x\r\n\r\nbody");

  it("keys by year, month and direction", () => {
    expect(archiveObjectKey("incoming", "id1", new Date("2026-01-31T23:00:00Z")))
      .toBe("2026/01/incoming/id1.eml");
  });

  it("archives once and is idempotent", async () => {
    await recordArchiveEntry(env.DB, {
      id: "arch-ok", mailboxId: "mbx_x", direction: "incoming", sourceKey: null,
    });
    await writeToArchive(env, "arch-ok", raw);
    await writeToArchive(env, "arch-ok", raw);
    const row = await env.DB.prepare("select status, archive_key, sha256 from mail_archive_entries where id = ?")
      .bind("arch-ok").first<{ status: string; archive_key: string; sha256: string }>();
    expect(row?.status).toBe("archived");
    const stored = await env.MAIL_ARCHIVE.get(row!.archive_key);
    expect(await stored?.text()).toContain("Subject: x");
    expect(stored?.customMetadata?.sha256).toBe(row!.sha256);
  });

  it("accepts an identical existing object but rejects differing content", async () => {
    await recordArchiveEntry(env.DB, {
      id: "arch-dup", mailboxId: "mbx_x", direction: "incoming", sourceKey: null,
    });
    await writeToArchive(env, "arch-dup", raw);
    await env.DB.prepare("update mail_archive_entries set status = 'pending' where id = ?").bind("arch-dup").run();
    await writeToArchive(env, "arch-dup", raw);
    await env.DB.prepare("update mail_archive_entries set status = 'pending' where id = ?").bind("arch-dup").run();
    await expect(writeToArchive(env, "arch-dup", encoder.encode("different"))).rejects.toThrow();
  });

  it("does not throw when archiving fails and records the failure", async () => {
    // Unregistered entry: the write fails, the wrapper must swallow it.
    await archiveWithoutBlocking(env, "arch-unknown", raw);
    await recordArchiveEntry(env.DB, {
      id: "arch-fail", mailboxId: "mbx_x", direction: "incoming", sourceKey: "mailboxes/mbx_x/raw/arch-fail.eml",
    });
    await markArchiveFailed(env.DB, "arch-fail", new Error("bucket unavailable"));
    const status = await archiveStatus(env);
    expect(status.failed).toBeGreaterThanOrEqual(1);
    expect(status.open.some((item) => item.id === "arch-fail" && item.lastError === "bucket unavailable"))
      .toBe(true);
  });

  it("retries failed entries from the stored source copy", async () => {
    const key = "mailboxes/mbx_x/raw/arch-retry.eml";
    await env.MAIL_STORAGE.put(key, raw);
    await recordArchiveEntry(env.DB, {
      id: "arch-retry", mailboxId: "mbx_x", direction: "incoming", sourceKey: key,
    });
    await markArchiveFailed(env.DB, "arch-retry", new Error("temporary"));
    expect((await unarchivedSourceKeys(env.DB, [key])).has(key)).toBe(true);
    const result = await retryArchiveEntries(env, { force: true });
    expect(result.archived).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare("select status from mail_archive_entries where id = ?")
      .bind("arch-retry").first<{ status: string }>();
    expect(row?.status).toBe("archived");
    expect((await unarchivedSourceKeys(env.DB, [key])).has(key)).toBe(false);
  });

  it("keeps entries failing when the source copy is gone", async () => {
    await recordArchiveEntry(env.DB, {
      id: "arch-missing", mailboxId: "mbx_x", direction: "incoming", sourceKey: "mailboxes/mbx_x/raw/nope.eml",
    });
    await retryArchiveEntries(env, { force: true });
    const row = await env.DB.prepare("select status, last_error from mail_archive_entries where id = ?")
      .bind("arch-missing").first<{ status: string; last_error: string }>();
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toContain("missing");
  });
});
