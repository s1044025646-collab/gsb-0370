# FIFO 证券成本批次与部分卖出盈亏核算后端

单币种、只做**买入 / 卖出**的本地证券持仓 FIFO 成本核算服务。只提供 **API** 与 **CLI**，
不接交易所、不获取行情、不下单；不计算税费、融资、做空、分红、拆股、外汇。
全部金额为整数「分」，内部一律 `bigint`，**不使用浮点乘法生成成本**。

技术栈：TypeScript + Node.js（内置 `node:sqlite`，无需编译原生模块）+ SQLite。
不依赖 Docker / WSL / 付费服务 / 外部在线 API。

## 环境要求

- Windows + Node.js `>= 22.5`（开发与验证使用 Node `v25.5.0`，需带内置 `node:sqlite`）
- npm

## 安装与构建

```powershell
cd E:\GSB\0370\A
npm install
npm run build
```

## 快速演示

```powershell
# 内置演示：3001 分分三次卖出（1000/1000/1001）、跨批次卖出、超卖拒绝、历史更正
npm run demo

# 测试（16 个用例：手算小账本、守恒、冲突、回滚、重启复现、API 全流程）
npm test

# 启动 HTTP 服务（默认自动选择空闲端口；也可用 --port 指定）
npm start
node --no-warnings dist/server.js --port 8080 --db data/ledger.sqlite
```

所有命令都可加 `--db <路径>` 指定 SQLite 文件，默认 `data/ledger.sqlite`（项目内数据目录）。

## 输入规则（明确口径）

每笔交易字段：

| 字段 | 规则 |
| --- | --- |
| `tradeId` | 交易编号，1–64 字符非空字符串，同一账本内唯一 |
| `seq` | 明确序号，`>=1` 的安全整数，**互不相同**；不使用系统时间排序，一律按 `seq` 升序处理 |
| `security` | 匿名证券编号，1–64 字符非空字符串 |
| `side` | 仅 `BUY` 或 `SELL` |
| `qty` | 正整数，范围 `1 … 1,000,000,000` |
| `price` | 单价（分/股），**非负整数，允许 0（零单价）**，范围 `0 … 10^15` |
| `fee` | 本笔手续费（分），**非负整数，允许 0（零手续费）**，范围 `0 … 10^15` |

- 编号相同、内容也相同 → **幂等**（重复导入忽略）；编号相同、内容不同 → `TRADE_ID_CONFLICT` 拒绝。
- 序号被别的编号占用 → `SEQ_CONFLICT` 拒绝。
- 卖出数量超过该证券可用持仓 → `OVERSOLD`，**整笔拒绝**，不会先卖一部分再报错。
- 报告同时给出精确分（整数）和格式化金额（`元.分`）；**格式化金额仅展示，绝不回用于计算**。

## FIFO 成本与盈亏口径（固定规则，非税务口径）

- 每次买入形成一个批次，批次总成本 = `qty * price + fee`。重复买入即使同价也**不合并原始来源**。
- 卖出从该证券**最早尚有库存**的买入批次依次扣减；不同证券批次互不混用。
- 部分取出某批次 `q` 股时，带走成本：
  `floor(批次当前剩余成本 * q / 批次当前剩余数量)`；
  若整批取完，则带走该批次**全部剩余成本**。
  即向下取整产生的「余分」始终留在批次里，由**最后一部分**自动取得。
- 卖出毛收入 = `qty * price`；净收入 = 毛收入 `−` 本笔手续费。
  **手续费在该笔卖出总收入中只扣一次**，不按命中批次重复扣。
- 已实现盈亏 = 净收入 `−` 所消耗批次成本之和；按卖出累加，证券之间独立汇总。
- 守恒恒等式：`最初买入总成本 = 已结转成本 + 剩余成本`；清空全部持仓后剩余成本必须为 0，不留孤立成本。

### 余分为何随分笔方式变化

成本按「向下取整」在批次内分摊。设买入 3 股单价 1000、手续费 1，总成本 **3001 分**：

- 分三次各卖 1 股：第 1 笔 `floor(3001*1/3)=1000`，第 2 笔 `floor(2001*1/2)=1000`，第 3 笔整批取走 `1001`；
- 若一次性卖 3 股：整批取完，直接带走 `3001`。

