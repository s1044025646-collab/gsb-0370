import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AppError } from "../core/errors";
import type { TxnInput } from "../core/types";

/**
 * SQLite 存储。BigInt 金额一律以 TEXT 存（精确分），数量/序号以 INTEGER 存。
 * 账本版本（version）不可变；历史更正创建新版本，旧版本原样保留。
 */

let dbCounter = 0;

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    const full = isAbsolute(dbPath) ? dbPath : resolve(process.cwd(), dbPath);
    mkdirSync(dirname(full), { recursive: true });
    this.db = new DatabaseSync(full);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledgers (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_version INTEGER,
        note TEXT NOT NULL DEFAULT '',
        created_at_text TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (id, version)
      );
      CREATE TABLE IF NOT EXISTS transactions (
        ledger_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        txn_id TEXT NOT NULL,
        security_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
        qty INTEGER NOT NULL,
        price INTEGER NOT NULL,
        fee INTEGER NOT NULL,
        PRIMARY KEY (ledger_id, version, seq),
        UNIQUE (ledger_id, version, txn_id)
      );
    `);
  }

  createLedger(id: string, note: string, parentVersion: number | null): number {
    const version = parentVersion === null ? 1 : parentVersion + 1;
    if (parentVersion !== null) {
      // 新版本一旦基于某历史版本创建，旧版本即归档只读。
      this.db
        .prepare("UPDATE ledgers SET archived = 1 WHERE id = ? AND version = ?")
        .run(id, parentVersion);
    }
    try {
      this.db
        .prepare(
          "INSERT INTO ledgers (id, version, parent_version, note, created_at_text, archived) VALUES (?, ?, ?, ?, ?, 0)"
        )
        .run(id, version, parentVersion, note, new Date().toISOString());
    } catch (e) {
      throw new AppError(
        "STORAGE_ERROR",
        `无法创建账本版本（${id} v${version} 可能已存在）`,
        String((e as Error).message)
      );
    }
    return version;
  }

  ledgerExists(id: string, version: number): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM ledgers WHERE id = ? AND version = ?")
      .get(id, version) as { x: number } | undefined;
    return !!row;
  }

  latestVersion(id: string): number | null {
    const row = this.db
      .prepare("SELECT MAX(version) AS v FROM ledgers WHERE id = ?")
      .get(id) as { v: number | null } | undefined;
    return row?.v ?? null;
  }

  listVersions(id: string): { version: number; parentVersion: number | null; note: string; archived: boolean }[] {
    const rows = this.db
      .prepare("SELECT version, parent_version AS parentVersion, note, archived FROM ledgers WHERE id = ? ORDER BY version")
      .all(id) as { version: number; parentVersion: number | null; note: string; archived: number }[];
    return rows.map((r) => ({ ...r, archived: r.archived === 1 }));
  }

  listLedgers(): { id: string; latestVersion: number }[] {
    const rows = this.db
      .prepare("SELECT id, MAX(version) AS latestVersion FROM ledgers GROUP BY id ORDER BY id")
      .all() as { id: string; latestVersion: number }[];
    return rows;
  }

  /** 在一个事务中写入输入并重算；任何错误都整体回滚，有效账本不受影响。 */
  replaceVersionTxns(id: string, version: number, txns: TxnInput[]): void {
    const insert = this.db.prepare(
      "INSERT INTO transactions (ledger_id, version, seq, txn_id, security_id, side, qty, price, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of txns) {
        insert.run(id, version, t.seq, t.txnId, t.securityId, t.side, t.qty, t.price, t.fee);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  appendTxns(id: string, version: number, txns: TxnInput[]): void {
    const insert = this.db.prepare(
      "INSERT INTO transactions (ledger_id, version, seq, txn_id, security_id, side, qty, price, fee) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const t of txns) {
        insert.run(id, version, t.seq, t.txnId, t.securityId, t.side, t.qty, t.price, t.fee);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw new AppError("STORAGE_ERROR", `写入失败并已回滚：${String((e as Error).message)}`);
    }
  }

  loadTxns(id: string, version: number): TxnInput[] {
    const rows = this.db
      .prepare(
        "SELECT seq, txn_id AS txnId, security_id AS securityId, side, qty, price, fee FROM transactions WHERE ledger_id = ? AND version = ? ORDER BY seq"
      )
      .all(id, version) as unknown as TxnInput[];
    return rows;
  }

  /** 生成进程内唯一临时账本 id（仅测试/演示使用）。 */
  static tempId(prefix = "tmp"): string {
    dbCounter += 1;
    return `${prefix}_${process.pid}_${dbCounter}`;
  }
}
