// 演示:基址 4096,甲 text 8 字节,乙 text 从 4104 开始定义 foo
const { link } = require("./dist/linker");

const modules = [
  {
    name: "甲",
    text: { align: 4, bytes: "0000000000000000" },
    data: { align: 16, bytes: "deadbeef" },
    relocations: [
      { section: "text", offset: 0, type: "PCREL32", symbol: "foo" },
      { section: "text", offset: 4, type: "ABS32", symbol: "foo" },
    ],
  },
  {
    name: "乙",
    text: { align: 4, bytes: "90c3" },
    symbols: [{ name: "foo", section: "text", offset: 0 }],
  },
];

const r = link(modules, 4096);
console.log("段布局:");
for (const l of r.layout) {
  console.log(`  ${l.module}.${l.section} 地址=${l.address} 镜像偏移=${l.offset} 文件偏移=${l.fileOffset} 大小=${l.size} 对齐=${l.align}`);
}
console.log("符号表:");
for (const s of r.symbols) console.log(`  ${s.name} = ${s.address} (${s.module}.${s.section}+${s.sectionOffset})`);
console.log("补丁说明:");
for (const p of r.patches) {
  console.log(`  ${p.module}.${p.section}+${p.sectionOffset} [${p.type}] ${p.formula}`);
  console.log(`    槽地址 P=${p.slotAddress} 目标 ${p.symbol}(定义于${p.symbolModule}) 前=${p.beforeHex} 后=${p.afterHex}`);
}
console.log(`镜像(${r.image.length} 字节): ${r.image.toString("hex")}`);
console.log(`甲.text+0 小端 = ${r.image.readInt32LE(0)} (期望 4)`);
console.log(`甲.text+4 小端 = ${r.image.readUInt32LE(4)} (期望 4104)`);
const data = r.layout.find((l) => l.section === "data");
console.log(`data 段地址=${data.address},对齐 16 产生的零填充: ${r.image.subarray(10, data.offset).toString("hex")}`);
