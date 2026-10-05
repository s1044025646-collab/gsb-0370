#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Store } from "../db/store";
import { AppError } from "../core/errors";
import { LedgerService } from "../core/service";
import { reportToDTO } from "../core/serialize";
import { renderReport, renderSell } from "./render";
import { buildDemoInput } from "./demo";

const DEFAULT_DB = "data/fifo.db";

interface ParsedArgs {
  command: string;
  positional: string[];
  options: Map<string, string>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.set(key, next);
        i++;
      } else {
        options.set(key, "true");
      }
    } else {
      positional.push(token);
    }
  }
  return { command: command ?? "help", positional, options };
}

function loadJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8"));
}

function getDbPath(options: Map<string, string>): string {
  return options.get("db") ?? process.env.FIFO_DB ?? DEFAULT_DB;
}

function printJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function help(): void {
  process.stdout.write(
    [
      "fifo-lots — 单币种证券 FIFO 成本批次核算（整数分，TypeScript + Node.js + SQLite）",
      "",
      "用法：",
      "  fifo-lots init <ledgerId> [--note <备注>] [--db <数据库路径>]",
      "  fifo-lots import <ledgerId> --file <transactions.json>",
      "  fifo-lots append <ledgerId> --file <transactions.json>",
      "  fifo-lots report <ledgerId> [--version <n>] [--json] [--out <报告文件>]",
      "  fifo-lots lots <ledgerId> [--security <编号>] [--version <n>]",
      "  fifo-lots sell <ledgerId> <卖出seq或txnId> [--version <n>]",
      "  fifo-lots correct <ledgerId> --file <transactions.json> [--base-version <n>] [--note <备注>]",
      "  fifo-lots versions <ledgerId>",
      "  fifo-lots list",
      "  fifo-lots demo  （内存演示：3001 分三笔卖出 1000/1000/1001、跨批次卖出、超卖拒绝）",
      "",
      "交易 JSON 为数组，元素：{seq,txnId,securityId,side,qty,price,fee}",
      "金额单位为分；price/fee 允许为 0；qty 为正整数；seq 为用户给定序号，不按时间排序。",
      "默认数据库：data/fifo.db（项目内），可用 --db 或环境变量 FIFO_DB 覆盖。",
      "",
    ].join("\n")
  );
}

