import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { linkModules } from "./linker.js";
import { LinkError } from "./model.js";
import { compareJobs, Store } from "./store.js";
import { startServer } from "./server.js";

const DATA_DIR = process.env.LINKER_DATA_DIR ?? path.join(process.cwd(), "data");

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function print(x: unknown): void {
  console.log(typeof x === "string" ? x : JSON.stringify(x, null, 2));
}

function loadModulesFile(file: string): unknown[] {
  const doc = JSON.parse(readFileSync(file, "utf8"));
  const modules = Array.isArray(doc) ? doc : doc.modules;
  if (!Array.isArray(modules)) throw new LinkError("E_BAD_INPUT", "文件需为模块数组或 { modules: [...] }");
  return modules;
}

const HELP = `用法: node dist/src/cli.js <命令> [参数]

命令:
  serve [--port N]                 启动 HTTP API (默认自动选择空闲端口)
  import <modules.json>            导入模块集合, 输出 setId
  validate <modules.json> [--base N]  仅校验并预览布局
  link (--set <id> | --file <f>) --base N   执行链接, 输出 jobId
  jobs                             列出链接任务
  layout <jobId>                   查看段布局
  symbols <jobId>                  查看符号表
  patches <jobId>                  查看补丁说明
  export <jobId> <out.bin> [--manifest <out.json>]  导出镜像与清单
  compare <jobIdA> <jobIdB>        比较两个链接版本
  demo                             运行内置演示 (基址 4096)
`;

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...args] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") { console.log(HELP); return; }
  const store = new Store(DATA_DIR);
  try {
    switch (cmd) {
      case "serve": {
        const port = Number(argValue(args, "--port") ?? 0);
        const { port: actual } = await startServer(store, port);
        console.log(`API 已启动: http://127.0.0.1:${actual}  (数据目录: ${DATA_DIR})`);
        return; // 保持进程运行
      }
      case "import": {
        const modules = loadModulesFile(args[0]);
        const setId = store.importModules(modules as never);
        print({ setId, moduleCount: modules.length });
        break;
      }
      case "validate": {
        const modules = loadModulesFile(args[0]);
        const base = Number(argValue(args, "--base") ?? 0);
        const r = linkModules(modules, base);
        print({ ok: true, imageSize: r.imageSize, sections: r.sections, symbols: r.symbols });
        break;
      }
      case "link": {
        const base = Number(argValue(args, "--base") ?? "NaN");
        if (!Number.isSafeInteger(base)) throw new LinkError("E_BAD_BASE", "需要 --base <整数>");
        let setId = Number(argValue(args, "--set") ?? "NaN");
        if (!Number.isInteger(setId)) {
          const file = argValue(args, "--file");
          if (!file) throw new LinkError("E_BAD_INPUT", "需要 --set <id> 或 --file <modules.json>");
          setId = store.importModules(loadModulesFile(file) as never);
        }
        const { jobId, result } = store.link(setId, base);
        print({ jobId, setId, base: result.base, imageSize: result.imageSize, symbols: result.symbols, patches: result.patches });
        break;
      }
      case "jobs": print({ jobs: store.listJobs() }); break;
      case "layout": print(store.getJob(Number(args[0])).manifest.sections); break;
      case "symbols": print(store.getJob(Number(args[0])).manifest.symbols); break;
      case "patches": print(store.getJob(Number(args[0])).manifest.patches); break;
      case "export": {
        const jobId = Number(args[0]);
        const out = args[1];
        if (!out) throw new LinkError("E_BAD_INPUT", "需要输出文件路径");
        writeFileSync(out, store.getImage(jobId));
        const manifestPath = argValue(args, "--manifest");
        if (manifestPath) writeFileSync(manifestPath, JSON.stringify(store.getJob(jobId).manifest, null, 2));
        print({ exported: out, manifest: manifestPath ?? null });
        break;
      }
      case "compare": {
        const a = store.getJob(Number(args[0])).manifest;
        const b = store.getJob(Number(args[1])).manifest;
        print(compareJobs(a, b));
        break;
      }
      case "demo": {
        const { runDemo } = await import("./demo.js");
        runDemo(store);
        break;
      }
      default:
        console.error(`未知命令: ${cmd}\n${HELP}`);
        process.exitCode = 2;
    }
  } finally {
    if (cmd !== "serve") store.close();
  }
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof LinkError) console.error(`错误 [${e.code}]: ${e.message}`);
  else console.error(e);
  process.exitCode = 1;
});
