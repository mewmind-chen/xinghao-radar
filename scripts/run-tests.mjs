import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const files = [];
function collect(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) collect(path);
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(path);
  }
}
collect(join(root, "scripts"));
collect(join(root, "tests"));
files.sort();
if (!files.length) throw new Error("未找到测试文件");
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", cwd: root });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
