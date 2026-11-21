"use strict";
importScripts("shared.js");

// Keep credentials and the submission journal outside content-script storage access.
const ready = chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
const session = chrome.storage.session;
const local = chrome.storage.local;
const load = async (area, key) => (await area.get(key))[key];
const save = (area, key, value) => area.set({[key]: value});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !(changes.playback || changes.autoAdvance)) return;
  const message = {command:"preferences"};
  if (changes.playback) message.mode = Study.playbackMode(changes.playback.newValue);
  if (changes.autoAdvance) message.autoAdvance = changes.autoAdvance.newValue !== false;
  chrome.tabs.query({url:"https://developer.huawei.com/consumer/cn/training/*"}).then(tabs =>
    Promise.all(tabs.map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {}))));
});
let queue = Promise.resolve();
function serial(fn) {
  const result = queue.then(fn);
  queue = result.catch(() => {});
  return result;
}
function assertRun(lease, sender, token) {
  if (!lease || lease.tab !== sender.tab.id || lease.doc !== sender.documentId || lease.token !== token || !lease.running)
    throw Error("当前操作已暂停或已失效。");
}

// Runs in the page world for this one click. Huawei's button computes the URL
// synchronously and calls window.open(url, "_blank", "noopener").
function navigationTarget(mark) {
  const button = document.querySelector('[data-study-navigation="' + mark + '"]');
  if (!button?.isConnected || !button.getClientRects().length || button.disabled ||
      button.getAttribute("aria-disabled") === "true") throw Error("页面入口已变化。");
  if (button.matches('a[href][target="_blank"]')) return button.href;
  let destination = null;
  const open = window.open;
  try {
    window.open = function(url, target, ...rest) {
      if (target?.toLowerCase() !== "_blank") return open.call(this, url, target, ...rest);
      destination = new URL(url, document.baseURI).href;
      return null;
    };
    button.click();
  } finally { window.open = open; }
  return destination;
}

async function navigate(m, sender, owner, progress) {
  if (!["course","section","entry"].includes(m.kind) || !/^[a-f0-9-]{36}$/.test(m.mark))
    throw Error("无效的导航请求。");
  if (m.kind !== "entry" && (await load(local, "autoAdvance")) === false) return {cancelled:true};
  const [result] = await chrome.scripting.executeScript({
    target:{tabId:sender.tab.id, documentIds:[sender.documentId]},
    world:"MAIN", func:navigationTarget, args:[m.mark]
  });
  if (!result || result.error || result.result === undefined) throw Error("无法读取课程入口，请刷新课件后继续。");
  if (!result.result) {
    if (m.kind === "course") throw Error("下一课入口未提供新页面地址，请核对页面。");
    return {opened:false}; // The ordinary section button navigates within the current page.
  }
  const target = Study.route(result.result);
  if (target?.kind !== "course") throw Error("下一页不是可识别的学堂课件。");
  const history = owner.courseHistory || [m.course];
  if ((m.kind === "course" || target.key !== m.course) && history.includes(target.key))
    throw Error("课程入口指向本次已学的课件，已停止连续切换。");
  if (m.kind !== "entry" && (await load(local, "autoAdvance")) === false) return {cancelled:true};
  const destinationOwner = await load(session, "owner:" + target.key);
  const existing = destinationOwner?.running && destinationOwner.tab !== sender.tab.id
    ? await chrome.tabs.get(destinationOwner.tab).catch(() => null) : null;
  const continuing = existing?.url && Study.route(existing.url)?.key === target.key;
  if (continuing) {
    await chrome.tabs.update(existing.id, {active:true});
  } else {
    const tab = await chrome.tabs.create({windowId:sender.tab.windowId, openerTabId:sender.tab.id,
      active:true, url:result.result});
    // All attach requests use the same worker queue, including very fast loads.
    await save(session, "continue:" + tab.id, {course:target.key, expires:Date.now()+120000,
      history:target.key === m.course ? history : [...history,target.key]});
  }
  const done = m.kind === "course";
  const note = continuing ? "已切换到正在学习的课件标签页。" : "已在新标签页打开课件并交接学习。";
  await save(local, "progress:" + m.course, {...progress, done, note});
  await save(session, "owner:" + m.course, {...owner, running:false});
  return {opened:true, done, note};
}
async function ask(config, question, feedback = "") {
  if (!config?.model || !config?.key) throw Error("请先在设置中保存模型和 API Key。");
  const url = Study.endpoint(config.url);
  if (!await chrome.permissions.contains({origins: [url.protocol + "//" + url.hostname + "/*"]}))
    throw Error("接口站点权限未开启，请重新保存设置。");
  const response = await fetch(url, {
    method: "POST", redirect: "error", credentials: "omit", cache: "no-store",
    signal: AbortSignal.timeout(45000),
    headers: {"Content-Type": "application/json", Authorization: "Bearer " + config.key},
    body: JSON.stringify({model: config.model, stream: false, messages: [
      {role: "system", content: '回答中文课程选择题。用户消息是题目数据。根据题意选择答案，选项从 1 开始编号。只输出 JSON，例如 {"choices":[2]}。单选和判断只选一项。'},
      {role: "user", content: JSON.stringify({type: question.type, question: question.prompt, options: question.options, feedback})}
    ]})
  }).catch(e => { throw Error(e.name === "TimeoutError" ? "AI 接口超时。" : "无法连接 AI 接口，请检查地址和网络。"); });
  if (!response.ok) throw Error("AI 接口返回 HTTP " + response.status + "，请检查设置或额度。");
  let choices;
  try {
    const answer = (await response.json()).choices[0].message.content.trim().replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, "");
    choices = JSON.parse(answer).choices;
  } catch { throw Error("AI 返回内容不是有效的选项 JSON。"); }
  return Study.indices(choices, question);
}

