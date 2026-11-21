"use strict";
const el = id => document.getElementById(id);
let tab, state, busy = false, errorMessage = "";
const playback = el("playback");
const autoAdvance = el("autoAdvance");
for (const rate of Study.rates.slice(1)) el("speeds").append(new Option(rate + "× 播放", String(rate)));
chrome.storage.local.get(["playback","autoAdvance"]).then(saved => {
  playback.value = String(Study.playbackMode(saved.playback));
  playback.disabled = false;
  autoAdvance.checked = saved.autoAdvance !== false;
  autoAdvance.disabled = false;
});
autoAdvance.onchange = async () => {
  autoAdvance.disabled = true;
  try { await chrome.storage.local.set({autoAdvance:autoAdvance.checked}); }
  catch {
    autoAdvance.checked = !autoAdvance.checked;
    errorMessage = "自动切节设置保存失败，请重试。";
  } finally { autoAdvance.disabled = false; }
};
playback.onchange = async () => {
  const mode = playback.value === "end" ? "end" : Number(playback.value);
  try { await chrome.storage.local.set({playback:mode}); }
  catch { errorMessage = "播放方式保存失败，请重新选择。"; }
};
el("settings").onclick = () => chrome.runtime.openOptionsPage();
async function refresh(command = "status") {
  if (busy) return;
  busy = true;
  el("action").disabled = true;
  try {
    tab ??= (await chrome.tabs.query({active:true, currentWindow:true}))[0];
    const result = await chrome.tabs.sendMessage(tab.id, {command});
    if (!result.ok) {errorMessage = result.error; throw Error(result.error);}
    state = result.value;
    if (command !== "status") errorMessage = "";
    el("state").textContent = state.running ? "运行中" : state.done ? "已完成" : "待命";
    el("lesson").textContent = state.title || "当前课程";
    el("note").textContent = errorMessage || state.note;
    el("action").textContent = state.running ? "暂停" : state.title && !state.done ? "继续学习" : "开始学习";
    el("course").hidden = true;
    el("action").disabled = false;
  } catch (e) {
    el("state").textContent = "待命";
    el("note").textContent = errorMessage || "请打开华为学堂课件。刚加载扩展时，请刷新已有的课程标签页。";
    el("course").hidden = false;
    el("action").disabled = !state;
  } finally { busy = false; }
}
el("action").onclick = () => refresh(state?.running ? "pause" : "start");
refresh();
setInterval(() => refresh(), 1000);
