// Run against an isolated Chromium profile. All course documents come from the fixture.
import assert from "node:assert/strict";
import {mkdtemp, readFile, writeFile, cp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {spawn} from "node:child_process";
import {createServer} from "node:http";
import {setTimeout as delay} from "node:timers/promises";
import {once} from "node:events";
import {testExam} from "./exam-cases.mjs";

const temp = await mkdtemp(join(tmpdir(), "study-extension-test-"));
const extension = join(temp, "extension");
const fixture = await readFile(new URL("./fixture.html", import.meta.url), "base64");
const examFixture = await readFile(new URL("./exam-fixture.html", import.meta.url), "base64");
let releaseModel, held = false, invalid = false;
const requests = [];
const server = createServer(async (req,res) => {
  let body = "";
  for await (const part of req) body += part;
  const content = JSON.parse(body).messages[1].content;
  const q = JSON.parse(Array.isArray(content) ? content[0].text : content);
  if (Array.isArray(content)) q.attachments = content.slice(1);
  requests.push(q);
  if (held) await new Promise(resolve => {releaseModel = resolve;});
  const choices = invalid ? [123] : q.type === "多选" ? [1,3] : [1];
  res.writeHead(200,{"Content-Type":"application/json"});
  res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({choices})}}]}));
});
async function until(read, accept = Boolean, ms = 24000) {
  const end = Date.now() + ms;
  let value;
  do {value = await read(); if (accept(value)) return value; await delay(120);} while (Date.now() < end);
  throw Error("等待超时。最后状态 " + JSON.stringify(value));
}
class Protocol {
  constructor(socket) {
    this.socket = socket; this.sequence = 0; this.calls = new Map();
    socket.onmessage = event => {
      const m = JSON.parse(event.data);
      if (m.id) {
        const done = this.calls.get(m.id); this.calls.delete(m.id);
        if (m.error) done.reject(Error(m.error.message)); else done.resolve(m.result);
      } else if (m.method === "Target.attachedToTarget" && m.params.waitingForDebugger) {
        const session = m.params.sessionId;
        this.send("Fetch.enable",{patterns:[{urlPattern:"https://developer.huawei.com/*"}]},session)
          .then(() => this.send("Runtime.runIfWaitingForDebugger",{},session));
      } else if (m.method === "Fetch.requestPaused") {
        const local = m.params.resourceType === "Document" && new URL(m.params.request.url).hostname === "developer.huawei.com";
        const page = new URL(m.params.request.url).pathname.includes("/exam-doing/") ? examFixture : fixture;
        this.send("Fetch.fulfillRequest", {requestId:m.params.requestId, responseCode:local ? 200 : 404,
          responseHeaders:[{name:"Content-Type",value:"text/html; charset=utf-8"}], body:local ? page : ""}, m.sessionId);
      }
    };
  }
  send(method, params = {}, sessionId) {
    const id = ++this.sequence;
    return new Promise((resolve,reject) => {
      this.calls.set(id,{resolve,reject}); this.socket.send(JSON.stringify({id,method,params,sessionId}));
    });
  }
  async attach(targetId) {return (await this.send("Target.attachToTarget",{targetId,flatten:true})).sessionId;}
  async eval(session, expression, userGesture = false) {
    const r = await this.send("Runtime.evaluate",{expression,returnByValue:true,awaitPromise:true,userGesture},session);
    if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
}
let browser, socket;
try {
  server.listen(0,"127.0.0.1"); await once(server,"listening");
  await cp(new URL("../extension/", import.meta.url),extension,{recursive:true});
  const manifestPath = join(extension,"manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath,"utf8"));
  manifest.host_permissions.push("http://127.0.0.1/*"); // Pre-grant the mock provider only in this copy.
  await writeFile(manifestPath,JSON.stringify(manifest));
  const profile = join(temp,"profile");
  const binary = process.env.CHROMIUM_BIN || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
  browser = spawn(binary,["--headless=new","--no-first-run","--disable-background-networking","--disable-sync",
    "--disable-background-timer-throttling","--disable-renderer-backgrounding","--disable-features=msEdgeSidebarV2",
    "--autoplay-policy=no-user-gesture-required","--host-resolver-rules=MAP developer.huawei.com ~NOTFOUND",
    "--remote-debugging-port=0","--user-data-dir="+profile,"--disable-extensions-except="+extension,
    "--load-extension="+extension,"about:blank"],{windowsHide:true,stdio:"ignore"});
  const portFile = join(profile,"DevToolsActivePort");
  const [port,path] = (await until(() => readFile(portFile,"utf8").catch(() => ""))).trim().split(/\r?\n/);
  socket = new WebSocket("ws://127.0.0.1:"+port+path); await once(socket,"open");
  const c = new Protocol(socket);
  const targets = async () => (await c.send("Target.getTargets")).targetInfos;
  const service = await until(async () => (await targets()).find(t => t.type === "service_worker" && t.url.startsWith("chrome-extension://") && t.url.endsWith("/worker.js")));
  const worker = await c.attach(service.targetId);
  await until(() => c.eval(worker, "Boolean(globalThis.chrome?.tabs)"));
  const cfg = {url:"http://127.0.0.1:"+server.address().port+"/v1",model:"fixture",key:"test-only"};
  const optionsURL = new URL("options.html",service.url).href;
  const optionsTarget = await c.send("Target.createTarget",{url:optionsURL});
  const optionsPage = await c.attach(optionsTarget.targetId);
  await until(() => c.eval(optionsPage,"!!document.querySelector('#test')"));
  await c.eval(optionsPage,"Object.entries("+JSON.stringify(cfg)+").forEach(([k,v])=>document.getElementById(k).value=v);document.getElementById('form').requestSubmit()",true);
  await until(() => c.eval(optionsPage,"document.getElementById('note').textContent"),t => t.includes("已保存"));
  await c.eval(optionsPage,"document.getElementById('test').click()",true);
  await until(() => c.eval(optionsPage,"document.getElementById('note').textContent"),t => t.includes("连接成功"));
  console.log("PASS settings");
  async function openCase(mode, key = mode, address) {
    const url = address || "https://developer.huawei.com/consumer/cn/training/course/mooc/"+key+"?case="+mode;
    const {targetId} = await c.send("Target.createTarget",{url:"about:blank"});
    const session = await c.attach(targetId);
    await c.send("Fetch.enable",{patterns:[{urlPattern:"https://developer.huawei.com/*"}]},session);
    await c.send("Page.navigate",{url},session);
    const tabId = await until(() => c.eval(worker,"chrome.tabs.query({url:"+JSON.stringify(url.split("?")[0]+"*")+"}).then(ts=>ts.at(-1)?.id)"));
    const command = cmd => c.eval(worker,"chrome.tabs.sendMessage("+tabId+",{command:"+JSON.stringify(cmd)+"}).catch(()=>null)");
    await until(() => command("status"),r => r?.ok);
    return {command, session, targetId, read:js => c.eval(session,js),
      count:name => c.eval(session,"Number(sessionStorage.getItem("+JSON.stringify(name)+")||0)"),
      paused:() => until(() => command("status"),r => r?.ok && !r.value.running),
      done:() => until(() => command("status"),r => r?.value.done)};
  }
  await testExam({openCase,c,worker,until,delay,requests, hold:() => {held=true;releaseModel=null;},
    release:() => {held=false;releaseModel?.();}, waiting:() => !!releaseModel});
  const popupURL = new URL("popup.html",service.url).href;
  const popupTarget = await c.send("Target.createTarget",{url:popupURL});
  const popup = await c.attach(popupTarget.targetId);
  const selectedMode = () => c.eval(popup,"document.querySelector('#playback:not(:disabled)')?.value");
  assert.equal(await until(selectedMode),"1");
  const advanceChecked = () => c.eval(popup,"document.querySelector('#autoAdvance:not(:disabled)')?.checked");
  assert.equal(await advanceChecked(),true);
  async function toggleAdvance(expected) {
    await c.eval(popup,"document.querySelector('#autoAdvance').click()");
    await until(() => c.eval(worker,"chrome.storage.local.get('autoAdvance').then(s=>s.autoAdvance)"),v => v === expected);
  }
  const waitingForManual = page => until(() => page.command("status"),
    r => r?.value.running && r.value.note.includes("等待手动进入下一节"));
  const source = await openCase("chainSource");
  await c.send("Target.setAutoAttach",{autoAttach:true,waitForDebuggerOnStart:true,flatten:true,
    filter:[{type:"page",exclude:false},{exclude:true}]});
  await toggleAdvance(false);
  assert((await source.command("start")).ok);
  await until(() => source.command("status"),r => r?.value.note.includes("等待手动进入下一课"));
  assert.equal(await source.count("courseClicks"),0);
  await toggleAdvance(true);
  await source.done();
  const children = () => c.eval(worker,`chrome.tabs.query({url:"https://developer.huawei.com/consumer/cn/training/course/*/chainChild*"}).then(ts=>ts.map(t=>({id:t.id,url:t.url})))`);
  const opened = await until(children,ts => ts.length === 2);
  const lessonTab = opened.find(t => t.url.includes("/mooc/"));
  assert(lessonTab);
  await until(() => c.eval(worker,"chrome.tabs.sendMessage("+lessonTab.id+",{command:'status'}).catch(()=>null)"),r => r?.value.done);
  assert.equal(await source.count("courseClicks"),1);
  assert.equal((await children()).length,2);
  await c.send("Target.setAutoAttach",{autoAttach:false,waitForDebuggerOnStart:false,flatten:true});
  console.log("PASS next course and introduction handoff across real tabs");
  async function selectPlayback(value) {
    await c.eval(popup,`{
      const select = document.querySelector('#playback');
      select.value = ${JSON.stringify(value)};
      select.dispatchEvent(new Event('change'));
    }`);
    await until(() => c.eval(worker,"chrome.storage.local.get('playback').then(s=>String(s.playback))"),v => v === value);
  }
  const media = await openCase("playback");
  await selectPlayback("2");
  assert((await media.command("start")).ok);
  const videoProp = prop => media.read("document.querySelector('video')."+prop);
  await until(() => videoProp("playbackRate"),rate => rate === 2);
  await selectPlayback("32");
  await until(() => media.command("status"),r => r?.value.note.includes("32×"));
  const native = await videoProp("playbackRate");
  const before = await videoProp("currentTime");
  const start = performance.now();
  await delay(2400);
  const effective = (await videoProp("currentTime") - before) / ((performance.now() - start)/1000);
  assert(effective > 25 && effective < 39, "32× effective rate: "+effective);
  await media.read("document.querySelector('video').pause()");
  const pausedAt = await videoProp("currentTime");
  await delay(900);
  assert(Math.abs(await videoProp("currentTime") - pausedAt) < 0.1, "暂停期间快进仍在运行");
  await selectPlayback("1");
  await until(() => videoProp("playbackRate"),rate => rate === 1);
  assert(await videoProp("paused"));
  await media.read("document.querySelector('video').play()");
  await selectPlayback("end");
  await until(() => media.command("status"),r => r?.value.note.includes("等待平台记录完成"));
  assert.equal(await media.count("moves"),0);
  assert(await media.count("seek0") >= 179);
  await toggleAdvance(false);
  await media.read("document.querySelector('[name=mooc_no_learning]').setAttribute('name','mooc_learned')");
  await waitingForManual(media);
  assert.equal(await media.count("moves"),0);
  await toggleAdvance(true);
  await media.done();
  assert.equal(await media.count("moves"),1);
  assert(await media.count("seek1") >= 179);
  await c.send("Page.reload",{},popup);
  await until(selectedMode,v => v === "end");
  await selectPlayback("1");
  console.log("PASS playback modes, native "+native+"x, measured "+effective.toFixed(1)+"x");
  await toggleAdvance(false);
  await c.send("Page.reload",{},popup);
  await until(advanceChecked,v => v === false);
  const manual = await openCase("manualQuiz");
  assert((await manual.command("start")).ok);
  await waitingForManual(manual);
  await delay(850);
  assert.equal(await manual.count("moves"),0);
  assert.equal(await manual.count("closed"),1);
  assert.equal(await manual.count("viewed"),0);
  assert.equal(await manual.count("submits"),1);
  await manual.read("document.querySelector('.content-footer .next').click()");
  await manual.done();
  assert.equal(await manual.count("moves"),1);
  assert.equal(await manual.count("submits"),1);
  await toggleAdvance(true);
  console.log("PASS manual navigation after quiz, final lesson and saved preference");
  const award = await openCase("certificate");
  await award.read(`{
    const other = document.createElement("dialog");
    other.innerHTML = '<p>是否退出学习？</p><button aria-label="关闭">×</button>';
    other.querySelector("button").onclick = () => {sessionStorage.otherClosed = "1"; other.remove();};
    document.body.append(other);
    other.showModal();
  }`);
  assert((await award.command("start")).ok);
  await until(() => award.command("status"),r => r?.value.note.includes("请处理页面弹窗"));
  assert.equal(await award.count("otherClosed"),0);
  assert.equal(await award.count("submits"),0);
  await award.read("document.querySelector('dialog').close()");
  await award.done();
  assert.equal(await award.count("submits"),1);
  assert.equal(await award.count("closed"),2);
  assert.equal(await award.count("viewed"),0);
  assert.equal(await award.count("movedUnderDialog"),0);
  assert.equal(await award.count("moves"),1);
  console.log("PASS certificate dismissal, delayed final award and unrelated dialog");
  for (const mode of ["dynamicChecks","ignoredCheck","video","marker","retry","fail","item","image","pictureQuiz","invalid","unknown","slow"]) {
    const p = await openCase(mode);
    held = mode === "slow"; invalid = mode === "invalid";
    assert((await p.command("start")).ok);
    if (mode === "ignoredCheck") {
      const result = await p.paused();
      assert.match(result.value.note,/第 2 题.*第 1、3 项.*第 2 项/);
      assert.equal(await p.count("toggles"),1);
      assert.equal(await p.count("submits"),0);
    } else if (mode === "slow") {
      await until(() => !!releaseModel);
      assert((await p.command("pause")).ok); held = false; releaseModel();
      await delay(950); assert.equal(await p.count("submits"),0);
    } else if (mode === "unknown") {
      await until(() => p.count("submits"));
      assert((await p.command("start")).ok);
      const duplicate = await openCase(mode,mode);
      assert.equal((await duplicate.command("start")).ok,false);
      const previousDocument = await p.read("performance.timeOrigin");
      await c.send("Page.reload",{},p.session);
      await until(() => p.read("performance.timeOrigin").catch(() => 0),t => t > previousDocument);
      await until(() => p.command("status"),r => r?.value.running);
      const final = await p.paused();
      assert.match(final.value.note,/提交结果/); assert.equal(await p.count("submits"),1);
    } else if (mode === "fail" || mode === "image" || mode === "invalid") {
      const final = await p.paused();
      assert.match(final.value.note,mode === "fail" ? /仍未通过/ : mode === "image" ? /第 2 题/ : /编号无效/);
      assert.equal(await p.count("submits"),mode === "fail" ? 2 : 0);
      assert.equal(await p.count("retries"),mode === "fail" ? 1 : 0);
    } else {
      if (mode === "video") {
        await until(() => p.read("document.querySelector('video').currentTime > 0"));
        await p.read("document.querySelector('video').pause()"); await delay(850);
        assert.equal(await p.count("moves"),0);
        await p.read("document.querySelector('video').play()");
      }
      if (mode === "marker") {
        await until(() => p.command("status"),r => r?.value.note.includes("等待平台记录完成"));
        assert.equal(await p.count("moves"),0);
        await p.read("document.querySelector('[name=mooc_no_learning]').setAttribute('name','mooc_learned')");
      }
      await p.done();
      assert.equal(await p.count("moves"),1);
      if (mode === "pictureQuiz") {
        assert(requests.some(q => q.type === "多选" && q.attachments?.[0].text === "选项 2配图" &&
          q.attachments[1]?.image_url.url.startsWith("data:image/png;base64,")));
        assert.equal(await p.count("submits"),1);
      }
      if (mode === "dynamicChecks") {
        assert.equal(await p.count("toggles"),3);
        assert.equal(await p.count("submits"),1);
        assert.equal(await p.read("sessionStorage.selected"),'["0","0","2"]');
      }
      if (mode === "retry" || mode === "item") assert.equal(await p.count("submits"),2);
      if (mode === "retry") {
        assert.equal(await p.count("retries"),1);
        assert(requests.some(q => q.feedback?.includes("未通过")));
        assert.equal(await p.read("sessionStorage.selected"),'["0","0","2"]');
      }
    }
    console.log("PASS",mode);
  }
  invalid = false;
  const entry = await openCase("entry","entry","https://developer.huawei.com/consumer/cn/training/classDetail/faa734fca6dd490f9ec6981b5302f238?type=1");
  assert((await entry.command("start")).value.running);
  await c.send("Page.navigate",{url:"https://developer.huawei.com/consumer/cn/training/course/mooc/fromclass?case=video"},entry.session);
  await until(() => entry.command("status"),r => r?.value.title === "小节 0" && r.value.running);
  await entry.done();
  console.log("PASS class handoff");
  await c.send("Browser.close");
} finally {
  held = false; releaseModel?.();
  socket?.close();
  if (browser && browser.exitCode === null) {
    const exited = once(browser,"exit");
    await Promise.race([exited,delay(1000)]);
    if (browser.exitCode === null) browser.kill();
    await Promise.race([exited,delay(2000)]);
  }
  server.closeAllConnections(); server.close();
  await rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:250});
}
