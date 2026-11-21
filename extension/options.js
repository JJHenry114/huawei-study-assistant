"use strict";
const el = id => document.getElementById(id);
const form = el("form");
let savedOrigin;
chrome.storage.local.get("config").then(({config}) => {
  if (!config) return;
  for (const field of ["url","model","key"]) el(field).value = config[field];
  savedOrigin = Study.endpoint(config.url).origin;
});
el("url").addEventListener("input", () => {
  if (!savedOrigin) return;
  try { if (Study.endpoint(el("url").value).origin === savedOrigin) return; } catch {}
  el("key").value = "";
  savedOrigin = null;
});
async function configure(test) {
  if (!form.reportValidity()) return;
  const fields = [...form.querySelectorAll("button")];
  fields.forEach(b => b.disabled = true);
  try {
    const url = Study.endpoint(el("url").value.trim());
    const config = {url:url.href, model:el("model").value.trim(), key:el("key").value.trim()};
    if (!config.model || !config.key) throw Error("请填写模型名称和密钥。");
    const allowed = await chrome.permissions.request({origins:[url.protocol + "//" + url.hostname + "/*"]});
    if (!allowed) throw Error("需要允许访问所填接口才能调用模型。");
    if (test) {
      el("note").textContent = "正在发送一道测试题…";
      await Study.rpc("test", {config});
      el("note").textContent = "连接成功，模型已返回有效的选项编号。";
    } else {
      await chrome.storage.local.set({config});
      savedOrigin = url.origin;
      el("note").textContent = "设置已保存。";
    }
  } catch(e) {el("note").textContent = e.message;}
  finally { fields.forEach(b => b.disabled = false); }
}
form.onsubmit = e => {e.preventDefault(); configure(false);};
el("test").onclick = () => configure(true);
