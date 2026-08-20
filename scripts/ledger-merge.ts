/**
 * Rebuild the ledger and badge from the FRESHEST ledger on the branch plus
 * this run's record — the safety-audit workflow re-runs this after each
 * fetch inside its push-retry loop, so a concurrent audit's records are
 * never clobbered.
 *
 * Usage: bun scripts/ledger-merge.ts --record record.json --ledger prior.jsonl --out DIR
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { badgeFromLedger } from "../src/audit.js";
import type { AuditRecord } from "../src/audit.js";

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1] as string;
  console.error(`missing --${name}`);
  process.exit(2);
}

const record = JSON.parse(readFileSync(arg("record"), "utf8")) as AuditRecord;
const ledgerPath = arg("ledger");
const outDir = arg("out");

const prior: AuditRecord[] = existsSync(ledgerPath)
  ? readFileSync(ledgerPath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditRecord)
  : [];
// Idempotent under retries: the same head sha never lands twice.
const ledger = [...prior.filter((r) => r.headSha !== record.headSha), record];

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "ledger.jsonl"), ledger.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync(join(outDir, "badge.json"), JSON.stringify(badgeFromLedger(ledger), null, 2) + "\n");
console.log(`ledger: ${ledger.length} records`);
