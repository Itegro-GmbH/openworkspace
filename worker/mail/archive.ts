import { and, eq, inArray, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { mailArchiveEntries } from "../db/schema";

export type ArchiveDirection = "incoming" | "outgoing";

const MAX_ERROR_LENGTH = 500;

export function archiveObjectKey(
  direction: ArchiveDirection,
  id: string,
  at: Date,
) {
  const year = at.getUTCFullYear();
  const month = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `${year}/${month}/${direction}/${id}.eml`;
}

export function archiveErrorMessage(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, MAX_ERROR_LENGTH);
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Registers a mail for archiving. Idempotent; never overwrites existing state. */
export async function recordArchiveEntry(
  binding: D1Database,
  input: {
    id: string;
    mailboxId: string;
    direction: ArchiveDirection;
    sourceKey: string | null;
    createdAt?: Date;
  },
) {
  const createdAt = input.createdAt ?? new Date();
  await createDb(binding)
    .insert(mailArchiveEntries)
    .values({
      id: input.id,
      mailboxId: input.mailboxId,
      direction: input.direction,
      sourceKey: input.sourceKey,
      archiveKey: archiveObjectKey(input.direction, input.id, createdAt),
      createdAt,
      updatedAt: createdAt,
    })
    .onConflictDoNothing();
}

export async function markArchiveFailed(
  binding: D1Database,
  id: string,
  error: unknown,
) {
  await createDb(binding)
    .update(mailArchiveEntries)
    .set({
      status: "failed",
      attempts: sql`${mailArchiveEntries.attempts} + 1`,
      lastError: archiveErrorMessage(error),
      updatedAt: new Date(),
    })
    .where(and(
      eq(mailArchiveEntries.id, id),
      inArray(mailArchiveEntries.status, ["pending", "failed"]),
    ));
}

/**
 * Writes the bytes to the locked archive bucket and marks the entry archived.
 * Throws on failure; callers decide whether that blocks anything.
 */
export async function writeToArchive(
  env: Env,
  id: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  const db = createDb(env.DB);
  const [entry] = await db
    .select()
    .from(mailArchiveEntries)
    .where(eq(mailArchiveEntries.id, id))
    .limit(1);
  if (!entry) throw new Error(`Archive entry ${id} is not registered`);
  if (entry.status === "archived") return entry;
  const key = entry.archiveKey
    ?? archiveObjectKey(entry.direction, entry.id, entry.createdAt);
  const sha256 = await sha256Hex(bytes);
  const written = await env.MAIL_ARCHIVE.put(key, bytes, {
    httpMetadata: { contentType: "message/rfc822" },
    customMetadata: {
      sha256,
      entryId: entry.id,
      mailboxId: entry.mailboxId,
      direction: entry.direction,
    },
    onlyIf: { etagDoesNotMatch: "*" },
  });
  if (!written) {
    // Already present, e.g. a previous attempt stored it before the status
    // update failed. Accept it only if the content is identical.
    const existing = await env.MAIL_ARCHIVE.head(key);
    if (existing?.customMetadata?.sha256 !== sha256) {
      throw new Error(`Archive object ${key} exists with different content`);
    }
  }
  const now = new Date();
  await db
    .update(mailArchiveEntries)
    .set({
      status: "archived",
      archiveKey: key,
      sha256,
      sizeBytes: bytes.byteLength,
      lastError: null,
      archivedAt: now,
      updatedAt: now,
    })
    .where(eq(mailArchiveEntries.id, id));
  return entry;
}

/**
 * Fail-open archiving: any error is recorded for the dashboard and retried by
 * the maintenance job, but never propagates into mail handling.
 */
export async function archiveWithoutBlocking(
  env: Env,
  id: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  try {
    await writeToArchive(env, id, bytes);
  } catch (error) {
    console.error("Mail archive write failed", id, error);
    try {
      await markArchiveFailed(env.DB, id, error);
    } catch (statusError) {
      console.error("Could not record archive failure", id, statusError);
    }
  }
}

/** Raw copies that are not archived yet must survive object cleanup. */
export async function unarchivedSourceKeys(
  binding: D1Database,
  keys: string[],
) {
  if (!keys.length) return new Set<string>();
  const rows = await createDb(binding)
    .select({ sourceKey: mailArchiveEntries.sourceKey })
    .from(mailArchiveEntries)
    .where(and(
      inArray(mailArchiveEntries.sourceKey, keys),
      inArray(mailArchiveEntries.status, ["pending", "failed"]),
    ));
  return new Set(rows.flatMap((row) => row.sourceKey ? [row.sourceKey] : []));
}
