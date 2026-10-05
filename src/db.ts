import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { LedgerMeta, LedgerReport, TradeInput, VersionMeta } from './types.js';
import { encodeBigJson, decodeBigJson } from './bigjson.js';
import { AppError } from './errors.js';

export interface VersionRow {
  meta: VersionMeta;
  trades: TradeInput[];
  report: LedgerReport;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS ledgers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS versions (
  ledger_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  trades_json TEXT NOT NULL,
  report_json TEXT NOT NULL,
  PRIMARY KEY (ledger_id, version),
  FOREIGN KEY (ledger_id) REFERENCES ledgers(id)
);

CREATE TABLE IF NOT EXISTS trades (
  ledger_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  trade_id TEXT NOT NULL,
  security TEXT NOT NULL,
  side TEXT NOT NULL,
  qty INTEGER NOT NULL,
  price INTEGER NOT NULL,
  fee INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (ledger_id, version, seq),
  UNIQUE (ledger_id, version, trade_id),
  FOREIGN KEY (ledger_id, version) REFERENCES versions(ledger_id, version)
);
`;

export class LedgerStore {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  createLedger(name: string): LedgerMeta {
    const info = this.db.prepare('INSERT INTO ledgers (name) VALUES (?)').run(name);
    const id = Number(info.lastInsertRowid);
    return this.getLedgerMeta(id)!;
  }

  listLedgers(): LedgerMeta[] {
    return this.db
      .prepare('SELECT id, name, current_version AS currentVersion, created_at AS createdAt FROM ledgers ORDER BY id')
      .all() as unknown as LedgerMeta[];
  }

  getLedgerMeta(id: number): LedgerMeta | null {
    const row = this.db
      .prepare('SELECT id, name, current_version AS currentVersion, created_at AS createdAt FROM ledgers WHERE id = ?')
      .get(id) as LedgerMeta | undefined;
    return row ?? null;
  }

  requireLedger(id: number): LedgerMeta {
    const meta = this.getLedgerMeta(id);
    if (!meta) throw new AppError('LEDGER_NOT_FOUND', `账本不存在：id=${id}`, { ledgerId: id });
    return meta;
  }

  listVersions(ledgerId: number): VersionMeta[] {
    this.requireLedger(ledgerId);
    return this.db
      .prepare(
        `SELECT ledger_id AS ledgerId, version, parent_version AS parentVersion, note,
                created_at AS createdAt,
                (SELECT COUNT(*) FROM trades t WHERE t.ledger_id = v.ledger_id AND t.version = v.version) AS tradeCount
         FROM versions v WHERE ledger_id = ? ORDER BY version`,
      )
      .all(ledgerId) as unknown as VersionMeta[];
  }

  getVersion(ledgerId: number, version: number): VersionRow {
    this.requireLedger(ledgerId);
    const vrow = this.db
      .prepare(
        `SELECT ledger_id AS ledgerId, version, parent_version AS parentVersion, note, created_at AS createdAt
         FROM versions WHERE ledger_id = ? AND version = ?`,
      )
      .get(ledgerId, version) as VersionMeta | undefined;
    if (!vrow) {
      throw new AppError('VERSION_NOT_FOUND', `版本不存在：账本 ${ledgerId} 版本 ${version}`, {
        ledgerId,
        version,
      });
    }
    const reportRow = this.db
      .prepare('SELECT trades_json AS tradesJson, report_json AS reportJson FROM versions WHERE ledger_id = ? AND version = ?')
      .get(ledgerId, version) as { tradesJson: string; reportJson: string };
    return {
      meta: { ...vrow, tradeCount: 0 },
      trades: decodeBigJson<TradeInput[]>(reportRow.tradesJson),
      report: decodeBigJson<LedgerReport>(reportRow.reportJson),
    };
  }

  getTrades(ledgerId: number, version: number): TradeInput[] {
    const rows = this.db
      .prepare(
        `SELECT payload_json AS payloadJson FROM trades
         WHERE ledger_id = ? AND version = ? ORDER BY seq`,
      )
      .all(ledgerId, version) as { payloadJson: string }[];
    return rows.map((r) => JSON.parse(r.payloadJson) as TradeInput);
  }

  /** 原子写入一个新版本：校验/重算在事务外先完成，事务内只做落库，失败整体回滚。 */
  saveVersion(args: {
    ledgerId: number;
    version: number;
    parentVersion: number | null;
    note: string | null;
    trades: TradeInput[];
    report: LedgerReport;
    setCurrent: boolean;
  }): VersionMeta {
    this.requireLedger(args.ledgerId);
    const existing = this.db
      .prepare('SELECT 1 FROM versions WHERE ledger_id = ? AND version = ?')
      .get(args.ledgerId, args.version);
    if (existing) {
      throw new AppError('BAD_REQUEST', `版本已存在：账本 ${args.ledgerId} 版本 ${args.version}`);
    }

    const insertVersion = this.db.prepare(
      `INSERT INTO versions (ledger_id, version, parent_version, note, trades_json, report_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertTrade = this.db.prepare(
      `INSERT INTO trades (ledger_id, version, seq, trade_id, security, side, qty, price, fee, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const updateCurrent = this.db.prepare('UPDATE ledgers SET current_version = ? WHERE id = ?');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      insertVersion.run(
        args.ledgerId,
        args.version,
        args.parentVersion,
        args.note,
        encodeBigJson(args.trades),
        encodeBigJson(args.report),
      );
      for (const t of args.trades) {
        insertTrade.run(
          args.ledgerId,
          args.version,
          t.seq,
          t.tradeId,
          t.security,
          t.side,
          t.qty,
          t.price,
          t.fee,
          JSON.stringify(t),
        );
      }
      if (args.setCurrent) updateCurrent.run(args.version, args.ledgerId);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return this.db
      .prepare(
        `SELECT ledger_id AS ledgerId, version, parent_version AS parentVersion, note, created_at AS createdAt
         FROM versions WHERE ledger_id = ? AND version = ?`,
      )
      .get(args.ledgerId, args.version) as unknown as VersionMeta;
  }
}
