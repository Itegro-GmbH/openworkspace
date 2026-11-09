import { eq } from "drizzle-orm";
import { createDb } from "../db/client";
import {
  domains,
  mailboxForwardAddresses,
  mailboxes,
  settings,
} from "../db/schema";
import { mailboxAddressSql } from "../db/mailboxes";
import { mailboxAddressParts, normalizeMailboxAddress } from "../lib/ids";

const FORWARD_DOMAIN_KEY = "forward_domain";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export async function getForwardDomain(binding: D1Database) {
  const [row] = await createDb(binding)
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, FORWARD_DOMAIN_KEY))
    .limit(1);
  return row?.value || null;
}

export async function setForwardDomain(binding: D1Database, domain: string | null) {
  const db = createDb(binding);
  if (!domain) {
    await db.delete(settings).where(eq(settings.key, FORWARD_DOMAIN_KEY));
    return null;
  }
  const now = new Date();
  await db
    .insert(settings)
    .values({ key: FORWARD_DOMAIN_KEY, value: domain, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: domain, updatedAt: now },
    });
  return domain;
}

/** `support-x4k2…`: readable prefix from the mailbox plus 80 random bits. */
export function generateForwardLocalPart(mailboxLocalPart: string) {
  const prefix = mailboxLocalPart
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let random = "";
  for (const byte of bytes) random += ALPHABET[byte % ALPHABET.length];
  return prefix ? `${prefix}-${random}` : random;
}

/** Creates the mailbox's forward address if missing, or replaces it when `rotate` is set. */
export async function ensureForwardLocalPart(
  binding: D1Database,
  mailboxId: string,
  mailboxLocalPart: string,
  rotate = false,
) {
  const db = createDb(binding);
  if (!rotate) {
    const [existing] = await db
      .select({ localPart: mailboxForwardAddresses.localPart })
      .from(mailboxForwardAddresses)
      .where(eq(mailboxForwardAddresses.mailboxId, mailboxId))
      .limit(1);
    if (existing) return existing.localPart;
  }
  const localPart = generateForwardLocalPart(mailboxLocalPart);
  await db
    .insert(mailboxForwardAddresses)
    .values({ mailboxId, localPart })
    .onConflictDoUpdate({
      target: mailboxForwardAddresses.mailboxId,
      set: { localPart, createdAt: new Date() },
    });
  return localPart;
}

/** Maps a recipient on the forward domain to the real mailbox address. */
export async function resolveForwardRecipient(binding: D1Database, recipient: string) {
  const forwardDomain = await getForwardDomain(binding);
  if (!forwardDomain) return null;
  const { localPart, domain } = mailboxAddressParts(normalizeMailboxAddress(recipient));
  if (domain !== forwardDomain) return null;
  const [row] = await createDb(binding)
    .select({ id: mailboxes.id, address: mailboxAddressSql })
    .from(mailboxForwardAddresses)
    .innerJoin(mailboxes, eq(mailboxes.id, mailboxForwardAddresses.mailboxId))
    .innerJoin(domains, eq(domains.id, mailboxes.domainId))
    .where(eq(mailboxForwardAddresses.localPart, localPart))
    .limit(1);
  return row ?? null;
}

/** Returns mailboxId -> forward local part, creating any that are missing. */
export async function ensureForwardLocalParts(
  binding: D1Database,
  boxes: { id: string; address: string }[],
) {
  const existing = await createDb(binding)
    .select({
      mailboxId: mailboxForwardAddresses.mailboxId,
      localPart: mailboxForwardAddresses.localPart,
    })
    .from(mailboxForwardAddresses);
  const result = new Map(existing.map((row) => [row.mailboxId, row.localPart]));
  for (const box of boxes) {
    if (result.has(box.id)) continue;
    result.set(
      box.id,
      await ensureForwardLocalPart(binding, box.id, box.address.split("@")[0] ?? ""),
    );
  }
  return result;
}
