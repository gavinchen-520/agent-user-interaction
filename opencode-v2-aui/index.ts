// 包根入口：OpenCode 的本地目录插件加载器要求包根存在入口文件
// （它不读取 package.json 的 exports），因此这里转发到真正的实现 src/index.ts。
// 没有这个文件时，`plugins: [{ "package": "./opencode-v2-aui" }]` 会被静默跳过。
export { createPlugin, default } from "./src/index.ts";