两种分笔方式下单笔结转成本不同，但最终总成本相同（守恒恒等式成立）。这是本题固定口径，
**不代表任何地区的税务或会计规定**。

## CLI

```powershell
node --no-warnings dist/cli/index.js help

node --no-warnings dist/cli/index.js create --name 我的账本 --file examples/trades.json
node --no-warnings dist/cli/index.js list
node --no-warnings dist/cli/index.js report 1
node --no-warnings dist/cli/index.js lots 1
node --no-warnings dist/cli/index.js sales 1
node --no-warnings dist/cli/index.js sale 1 A-S1
node --no-warnings dist/cli/index.js append 1 --file more-trades.json --note 补录
node --no-warnings dist/cli/index.js versions 1
node --no-warnings dist/cli/index.js correct 1 --parent 1 --file fixed.json --note 更正
node --no-warnings dist/cli/index.js export 1 --out report.json
```

`sales` / `sale` 会打印**批次消耗表**：命中买入编号、消耗数量、分摊前成本、带走成本、
分摊后成本、本笔贡献盈亏，并自检数量之和等于卖出数量。

## HTTP API

错误返回 `{ "error": { "code", "message", "details?" } }`。错误码：

| HTTP | code | 含义 |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` / `BAD_REQUEST` | 字段或请求非法 |
| 404 | `LEDGER_NOT_FOUND` / `VERSION_NOT_FOUND` | 账本/版本不存在 |
| 409 | `SEQ_CONFLICT` | 序号冲突 |
| 409 | `TRADE_ID_CONFLICT` | 编号相同但内容不同 |
| 422 | `OVERSOLD` | 卖出超量，整笔拒绝 |
| 500 | `INTERNAL_ERROR` | 内部错误 |

路由：

| 方法与路径 | 说明 |
| --- | --- |
| `GET /health` | 健康检查 |
| `POST /ledgers` | 新建账本；body 可带 `name` 与 `trades` 一次性导入 |
| `GET /ledgers` | 账本列表 |
| `GET /ledgers/{id}?version=v` | 当前（或指定）版本完整报告 |
| `GET /ledgers/{id}/lots?security=s&version=v` | 未清空批次与汇总 |
| `GET /ledgers/{id}/sales/{tradeId}?version=v` | 单笔卖出命中批次解释 |
| `POST /ledgers/{id}/trades` | 追加交易（body：`{trades, note?}`，生成新版本） |
| `GET /ledgers/{id}/versions` | 历史版本列表 |
| `POST /ledgers/{id}/corrections` | 历史更正（`{parentVersion, trades, note?}`，从头重算为新版本） |

示例（PowerShell）：

```powershell
$body = '{"name":"demo","trades":[{"tradeId":"B1","seq":1,"security":"A","side":"BUY","qty":3,"price":1000,"fee":1}]}'
Invoke-RestMethod -Uri http://127.0.0.1:8080/ledgers -Method Post -ContentType 'application/json' -Body $body
```

## 版本化、原子性与可复现

- 每次追加 / 更正都生成**新版本**；更正基于父版本用新清单**从头重算**，原版本报告原样保留。
- 计算在写入前完成；SQLite 事务（`BEGIN IMMEDIATE` … `COMMIT`，WAL）原子保存输入与结果。
  非法字段、序号/编号冲突、超卖都不会产生新版本，有效账本保持不变。
- 结果以 JSON 与关系表双写；重启后重新打开同一数据库可得到完全相同的分摊过程。

## 复现命令汇总

```powershell
npm install
npm run build
npm test
npm run demo
npm start                                  # 默认空闲端口，看启动日志中的地址
node --no-warnings dist/cli/index.js --db data/manual.sqlite create --name m --file examples/trades.json
node --no-warnings dist/cli/index.js --db data/manual.sqlite report 1
node --no-warnings dist/cli/index.js --db data/manual.sqlite sale 1 A-S1
```

## 范围与限制

- 单币种、整数分；无税费、融资、做空、分红、拆股、外汇、行情、下单。
- 仅本地监听 `127.0.0.1`，无鉴权（本地单机用途）。
- 金额上限 `10^15` 分、单笔数量上限 `10^9`；内部 `bigint` 不受 53 位浮点精度限制。
- 使用实验性内置模块 `node:sqlite`（Node 22/24/25 提供），Node 版本需满足要求。
