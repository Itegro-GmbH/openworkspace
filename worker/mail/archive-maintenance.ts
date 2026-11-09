import { and, desc, eq, inArray, lte, or, sql } from "drizzle-orm";
import { createDb } from "../db/client";
import { mailArchiveEntries, mailboxes, settings } from "../db/schema";
import { mailboxStub } from "../mailbox";
import {
  archiveErrorMessage,
  archiveObjectKey,
  markArchiveFailed,
  recordArchiveEntry,
  writeToArchive,
} from "./archive";

const RETRY_BASE_MS = 5 * 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const RECONCILE_PAGES_PER_RUN = 3;
const OUTGOING_RECONCILE_INTERVAL_MS = 24 * 60 * 60_000;
const SQL_CHUNK = 80;
const CURSOR_KEY = "archive_reconcile_cursor";
const OUTGOING_RECONCILED_KEY = "archive_outgoing_reconciled_at";
const RAW_KEY = /^mailboxes\/([^/]+)\/raw\/([^/]+)\.eml$/u;

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function readSetting(binding: D1Database, key: string) {
  const [row] = await createDb(binding)
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
    .limit(1);
  return row?.value ?? null;
}

async function writeSetting(binding: D1Database, key: string, value: string | null) {
  const db = createDb(binding);
  if (value === null) {
    await db.delete(settings).where(eq(settings.key, key));
    return;
  }
  const now = new Date();
  await db
    .insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: now } });
}

async function existingIds(binding: D1Database, ids: string[]) {
  const found = new Set<string>();
  for (const part of chunks(ids, SQL_CHUNK)) {
    const rows = await createDb(binding)
      .select({ id: mailArchiveEntries.id })
      .from(mailArchiveEntries)
      .where(inArray(mailArchiveEntries.id, part));
    for (const row of rows) found.add(row.id);
  }
  return found;
}

/** Finds stored raw inbound mails that were never registered for archiving. */
export async function reconcileIncoming(env: Env) {
  let cursor = (await readSetting(env.DB, CURSOR_KEY)) ?? undefined;
  let registered = 0;
  for (let page = 0; page < RECONCILE_PAGES_PER_RUN; page += 1) {
    const listing = await env.MAIL_STORAGE.list({
      prefix: "mailboxes/",
      cursor,
      limit: 1000,
    });
    const candidates = listing.objects.flatMap((object) => {
      const match = RAW_KEY.exec(object.key);
      return match
        ? [{ key: object.key, mailboxId: match[1]!, id: match[2]!, at: object.uploaded }]
        : [];
    });
    const known = await existingIds(env.DB, candidates.map((item) => item.id));
    for (const item of candidates) {
      if (known.has(item.id)) continue;
      await recordArchiveEntry(env.DB, {
        id: item.id,
        mailboxId: item.mailboxId,
        direction: "incoming",
        sourceKey: item.key,
        createdAt: item.at,
      });
      registered += 1;
    }
    if (!listing.truncated) {
      await writeSetting(env.DB, CURSOR_KEY, null);
      return registered;
    }
    cursor = listing.cursor;
    await writeSetting(env.DB, CURSOR_KEY, cursor ?? null);
  }
  return registered;
}

/** Registers submitted outgoing mails that are missing from the log (daily). */
export async function reconcileOutgoing(env: Env, force = false) {
  const last = Number(await readSetting(env.DB, OUTGOING_RECONCILED_KEY) ?? 0);
  if (!force && Date.now() - last < OUTGOING_RECONCILE_INTERVAL_MS) return 0;
  const boxes = await createDb(env.DB).select({ id: mailboxes.id }).from(mailboxes);
  let registered = 0;
  for (const box of boxes) {
    const submitted = await mailboxStub(env, box.id).listSubmittedOutgoing(500);
    const known = await existingIds(env.DB, submitted.map((item) => item.id));
    for (const item of submitted) {
      if (known.has(item.id)) continue;
      await recordArchiveEntry(env.DB, {
        id: item.id,
        mailboxId: box.id,
        direction: "outgoing",
        sourceKey: null,
        createdAt: new Date(item.at),
      });
      registered += 1;
    }
  }
  await writeSetting(env.DB, OUTGOING_RECONCILED_KEY, String(Date.now()));
  return registered;
}

