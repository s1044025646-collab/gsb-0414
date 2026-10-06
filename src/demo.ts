import { Store } from "./store.js";
import { ModuleInput } from "./model.js";

// 演示: 基址 4096, 模块甲 text 8 字节, 模块乙 text 从 4104 开始并定义 foo。
// 甲偏移 0: PCREL32 -> foo  => 4104 - (4096+4) = 4
// 甲偏移 4: ABS32   -> foo  => 4104
// 乙 data 对齐 16 => 展示零填充。
export const demoModules: ModuleInput[] = [
  {
    name: "甲",
    text: { bytes: "00000000" + "00000000", align: 4 },
    data: { bytes: "aabb", align: 4 },
    relocations: [
      { section: "text", offset: 0, type: "PCREL32", symbol: "foo", addend: 0 },
      { section: "text", offset: 4, type: "ABS32", symbol: "foo", addend: 0 },
    ],
  },
  {
    name: "乙",
    text: { bytes: "c3", align: 4 },
    data: { bytes: "0102", align: 16 },
    symbols: [{ name: "foo", section: "text", offset: 0 }],
  },
];

export function runDemo(store: Store): void {
  const setId = store.importModules(demoModules);
  const { jobId, result } = store.link(setId, 4096);
  console.log(`setId=${setId} jobId=${jobId} base=${result.base} imageSize=${result.imageSize}`);
  console.log("段布局:");
  for (const s of result.sections) {
    console.log(`  ${s.module}.${s.section}  偏移=${s.offset}  地址=${s.address}  大小=${s.size}  对齐=${s.align}`);
  }
  console.log("符号:");
  for (const s of result.symbols) {
    console.log(`  ${s.name} = ${s.address}  (${s.module}.${s.section}+${s.offset})`);
  }
  console.log("补丁:");
  for (const p of result.patches) {
    console.log(`  ${p.module}.${p.section}+${p.slotOffset} ${p.type} ${p.symbol}: S=${p.S} A=${p.addend} P=${p.P} => ${p.value}  [${p.before} -> ${p.after}]`);
  }
  console.log(`镜像(hex): ${result.image.toString("hex")}`);
  const pcrel = result.image.readUInt32LE(0);
  const abs = result.image.readUInt32LE(4);
  console.log(`读取校验: PCREL32 槽 = ${pcrel} (期望 4), ABS32 槽 = ${abs} (期望 4104)`);
}
