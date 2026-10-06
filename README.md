# 自定义 JSON 目标文件链接器(后端)

Windows 本地运行的离线链接服务:TypeScript + Node.js + SQLite(`node:sqlite`,无原生依赖、无 Docker/WSL/外部服务)。只做 API 与 CLI,不解析汇编、不编译源码、不执行镜像,不支持 ELF/PE、动态链接、弱符号或共享库。

## 环境要求

- Node.js ≥ 22.5(使用内置 `node:sqlite`;开发环境为 Node 25)
- `npm install` 一次(仅安装 TypeScript 开发依赖)

## 命令

```powershell
npm install        # 安装开发依赖
npm run build      # 编译 TypeScript 到 dist/
npm test           # 构建并运行全部测试
npm run demo       # 运行题目演示场景(基址 4096)
npm start          # 启动 API(默认自动选择空闲端口)
node dist/api.js --port 8080   # 指定端口
```

CLI(`npm run cli -- <命令>` 或 `node dist/cli.js <命令>`):

```
node dist/cli.js import <modules.json>   导入模块集合(导入前完整校验)
node dist/cli.js sets                    列出模块集合
node dist/cli.js validate <setId> [--base N]
node dist/cli.js link <setId> --base N   链接并保存版本(相同集合+基址复用旧版本)
node dist/cli.js versions                列出版本
node dist/cli.js layout|symbols|patches <versionId>
node dist/cli.js export <versionId> <out.bin>   导出二进制镜像
node dist/cli.js compare <verA> <verB>   比较两个版本(字节差异、符号地址变化)
node dist/cli.js serve [--port N]        启动 API
```

数据保存在项目内 `data/linker.db`,重启后可读取相同镜像;修改模块内容会产生新集合与新版本。

## 模块格式(受限自定义格式)

```json
[
  {
    "name": "a",
    "text": { "align": 4, "bytes": "0000000000000000" },
    "data": { "align": 16, "bytes": "deadbeef" },
    "symbols": [{ "name": "foo", "section": "text", "offset": 0 }],
    "relocations": [
      { "section": "text", "offset": 0, "type": "PCREL32", "symbol": "foo", "addend": 0 }
    ]
  }
]
```

- `text`/`data` 可省略(视为空段,对齐 1);`bytes` 为十六进制字符串;`align` 为 1..4096 的二次幂。
- 符号偏移允许等于段长(指向段末端),不得越界;强符号名称全局唯一,重复定义报错。
- 重定位槽为 4 字节,必须完整处于段内,同段槽不得重叠;`addend` 省略为 0,必须是 int32。

## 链接规则

- 布局:按输入模块顺序先排全部 `text` 再排全部 `data`;每段起点按其对齐向上取整,间隙补零。
- 基址由用户指定(0..0xFFFFFFFF);段地址 = 基址 + 镜像内偏移;本格式为平坦镜像,文件偏移等于镜像内偏移。
- 镜像大小上限 16 MiB;基址 + 镜像大小不得超出 32 位地址范围。
- 重定位(均为 4 字节小端写入,原槽字节不参与计算):
  - `ABS32`:写入 `S + A`,必须在 0..0xFFFFFFFF(无符号 32 位)。
  - `PCREL32`:写入 `S + A - (P + 4)`,必须在 -2^31..2^31-1(有符号 32 位),按补码输出。
  - `S` = 目标符号最终地址,`A` = 记录中的显式加数,`P` = 补丁槽首字节地址。
- 先完成全部校验再生成镜像:任何一条重定位失败都不会输出半补丁镜像;输入模块原字节保持不变。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/sets` | 导入模块集合 `{modules:[...]}`,返回 `{setId, hash, created}` |
| GET | `/sets` / `/sets/:id` | 列出集合 / 读取模块原文 |
| POST | `/sets/:id/validate` | 仅校验并返回布局/符号/补丁预览 `{base?}` |
| POST | `/sets/:id/link` | 链接并保存版本 `{base}`,返回版本号与完整清单 |
| GET | `/versions` / `/versions/:id` | 版本列表 / 版本清单 |
| GET | `/versions/:id/image` | 下载二进制镜像 |
| GET | `/versions/:id/layout` `/symbols` `/patches` | 段布局 / 符号表 / 补丁说明 |
| GET | `/compare?a=1&b=2` | 比较两个版本(字节差异数、符号地址变化) |

错误统一为 `{"error":{"code","message","details?"}}`,HTTP 400。错误码:
`E_BAD_INPUT` `E_BAD_HEX` `E_ALIGN` `E_SECTION` `E_SYM_OOB` `E_DUP_SYMBOL` `E_UNDEF_SYMBOL`
`E_UNKNOWN_RELOC` `E_BAD_ADDEND` `E_SLOT_OOB` `E_SLOT_OVERLAP` `E_RELOC_RANGE`
`E_IMAGE_TOO_LARGE` `E_ADDR_RANGE` `E_NOT_FOUND`。

## 补丁说明字段

每个补丁包含:引用模块与段内偏移、槽地址 `P`、目标符号及其定义模块、`S`/`A`/计算值、
计算公式字符串、修改前后字节(`beforeHex`/`afterHex`),可据此独立复算结果。

## 演示

`npm run demo` 输出:基址 4096,甲 text 8 字节,乙 text 从 4104 开始并定义 `foo`;
甲偏移 0 的 `PCREL32` 写入 4,偏移 4 的 `ABS32` 写入 4104;data 段对齐 16 产生零填充。

## 限制

- 仅两种 4 字节小端重定位;无弱符号、无通用符号、无动态链接。
- 段只有 `text`/`data`;镜像为单一平坦字节序列,不生成 ELF/PE 头。
- `node:sqlite` 在 Node 25 仍带 ExperimentalWarning,不影响功能。