async function archiveOne(env: Env, entry: typeof mailArchiveEntries.$inferSelect) {
  try {
    if (entry.direction === "incoming") {
      const object = entry.sourceKey ? await env.MAIL_STORAGE.get(entry.sourceKey) : null;
      if (!object) throw new Error("Source copy is missing in mail storage");
      await writeToArchive(env, entry.id, new Uint8Array(await object.arrayBuffer()));
    } else {
      const built = await mailboxStub(env, entry.mailboxId).buildOutgoingArchive(entry.id);
      if (!built) throw new Error("Outgoing message is not available for archiving");
      await writeToArchive(env, entry.id, new Uint8Array(built.eml));
    }
    return true;
  } catch (error) {
    await markArchiveFailed(env.DB, entry.id, error).catch(() => undefined);
    console.error("Mail archive retry failed", entry.id, archiveErrorMessage(error));
    return false;
  }
}

/** Retries pending and failed entries. `force` ignores the backoff window. */
export async function retryArchiveEntries(env: Env, options: { force?: boolean; limit?: number } = {}) {
  const limit = options.limit ?? 100;
  const db = createDb(env.DB);
  const open = await db
    .select()
    .from(mailArchiveEntries)
    .where(inArray(mailArchiveEntries.status, ["pending", "failed"]))
    .orderBy(mailArchiveEntries.createdAt)
    .limit(limit * 3);
  const now = Date.now();
  const due = open.filter((entry) => {
    if (options.force) return true;
    if (entry.attempts === 0) return now - entry.updatedAt.getTime() > 60_000;
    const wait = Math.min(RETRY_BASE_MS * 2 ** (entry.attempts - 1), RETRY_MAX_MS);
    return now - entry.updatedAt.getTime() >= wait;
  }).slice(0, limit);
  let archived = 0;
  let failed = 0;
  for (const entry of due) {
    if (await archiveOne(env, entry)) archived += 1;
    else failed += 1;
  }
  return { archived, failed, attempted: due.length };
}

export async function runArchiveMaintenance(env: Env, options: { force?: boolean } = {}) {
  const incoming = await reconcileIncoming(env).catch((error) => {
    console.error("Archive reconcile (incoming) failed", error);
    return 0;
  });
  const outgoing = await reconcileOutgoing(env, options.force).catch((error) => {
    console.error("Archive reconcile (outgoing) failed", error);
    return 0;
  });
  const retried = await retryArchiveEntries(env, options);
  return { registeredIncoming: incoming, registeredOutgoing: outgoing, ...retried };
}

export async function archiveStatus(env: Env) {
  const db = createDb(env.DB);
  const [counts, recent, oldestOpen] = await Promise.all([
    db
      .select({
        status: mailArchiveEntries.status,
        count: sql<number>`count(*)`,
      })
      .from(mailArchiveEntries)
      .groupBy(mailArchiveEntries.status),
    db
      .select({
        id: mailArchiveEntries.id,
        mailboxId: mailArchiveEntries.mailboxId,
        direction: mailArchiveEntries.direction,
        attempts: mailArchiveEntries.attempts,
        lastError: mailArchiveEntries.lastError,
        createdAt: mailArchiveEntries.createdAt,
        updatedAt: mailArchiveEntries.updatedAt,
      })
      .from(mailArchiveEntries)
      .where(and(
        or(eq(mailArchiveEntries.status, "failed"), eq(mailArchiveEntries.status, "pending")),
        lte(mailArchiveEntries.updatedAt, new Date()),
      ))
      .orderBy(desc(mailArchiveEntries.updatedAt))
      .limit(20),
    db
      .select({ createdAt: mailArchiveEntries.createdAt })
      .from(mailArchiveEntries)
      .where(inArray(mailArchiveEntries.status, ["pending", "failed"]))
      .orderBy(mailArchiveEntries.createdAt)
      .limit(1),
  ]);
  const byStatus = Object.fromEntries(counts.map((row) => [row.status, Number(row.count)]));
  return {
    configured: Boolean(env.MAIL_ARCHIVE),
    archived: byStatus.archived ?? 0,
    pending: byStatus.pending ?? 0,
    failed: byStatus.failed ?? 0,
    oldestOpenAt: oldestOpen[0]?.createdAt ?? null,
    open: recent,
  };
}

export { archiveObjectKey };
