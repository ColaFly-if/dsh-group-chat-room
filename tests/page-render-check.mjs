// 页面渲染自检：脚本可解析 + 发送后确实用整体解析渲染事件
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, "..", "web", "index.html");
const html = fs.readFileSync(file, "utf8");

let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { console.log("PASS " + name); return; }
  fail += 1; console.log("FAIL " + name + (extra ? " :: " + extra : ""));
};

const scripts = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
ok("页面只有一个内联脚本", scripts.length === 1, "实际 " + scripts.length);

let syntaxErr = "";
let body = "";
if (scripts.length === 1) {
  body = scripts[0].replace(/^<script>/, "").replace(/<\/script>$/, "");
  try { new Function(body); } catch (e) { syntaxErr = e.message; }
}
ok("脚本语法可解析", syntaxErr === "", syntaxErr);

const codeLines = body.split(/\r?\n/).filter((l) => {
  const t = l.trim();
  return t && !t.startsWith("//");
});

ok("存在真正执行的 res.text() 整体读取", codeLines.some((l) => l.includes("await res.text()")));
ok("按 data: 前缀过滤事件", codeLines.some((l) => l.includes('indexOf("data:")')));
ok("读完响应后重拉历史渲染", codeLines.some((l) => l.includes("await loadHistory()")));
ok("msg_end 缺 msg_start 时也会补气泡", body.includes("if (!b3) b3 = addMessage("));
ok("SKIP 直接 return 不上屏", /if \(t === 'skipped'\) \{\s*\r?\n\s*return;/.test(body));

if (fail) { console.log("PAGE_RENDER_FAIL " + fail); process.exit(1); }
console.log("PAGE_RENDER_OK");
