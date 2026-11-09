// Idempotent setup of the mail archive bucket. Runs before `wrangler deploy`:
// creates the EU bucket if missing and adds the 7 year retention lock rule.
// Safe to run on every deploy. See docs/mail-archive.md.
import { spawnSync } from "node:child_process";

const bucket = process.env.MAIL_ARCHIVE_BUCKET ?? "itegro-mail-archive";
const ruleName = "mail-retention";
const retentionDays = process.env.MAIL_ARCHIVE_RETENTION_DAYS ?? "2555";

function wrangler(args: string[]) {
  const result = spawnSync("bunx", ["wrangler", ...args], { encoding: "utf8" });
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

const list = wrangler(["r2", "bucket", "list", "--jurisdiction", "eu"]);
if (!list.ok) {
  console.error(list.out);
  throw new Error("Could not list R2 buckets");
}
if (!new RegExp(`^name:\\s+${bucket}\\s*$`, "m").test(list.out)) {
  const created = wrangler(["r2", "bucket", "create", bucket, "--jurisdiction", "eu"]);
  if (!created.ok) {
    console.error(created.out);
    throw new Error(`Could not create archive bucket ${bucket}`);
  }
  console.log(`Created archive bucket ${bucket} (eu)`);
}

const locks = wrangler(["r2", "bucket", "lock", "list", bucket, "--jurisdiction", "eu"]);
if (!locks.ok || !locks.out.includes(ruleName)) {
  const added = wrangler([
    "r2", "bucket", "lock", "add", bucket, ruleName, "",
    "--retention-days", retentionDays, "--jurisdiction", "eu", "--force",
  ]);
  if (!added.ok) {
    // Never block a deploy over the lock; the dashboard/docs show how to fix it.
    console.warn(`WARNING: could not add retention lock to ${bucket}:\n${added.out}`);
  } else {
    console.log(`Added ${retentionDays} day retention lock to ${bucket}`);
  }
}
