// 发布前检查：准备推 GitHub 时跑这个。命中即 exit 1。
// 用法：node plugins/dsh-acceptance-gate/tests/publish-check.mjs [目录]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(process.argv[2] || ".");
const SKIP_DIRS = new Set([".git", "node_modules", ".dsh", ".dsh-tmp", "artifacts", "40_冷数据", "40_冷数据".normalize()]);
const SKIP_FILES = [/^ACCEPTANCE\.(md|html)$/i, /^acceptance\.json$/i, /^secrets\.js$/i, /^publish-check\.mjs$/i];
const MAX = 1024 * 1024;

const user = (() => { try { return os.userInfo().username; } catch { return ""; } })();
const host = (() => { try { return os.hostname(); } catch { return ""; } })();
const home = (() => { try { return os.homedir(); } catch { return ""; } })();

const RULES = [
  { id: "win-abs", label: "Windows 绝对路径", re: /[A-Za-z]:\\+[A-Za-z0-9._-]{2,}/g },
  { id: "nix-home", label: "unix 家目录", re: /\/(?:Users|home)\//g },
  { id: "key", label: "疑似密钥", re: /(sk-[A-Za-z0-9]{16,}|DEEPSEEK_API_KEY\s*[:=]\s*["']?[A-Za-z0-9_-]{16,}|-----BEGIN[ A-Z]*PRIVATE KEY-----)/g },
  { id: "phone", label: "手机号", re: /(?<!\d)1[3-9]\d{9}(?!\d)/g },
  { id: "idcard", label: "身份证", re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
];

function walk(dir, out, depth) {
  if (depth > 10) return;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out, depth + 1); }
    else if (e.isFile()) out.push(path.join(dir, e.name));
  }
}

const files = [];
walk(ROOT, files, 0);
const hits = [];
let scanned = 0;

for (const f of files) {
  const name = path.basename(f);
  if (SKIP_FILES.some((re) => re.test(name))) continue;
  let text = "";
  try {
    if (fs.statSync(f).size > MAX) continue;
    text = fs.readFileSync(f, "utf8");
  } catch { continue; }
  if (text.indexOf("\u0000") >= 0) continue;
  scanned += 1;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.length > 3000) continue;
    let flagged = null;
    for (const r of RULES) { r.re.lastIndex = 0; if (r.re.test(line)) { flagged = r; break; } }
    if (!flagged && user && user.length > 2 && line.indexOf(user) >= 0 && line.indexOf("<home>") < 0) flagged = { id: "username", label: "本机用户名" };
    if (!flagged && host && host.length > 2 && line.indexOf(host) >= 0 && line.indexOf("<host>") < 0) flagged = { id: "hostname", label: "主机名" };
    if (flagged) hits.push({ file: path.relative(ROOT, f), line: i + 1, rule: flagged.id, label: flagged.label, text: line.trim().slice(0, 120) });
  }
}

console.log("发布前检查：" + (hits.length ? "命中 " + hits.length + " 处" : "干净"));
console.log("根目录：" + ROOT);
console.log("文件：" + files.length + " 个，读过 " + scanned + " 个\n");
for (const h of hits) console.log("- " + h.file + ":" + h.line + "  [" + h.rule + "] " + h.text);
if (hits.length) {
  console.log("\n处置：路径改成 env/homedir/相对；用户名与主机名交给报告脱敏；密钥删掉换环境变量。");
  process.exit(1);
}
console.log("可以发布：没有本机路径、用户名、主机名、密钥。");
