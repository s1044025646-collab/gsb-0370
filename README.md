# 证券 FIFO 成本批次与部分卖出盈亏核算（后端）

单币种、匿名证券编号、只支持买入/卖出的 FIFO（先进先出）成本批次核算服务。
技术栈：**TypeScript + Node.js + SQLite**，只提供 **HTTP API 与 CLI**，无前端。
所有金额以**整数「分」**保存与计算（BigInt），不接交易所、不获取行情、不下单，
不处理税费、融资、做空、分红、拆股、外汇。

- 零第三方运行时依赖：SQLite 直接使用 Node.js 内置模块 `node:sqlite`（Node 22+ 实验内置，本项目在 Node 25 验证），无需安装 Python/Visual Studio 编译原生模块，不需要 Docker、WSL 或任何在线服务。
- 数据默认保存在**项目内 `data/fifo.db`**。

## 核算规则（固定口径，非税务口径）

1. 每次买入形成一个独立批次，批次总成本 = `数量 × 单价 + 买入手续费`（分）。不同证券的批次互不混用；同价重复买入**不合并**原始来源。
2. 卖出按「最早尚有库存」的买入批次依次扣减。卖出数量超过该证券可用持仓时，**整笔拒绝**（错误码 `OVERSOLD`），不会先部分扣减再报错。
3. 卖出总收入 = `数量 × 单价`；卖出净收入 = `总收入 − 本笔卖出手续费`。卖出手续费对整笔交易**只扣一次**，不按命中批次重复扣。
4. 已实现盈亏 = `卖出净收入 − 所消耗批次的分摊成本之和`。
5. 从批次部分取出 `q` 股时的成本分摊：
   - 部分取出：`分摊成本 = floor(该批次当前剩余成本 × q ÷ 该批次当前剩余数量)`；
   - 整批取完（`q` 等于当前剩余数量）：带走**全部**剩余成本。
   即向下取整产生的「余分」留在批次上，由该批次**最后一次取出**自动取得。
6. 每笔卖出返回命中的每个买入批次：买入编号、消耗数量、分摊前/后数量与成本、本命中对盈亏的贡献；所有命中的消耗数量之和严格等于卖出数量。
7. 守恒恒等式（按每个证券独立成立）：`最初买入总成本 = 已结转成本 + 剩余成本`；全部清空后剩余成本必须为 0，不留孤立成本。
8. 报告金额同时给出**精确分**（`fen` 字符串，供机器消费与复算）和**格式化元**（`yuan`，仅供展示，禁止再用于计算）。

### 为什么余分分摊会随分笔方式变化

整数除法向下取整意味着余分的归属取决于卖出的切分方式。
例如买入 10 股、总成本 1003 分：

- 一次性卖 10 股：带走全部 1003 分；
- 分 10 次各卖 1 股：前 7 笔各 100 分，后 3 笔各 101 分（余分被挤到最后几笔）；
- 先卖 3 股再卖 7 股：`floor(1003×3/10)=300` 与 703，又是另一种切分。

这是「按剩余成本比例、整数向下取整、整批取清」这一固定规则的必然结果，
不代表任何司法辖区的税务成本口径。

## 输入规则与上限

交易 JSON 为对象数组，元素字段：

| 字段 | 类型 | 规则 |
| --- | --- | --- |
| `seq` | 正整数 | 1 ~ 2,147,483,647，用户给定的明确序号；**不按系统时间排序**，账本内不得重复 |
| `txnId` | 字符串 | 1~64 位 `A-Z a-z 0-9 _ -`，交易编号 |
| `securityId` | 字符串 | 同上，匿名证券编号 |
| `side` | 字符串 | 仅 `BUY` 或 `SELL` |
| `qty` | 正整数 | 1 ~ 1,000,000 股 |
| `price` | 非负整数（分/股） | 0 ~ 1,000,000,000。**允许零单价**（批次成本仅含手续费），禁止负数 |
| `fee` | 非负整数（分） | 0 ~ 1,000,000,000。**允许零手续费**，禁止负数 |

- `txnId` 重复：内容完全相同视为**幂等**（跳过）；内容不同返回 `TXN_DUPLICATE_CONFLICT`。
- `seq` 重复：同次提交序号重复返回 `SEQ_CONFLICT`；追加时序号被占用也拒绝（`SEQ_CONFLICT`）。
- 数量×单价最大约 1×10¹⁵ 分，使用 BigInt 精确表示，无浮点误差与 64 位溢出问题。
- HTTP 请求体上限 5 MB。

### 错误码

| 错误码 | 含义 | HTTP 状态 |
| --- | --- | --- |
| `VALIDATION_ERROR` | 字段/结构不合法、账本状态不符 | 400 |
| `SEQ_CONFLICT` | 序号冲突 | 400 |
| `TXN_DUPLICATE_CONFLICT` | 交易编号重复但内容不同 | 400 |
| `OVERSOLD` | 卖出数量超过可用持仓（整笔拒绝） | 400 |
| `INVALID_BATCH` | 重算守恒/分摊内部校验失败 | 400 |
| `NOT_FOUND` | 账本、版本或卖出不存在 | 404 |
| `VERSION_ARCHIVED` | 旧版本已归档只读 | 409 |
| `STORAGE_ERROR` | SQLite 写入等存储故障 | 500 |