function main(): void {
  // 输出被下游管道提前关闭（如 | Select-Object -First）时优雅退出。
  process.stdout.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "demo") {
    runDemo();
    return;
  }
  if (args.command === "help" || args.command === "--help" || args.command === "-h") {
    help();
    return;
  }

  const store = new Store(getDbPath(args.options));
  const service = new LedgerService(store);
  try {
    const [ledgerId] = args.positional;
    switch (args.command) {
      case "init": {
        if (!ledgerId) throw new AppError("VALIDATION_ERROR", "缺少 ledgerId");
        const meta = service.createLedger(ledgerId, args.options.get("note") ?? "");
        printJson({ ok: true, ...meta });
        break;
      }
      case "import": {
        if (!ledgerId) throw new AppError("VALIDATION_ERROR", "缺少 ledgerId");
        const file = requireOption(args, "file");
        const { version, report } = service.importInto(ledgerId, loadJsonFile(file));
        process.stdout.write(`已导入 ${report.buys.length + report.sells.length} 笔交易 -> ${ledgerId} v${version}\n`);
        process.stdout.write(renderReport(report) + "\n");
        break;
      }
      case "append": {
        if (!ledgerId) throw new AppError("VALIDATION_ERROR", "缺少 ledgerId");
        const file = requireOption(args, "file");
        const result = service.append(ledgerId, loadJsonFile(file));
        process.stdout.write(
          `追加完成：新写入 ${result.applied} 笔，幂等跳过 ${result.skipped} 笔（${ledgerId} v${result.version}）\n`
        );
        process.stdout.write(renderReport(result.report) + "\n");
        break;
      }
      case "report": {
        if (!ledgerId) throw new AppError("VALIDATION_ERROR", "缺少 ledgerId");
        const version = optionalVersion(args);
        const result = service.report(ledgerId, version);
        if (args.options.has("json")) {
          const text = JSON.stringify({ id: ledgerId, version: result.version, report: reportToDTO(result.report) }, null, 2);
          emit(text, args.options.get("out"));
        } else {
          process.stdout.write(`账本 ${ledgerId} v${result.version}\n`);
          process.stdout.write(renderReport(result.report) + "\n");
        }
        break;
      }
      case "lots": {
        if (!ledgerId) throw new AppError("VALIDATION_ERROR", "缺少 ledgerId");
        const result = service.lots(ledgerId, args.options.get("security"), optionalVersion(args));
        printJson({ id: ledgerId, version: result.version, lots: reportToDTO(service.report(ledgerId, result.version).report).lots });
        break;
      }
      case "sell": {
        if (!ledgerId) throw new AppError("VALIDATION_ERROR", "缺少 ledgerId");
        const key = args.positional[1];
        if (!key) throw new AppError("VALIDATION_ERROR", "缺少卖出 seq 或 txnId");
        const result = service.sell(ledgerId, key, optionalVersion(args));
        process.stdout.write(`账本 ${ledgerId} v${result.version}\n`);
        process.stdout.write(renderSell(result.sell) + "\n");
        break;
      }
      case "correct": {
        if (!ledgerId) throw new AppError("VALIDATION_ERROR", "缺少 ledgerId");
        const file = requireOption(args, "file");
        const baseVersion = args.options.has("base-version")
          ? Number(args.options.get("base-version"))
          : undefined;
        const result = service.correct(ledgerId, loadJsonFile(file), {
          baseVersion,
          note: args.options.get("note") ?? "",
        });
        process.stdout.write(`已创建更正版本 ${ledgerId} v${result.version}（旧版本保留）\n`);
        process.stdout.write(renderReport(result.report) + "\n");
        break;
      }
      case "versions": {
        if (!ledgerId) throw new AppError("VALIDATION_ERROR", "缺少 ledgerId");
        printJson(service.versions(ledgerId));
        break;
      }
      case "list": {
        printJson(service.listLedgers());
        break;
      }
      default:
        help();
        process.exitCode = 1;
    }
  } catch (e) {
    fail(e);
  } finally {
    store.close();
  }
}

function requireOption(args: ParsedArgs, key: string): string {
  const value = args.options.get(key);
  if (!value) throw new AppError("VALIDATION_ERROR", `缺少必需选项 --${key}`);
  return value;
}

function optionalVersion(args: ParsedArgs): number | undefined {
  if (!args.options.has("version")) return undefined;
  const n = Number(args.options.get("version"));
  if (!Number.isSafeInteger(n) || n < 1) throw new AppError("VALIDATION_ERROR", "--version 必须是正整数");
  return n;
}

function emit(text: string, outPath?: string): void {
  if (outPath) {
    writeFileSync(resolve(process.cwd(), outPath), text + "\n", "utf8");
    process.stdout.write(`报告已写入 ${outPath}\n`);
  } else {
    process.stdout.write(text + "\n");
  }
}

function runDemo(): void {
  const demo = buildDemoInput();
  process.stdout.write("=== 演示一：三股总成本 3001 分，分三次各卖一股（应为 1000 / 1000 / 1001）===\n");
  process.stdout.write(renderReport(demo.stagedReport) + "\n\n");
  process.stdout.write("=== 完整账本（含跨批次卖出）===\n");
  process.stdout.write(renderReport(demo.fullReport) + "\n\n");
  process.stdout.write("=== 超卖拒绝（整笔不生效，返回 OVERSOLD 错误码）===\n");
  process.stdout.write(demo.oversellMessage + "\n");
}

function fail(e: unknown): never {
  if (e instanceof AppError) {
    process.stderr.write(`错误 [${e.code}] ${e.message}\n`);
    if (e.details !== undefined) process.stderr.write(JSON.stringify(e.details, null, 2) + "\n");
  } else {
    process.stderr.write(`错误 ${String((e as Error).message ?? e)}\n`);
  }
  process.exit(1);
}

main();
