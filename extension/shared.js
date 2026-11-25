"use strict";
globalThis.Study = (() => {
  const classId = "faa734fca6dd490f9ec6981b5302f238";
  const rates = [1, 1.25, 1.5, 2, 3, 4, 8, 16, 32];
  const examPattern = "https://developer.huawei.com/consumer/cn/training/exam-doing/*";
  function examKey(address) {
    const url = new URL(address);
    const match = url.pathname.match(/^\/consumer\/cn\/training\/exam-doing\/([\w-]+)\/?$/);
    if (url.origin !== "https://developer.huawei.com" || !match) return null;
    return JSON.stringify([match[1], url.searchParams.get("paperId"), url.searchParams.get("relationId"), url.searchParams.get("authDetailId")]);
  }
  function playbackMode(value) {
    return value === "end" || rates.includes(value) ? value : 1;
  }
  function route(address) {
    const u = new URL(address);
    if (u.origin !== "https://developer.huawei.com") return null;
    const path = u.pathname.replace(/\/$/, "");
    if (path === "/consumer/cn/training/classDetail/" + classId) return { kind: "class", key: classId };
    const match = path.match(/^\/consumer\/cn\/training\/course\/(mooc|slightMooc|introduction|video)\/([\w-]+)$/);
    return match && { kind: "course", key: match[2] };
  }
  function endpoint(value) {
    const u = new URL(value);
    if (!(u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname))) ||
        u.username || u.password || u.search || u.hash) throw Error("请填写 HTTPS 接口地址，本机服务也可使用 HTTP。");
    u.pathname = u.pathname.replace(/\/+$/, "");
    if (!u.pathname.endsWith("/chat/completions")) u.pathname = u.pathname.replace(/\/$/, "") + "/chat/completions";
    return u;
  }
  function indices(answer, question) {
    if (!Array.isArray(answer) || !answer.length || new Set(answer).size !== answer.length ||
        answer.some(x => !Number.isInteger(x) || x < 1 || x > question.options.length) ||
        (question.type !== "多选" && answer.length !== 1)) throw Error("AI 返回的选项编号无效，已暂停。");
    return answer;
  }
  async function digest(value) {
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
  }
  async function rpc(type, fields = {}) {
    const reply = await chrome.runtime.sendMessage({type, ...fields});
    if (!reply?.ok) throw Error(reply?.error || "扩展后台未响应。");
    return reply.value;
  }
  return { route, endpoint, indices, digest, rpc, classId, rates, playbackMode, examKey, examPattern };
})();