## 环境要求与安装

- Windows 本地；Node.js **22.5+**（内置 `node:sqlite`），在本机 **v25.5.0** 实测通过。

```powershell
npm install
npm run build
```

## 复现命令

```powershell
# 1) 构建
npm run build

# 2) 全部测试（16 个：引擎手算、守恒、回滚、幂等/冲突、历史更正、HTTP 全链路）
npm test

# 3) 内存演示（3001 分三笔 1000/1000/1001、跨批次卖出、超卖拒绝），不落盘
npm run demo

# 4) 启动 HTTP API；默认自选空闲端口，启动时打印实际 URL
npm start
# 指定端口/数据库：
# $env:PORT="8080"; $env:FIFO_DB="data/fifo.db"; npm start
```

### CLI 端到端（SQLite 落盘）

```powershell
$cli = "node --no-warnings=ExperimentalWarning dist/cli/index.js"
& $cli.Split(" ") init DEMO --note "演示账本"
& $cli.Split(" ") import DEMO --file examples/sample-transactions.json
& $cli.Split(" ") report DEMO                      # 文本批次消耗表
& $cli.Split(" ") report DEMO --json --out data/report.json
& $cli.Split(" ") lots DEMO --security SEC-B
& $cli.Split(" ") sell DEMO 7                     # 单笔卖出解释（也可用 txnId）
& $cli.Split(" ") append DEMO --file examples/more-transactions.json
& $cli.Split(" ") correct DEMO --file examples/correction-v2.json --note "卖出改2股"
& $cli.Split(" ") versions DEMO                   # v1 保留并标记归档，v2 为新版本
& $cli.Split(" ") report DEMO --version 1         # 仍可查询旧版本报告
```

CLI 数据库默认 `data/fifo.db`，可用 `--db <路径>` 或环境变量 `FIFO_DB` 覆盖。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/ledgers` | 列出账本及最新版本 |
| POST | `/api/ledgers` | 新建账本，body `{ "id": "...", "note": "..." }` |
| POST | `/api/ledgers/:id/import` | 初始导入有序交易，body `{ "transactions": [...] }` |
| POST | `/api/ledgers/:id/append` | 追加交易（同编号同内容幂等） |
| GET | `/api/ledgers/:id/report?version=n` | 核算报告（批次、卖出明细、分证券汇总） |
| GET | `/api/ledgers/:id/lots?security=X&version=n` | 当前未清批次 |
| GET | `/api/ledgers/:id/sells/:seqOrTxnId?version=n` | 单笔卖出的批次命中解释 |
| POST | `/api/ledgers/:id/correct` | 历史更正：`{ "transactions": [...], "baseVersion": 1, "note": "..." }`，生成新版本从头重算，旧报告保留 |
| GET | `/api/ledgers/:id/versions` | 版本列表 |

金额字段形如 `{ "fen": "1001", "yuan": "10.01" }`。

PowerShell 调用示例：

```powershell
Invoke-RestMethod -Method Post http://127.0.0.1:<端口>/api/ledgers -ContentType 'application/json' `
  -Body '{"id":"L1"}'
Invoke-RestMethod -Method Post http://127.0.0.1:<端口>/api/ledgers/L1/import -ContentType 'application/json' `
  -InFile examples/sample-transactions.json
Invoke-RestMethod http://127.0.0.1:<端口>/api/ledgers/L1/report
```

## 原子性、版本与重启一致性

- 导入/追加/更正都遵循「**先在内存对完整交易序列重算，成功后再写 SQLite 事务**」：超卖或非法批次在写库前抛出；写入阶段出错则 `ROLLBACK`，有效账本不变（有测试覆盖）。
- 历史更正创建新的不可变版本（v1、v2…），旧版本数据与报告原样保留且仍可按 `version` 查询；被衍生的旧版本标记为归档只读。
- 核算结果不持久化缓存，每次查询从存储的输入交易**重新推导**，因此重启后得到完全相同的分摊过程与结果。

## 项目结构

```
src/
  core/      money.ts 整数分与格式化；validation.ts 输入规则；engine.ts FIFO 纯函数引擎；
             service.ts 账本/版本用例；serialize.ts 金额双表示 DTO；errors.ts 错误码
  db/        store.ts node:sqlite 存储与事务
  api/       server.ts HTTP API（默认空闲端口）
  cli/       index.ts / render.ts / demo.ts 命令行与批次消耗表
  test/      node:test 测试（引擎、服务回滚、HTTP 全链路）
examples/   示例交易 JSON
data/       SQLite 数据目录（运行时生成，已 gitignore）
```

## 明确的范围限制

- 只做后端 API/CLI；无 Web UI。
- 只处理买入与卖出；不做税费规则、融资融券、做空、分红、拆股、外汇换算。
- 单币种（金额仅为整数分，不区分币种字段）。
- 固定整数分摊口径，不声称符合任何税务监管要求。
- `node:sqlite` 在当前 Node 版本仍带实验性警告，已通过 `--no-warnings=ExperimentalWarning` 屏蔽；未来 Node 版本接口若变化需小幅适配。
