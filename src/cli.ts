import * as fs from "node:fs";
import { Store } from "./store";
import { link } from "./linker";
import { LinkError } from "./errors";
import { startServer } from "./api";

const store = new Store();

function out(x: unknown) {
  console.log(JSON.stringify(x, null, 2));
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  switch (cmd) {
    case "import": {
      // import <file.json> —— 文件内容为模块数组或 {modules:[...]}
      const raw = JSON.parse(fs.readFileSync(rest[0], "utf8"));
      const modules = Array.isArray(raw) ? raw : raw.modules;
      link(modules, 0); // 导入前校验
      out(store.importModules(modules));
      break;
    }
    case "sets":
      out(store.listSets());
      break;
    case "link": {
      // link <setId> --base 4096
      const setId = Number(rest[0]);
      const base = Number(arg("--base") ?? 0);
      const { versionId, result, reused } = store.linkAndStore(setId, base);
      out({ versionId, reused, base, imageSize: result.image.length, layout: result.layout, symbols: result.symbols, patches: result.patches });
      break;
    }
    case "validate": {
      const setId = Number(rest[0]);
      const base = Number(arg("--base") ?? 0);
      const r = link(store.getModules(setId), base);
      out({ ok: true, layout: r.layout, symbols: r.symbols, patches: r.patches });
      break;
    }
    case "versions":
      out(store.listVersions().map((v) => ({ ...v, summary: undefined })));
      break;
    case "layout":
    case "symbols":
    case "patches": {
      const v = store.getVersion(Number(rest[0]));
      out(v.summary[cmd]);
      break;
    }
    case "export": {
      // export <versionId> <out.bin>
      const v = store.getVersion(Number(rest[0]));
      fs.writeFileSync(rest[1], v.image);
      console.log(`已导出 ${v.image.length} 字节到 ${rest[1]}`);
      break;
    }
    case "compare":
      out(store.compare(Number(rest[0]), Number(rest[1])));
      break;
    case "serve": {
      const p = arg("--port");
      const { port } = await startServer(p ? Number(p) : undefined);
      console.log(`链接服务已启动: http://localhost:${port}`);
      break;
    }
    default:
      console.log(`用法:
  node dist/cli.js import <modules.json>     导入模块集合(先校验)
  node dist/cli.js sets                      列出模块集合
  node dist/cli.js validate <setId> [--base N]
  node dist/cli.js link <setId> --base N     链接并保存版本
  node dist/cli.js versions                  列出版本
  node dist/cli.js layout|symbols|patches <versionId>
  node dist/cli.js export <versionId> <out.bin>
  node dist/cli.js compare <verA> <verB>
  node dist/cli.js serve [--port N]          启动 API(默认选空闲端口)`);
  }
}

main().catch((e) => {
  if (e instanceof LinkError) {
    console.error(`错误 [${e.code}] ${e.message}`);
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
});
