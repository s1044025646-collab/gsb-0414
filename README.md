# objlink-backend — 自定义 JSON 目标文件离线链接后端

一个 Windows 本地可运行的**教学目标文件链接与跨模块符号重定位后端**，使用 TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖）。只提供 API 与 CLI，无前端。

## 受限格式说明（重要）

本项目是**教学/演示用途的受限链接器**，明确**不支持**：

- 真实 ELF / PE / COFF 目标文件
- 汇编语法解析、源码编译、镜像执行
- 动态链接、共享库、弱符号（所有符号均为强全局符号，名称全局唯一）
- 除 `ABS32` / `PCREL32` 之外的任何重定位类型

输入模块是 JSON，字节段已经是**机器字节的十六进制串**，链接器只做：段布局 → 符号解析 → 重定位写值。

### 模块 JSON 格式

```json
{
  "name": "甲",
  "text":  { "bytes": "00000000", "align": 4 },
  "data":  { "bytes": "aabb", "align": 16 },
  "symbols":     [ { "name": "foo", "section": "text", "offset": 0 } ],
  "relocations": [ { "section": "text", "offset": 0, "type": "PCREL32", "symbol": "foo", "addend": 0 } ]
}
```

- `bytes`：偶数长度十六进制串；`align`：1..4096 的二次幂
- `symbols[].offset`：允许等于段长（指向段末端），不得越界
- `relocations[]`：`offset` 为槽在段内的首字节偏移，槽占 4 字节且必须完整处于段内；同段槽不得重叠；`addend` 为显式加数（原槽字节**不**隐式充当加数）

### 布局与重定位规则

- 按输入模块顺序，**先排全部 text，再排全部 data**；每段起点按其对齐值向上取整，间隙补零
- 三种地址明确区分：段地址 = 基址 + 镜像内偏移；文件偏移 = 镜像内偏移
- 镜像大小上限 16 MiB；基址 + 镜像大小不得超过 2^32
- `ABS32`：写入 `S + A`，必须落在无符号 32 位范围
- `PCREL32`：写入 `S + A - (P + 4)`，必须落在有符号 32 位范围，按补码小端输出
- 所有值以**小端**写入，不做宿主端序或静默截断
- 先完成全部校验再产出镜像；任何失败只返回诊断，不输出半补丁镜像；输入模块原字节不被修改

## 错误码

| 代码 | 含义 |
|---|---|
| `E_BAD_INPUT` / `E_BAD_HEX` / `E_BAD_BASE` | 输入结构 / 十六进制 / 基址非法 |
| `E_BAD_ALIGN` | 对齐值不是 1..4096 的二次幂 |
| `E_BAD_ADDEND` | 加数非法 |
| `E_UNKNOWN_RELOC` | 未知重定位类型 |
| `E_DUP_SYMBOL` / `E_UNDEF_SYMBOL` | 符号重复定义 / 未定义引用 |
| `E_SYMBOL_RANGE` / `E_SLOT_RANGE` / `E_SLOT_OVERLAP` | 符号越界 / 槽越界 / 槽重叠 |
| `E_RELOC_RANGE` | 重定位结果超出 32 位范围 |
| `E_IMAGE_TOO_LARGE` / `E_ADDR_OVERFLOW` | 镜像超上限 / 地址空间溢出 |
| `E_NOT_FOUND` | 集合或任务不存在 |

## 构建 / 测试 / 启动 / 演示

```powershell
npm install
npm run build     # tsc 编译到 dist/
npm test          # 编译并运行全部测试 (node:test)
npm start         # 启动 HTTP API（默认自动选择空闲端口，--port 指定）
npm run demo      # 内置演示: 基址 4096, PCREL32=4, ABS32=4104, data 对齐零填充
```

数据保存在项目内 `data/` 目录（可用环境变量 `LINKER_DATA_DIR` 覆盖），SQLite 持久化模块原文、输入顺序、基址与结果摘要，重启后可读取相同镜像；重新导入模块即产生新集合版本，每次链接产生新任务版本。

## CLI

```powershell
node dist/src/cli.js import demo/modules.json          # 导入模块集合 -> setId
node dist/src/cli.js validate demo/modules.json --base 4096
node dist/src/cli.js link --set 1 --base 4096          # -> jobId
node dist/src/cli.js jobs                              # 列出链接任务
node dist/src/cli.js layout 1                          # 段布局
node dist/src/cli.js symbols 1                         # 符号表
node dist/src/cli.js patches 1                         # 补丁说明(含 S/A/P、修改前后字节)
node dist/src/cli.js export 1 out.bin --manifest out.json
node dist/src/cli.js compare 1 2                       # 比较两个链接版本
node dist/src/cli.js serve --port 8080
```

## HTTP API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/sets` | 导入模块集合 `{ modules: [...] }` |
| GET  | `/sets` | 列出集合 |
| POST | `/validate` | 仅校验并预览布局 `{ modules, base }` |
| POST | `/link` | 链接 `{ setId, base }` 或 `{ modules, base }` |
| GET  | `/jobs` / `/jobs/:id` | 任务列表 / 详情 |
| GET  | `/jobs/:id/layout` `/symbols` `/patches` `/manifest` | 布局 / 符号 / 补丁 / 完整清单 |
| GET  | `/jobs/:id/image` | 下载二进制镜像 |
| GET  | `/jobs/:id/compare?with=:id2` | 比较两个链接版本 |

## 演示场景验证

基址 4096：模块甲 text 占 8 字节（地址 4096），模块乙 text 从 4104 开始并定义 `foo`。

- 甲偏移 0 写 `PCREL32 -> foo`：`S+A-(P+4) = 4104-(4096+4) = 4`
- 甲偏移 4 写 `ABS32 -> foo`：`S+A = 4104`
- 乙 data 对齐 16，甲 data 之后出现零填充间隙
- 更换基址后相对位移不变、绝对地址随之改变（见测试「更换基址」）

## 已知限制

- `node:sqlite` 在 Node 25 仍打印 ExperimentalWarning，不影响功能
- 单进程服务，无并发写控制与鉴权，仅面向本地教学使用
- 地址模型为 32 位；段仅 text/data 两类