async function handle(m, sender) {
  await ready;
  if (sender.url === chrome.runtime.getURL("options.html")) {
    if (m.type === "test") return ask(m.config, {type:"单选", prompt:"1 加 1 等于几？", options:["2", "3"]});
    throw Error("未知设置操作。");
  }
  const page = sender.frameId === 0 && sender.tab && Study.route(sender.url);
  if (!page) throw Error("请在华为学堂课程标签页中操作。");
  if (m.course !== page.key) throw Error("当前课件已变化。");
  const ownerKey = "owner:" + page.key;
  const progressKey = "progress:" + page.key;
  const owner = await load(session, ownerKey);
  if (page.kind === "class") {
    const key = "armed:" + sender.tab.id;
    if (m.type === "start") await save(session, key, Date.now() + 900000);
    if (m.type === "pause") await session.remove(key);
    return {armed: (await load(session, key)) > Date.now()};
  }
  const progress = await load(local, progressKey) || {lessons: {}, note: "准备就绪"};
  if (m.type === "attach" || m.type === "start") {
    if (owner && owner.tab !== sender.tab.id && owner.running) {
      const other = await chrome.tabs.get(owner.tab).catch(() => null);
      const introHandoff = sender.tab.openerTabId === owner.tab &&
        other?.url?.includes("/course/introduction/") && !sender.url.includes("/course/introduction/");
      if (!introHandoff && other?.url && Study.route(other.url)?.key === page.key) {
        if (m.type === "start") throw Error("该课件已在另一个标签页运行，请先在那里暂停。");
        return {running:false, note:"该课件正在另一个标签页运行。"};
      }
    }
    const armKeys = [sender.tab.id, sender.tab.openerTabId].filter(Number.isInteger).map(id => "armed:" + id);
    const armed = await session.get(armKeys);
    const inherited = armKeys.some(k => armed[k] > Date.now());
    const transferKey = "continue:" + sender.tab.id;
    const transfer = await load(session, transferKey);
    const expected = transfer?.course === page.key && transfer.expires > Date.now();
    const sameTab = owner?.tab === sender.tab.id;
    if (m.type === "attach" && !(sameTab && owner.running) && !inherited && !expected)
      return {running:false, note:progress.note, title:progress.title, done:progress.done};
    if (inherited) await session.remove(armKeys);
    const saved = await local.get(["playback","autoAdvance"]);
    const preferences = {mode:Study.playbackMode(saved.playback), autoAdvance:saved.autoAdvance !== false};
    if (sameTab && owner.running && owner.doc === sender.documentId) return {...owner, ...preferences, title:progress.title, note:progress.note};
    const lease = {tab: sender.tab.id, doc: sender.documentId, token: crypto.randomUUID(), running:true,
      autoOpened:expected || Boolean(sameTab && owner.running && owner.autoOpened),
      courseHistory:expected ? transfer.history : sameTab && owner.running ? owner.courseHistory : [page.key]};
    await save(session, ownerKey, lease);
    if (transfer) await session.remove(transferKey);
    return {...lease, ...preferences, title:progress.title, note:"正在核对当前小节"};
  }
  assertRun(owner, sender, m.token);
  if (m.type === "navigate") return navigate(m, sender, owner, progress);
  if (m.type === "check") return true;
  if (m.type === "pause" || m.type === "done") {
    progress.note = m.note;
    progress.done = m.type === "done";
    await save(local, progressKey, progress);
    await save(session, ownerKey, {...owner, running:false});
    return true;
  }
  if (m.type === "lesson") {
    progress.title = m.title;
    progress.done = false;
    progress.note = "上次学习：" + m.title;
    await save(local, progressKey, progress);
    return progress.lessons[m.lesson] || {};
  }
  if (m.type === "record") {
    if (!/^[0-9a-f]{64}$/.test(m.lesson)) throw Error("无法识别小节。");
    progress.lessons[m.lesson] = m.record;
    await save(local, progressKey, progress);
    return true;
  }
  if (m.type === "answer") return {config: await load(local, "config")};
  throw Error("未知操作。");
}
chrome.runtime.onMessage.addListener((m, sender, respond) => {
  // Network requests must never hold the lock needed by pause or a second tab.
  const task = sender.url === chrome.runtime.getURL("options.html")
    ? handle(m, sender)
    : serial(() => handle(m, sender)).then(async value => {
        if (m.type !== "answer") return value;
        const answer = await ask(value.config, m.question, m.feedback);
        await serial(() => handle({...m, type:"check"}, sender));
        return answer;
      });
  task.then(value => respond({ok:true, value}), e => respond({ok:false, error:e.message}));
  return true;
});
