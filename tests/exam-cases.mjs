import assert from "node:assert/strict";

export async function testExam({openCase,c,worker,until,delay,requests,hold,release,waiting}) {
  const pages = [];
  const panel = "document.querySelector('#study-exam-assistant')?.shadowRoot";
  const label = p => p.read(panel + "?.querySelector('button').textContent");
  const note = p => p.read(panel + "?.querySelector('[role=status]').textContent");
  const press = async p => {
    await until(() => label(p));
    await p.read(panel + ".querySelector('button').click()");
  };
  async function exam(mode, total) {
    const id = 8000 + pages.length;
    const p = await openCase(mode,mode,"https://developer.huawei.com/consumer/cn/training/exam-doing/"+id+
      "?paperId=1234&authDetailId="+id+"&case="+mode+"&total="+total);
    pages.push(p);
    assert.equal(await until(() => label(p)),"开始 AI 作答");
    return p;
  }
  const expectNote = (p,part,ms) => until(() => note(p),v => v?.includes(part),ms);
  const tabs = () => c.eval(worker,"chrome.tabs.query({}).then(ts=>ts.map(t=>[t.id,t.active]))");
  try {
    const routed = await exam("route",4);
    await routed.read("history.replaceState(null,'',location.href.replace('paperId=1234','paperId=4321'));go(4)");
    await delay(400);
    await routed.read("document.body.insertAdjacentHTML('beforeend','<div role=dialog>平台提示</div>')");
    await press(routed);
    await expectNote(routed,"处理平台提示");
    await routed.read("document.querySelector('[role=dialog]').remove()");
    const {x,y} = await routed.read("(() => {const r="+panel+".querySelector('button').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()");
    for (const type of ["mousePressed","mouseReleased"])
      await c.send("Input.dispatchMouseEvent",{type,x,y,button:"left",clickCount:1},routed.session);
    await until(()=>note(routed),v=>v?.includes("复查第") || v?.includes("页面已变化"));
    assert.match(await note(routed),/复查第 1、2、3 题/);
    assert.equal(await routed.read("sessionStorage.q4"),"[1]");
    assert.equal(await routed.count("submitClicks"),0);
    console.log("PASS resume by mouse on question 4 after same-document exam route change");
    const source = await openCase("chainSource","examGuard");
    pages.push(source);
    const p = await exam("normal",50);
    await c.send("Target.activateTarget",{targetId:p.targetId});
    const initialTabs = await tabs();
    const start = requests.length;
    // Begin with an incorrect extra checkbox selected on an upcoming question.
    await p.read("sessionStorage.q3='[2]'");
    await source.command("start");
    await press(p);
    await until(() => source.command("status"),r => r?.value.note.includes("考试标签页") && !r.value.running);
    assert.equal(await source.count("courseClicks"),0);
    await expectNote(p,"已完成作答，请复查并手动交卷",75000);
    assert.deepEqual(await tabs(),initialTabs);
    const sent = requests.slice(start);
    assert.equal(sent.length,50);
    for (const [i,q] of sent.entries()) {
      assert.equal(q.question,"模拟考试题 "+(i+1));
      assert.deepEqual(Object.keys(q).sort(),["options","question","type"]);
      assert.deepEqual(await p.read("JSON.parse(sessionStorage.q"+(i+1)+")"),(i+1)%3===0 ? [1,3] : [1]);
    }
    assert.equal(await p.count("nextClicks"),49);
    assert.equal(await p.count("autoJumps"),0);
    assert.equal(await p.count("submitClicks"),0);
    const previous = await p.read("performance.timeOrigin");
    await c.send("Page.reload",{},p.session);
    await until(() => p.read("performance.timeOrigin").catch(()=>0),t=>t>previous);
    assert.equal(await until(() => label(p)),"继续 AI 作答");
    assert.equal(await p.count("index"),50);
    await press(p);
    await expectNote(p,"已完成作答");
    assert.equal(requests.length,start+50);
    assert.equal(await p.count("submitClicks"),0);
    console.log("PASS exam 50 questions, delayed checkboxes, refresh, original tab, blocked course navigation, zero submits");

    const pending = await exam("pending",4);
    hold(); await press(pending); await until(waiting);
    await press(pending); release(); await delay(350);
    assert.equal(await note(pending),"已暂停");
    assert.equal(await pending.read("sessionStorage.q1"),undefined);
    hold(); await press(pending); await until(waiting);
    await pending.read("go(2)"); release();
    await expectNote(pending,"变化");
    assert.equal(await pending.read("sessionStorage.q2"),undefined);
    hold(); await press(pending); await until(waiting);
    await pending.read("document.body.insertAdjacentHTML('beforeend','<div role=dialog>切屏提醒<button>确认</button></div>')");
    await expectNote(pending,"处理平台提示"); release(); await delay(200);
    assert.equal(await pending.read("document.querySelector('[role=dialog]').innerText.includes('切屏提醒')"),true);
    await pending.read("document.querySelector('[role=dialog]').remove()");
    hold(); await press(pending); await until(waiting);
    await pending.read("document.querySelector('.tips').textContent='考试已结束'");
    await until(() => label(pending),v=>!v);
    release(); await delay(200);
    assert.equal(await pending.read("sessionStorage.q2"),undefined);
    console.log("PASS exam stale answers after pause, manual navigation, warning, and exam end");

    const image = await exam("image",3);
    await press(image); await expectNote(image,"人工处理");
    assert.equal(await image.count("index"),2);
    await image.read("go(3)"); await press(image);
    await expectNote(image,"复查第 2 题");
    const visual = await exam("visual",1);
    const addDiagram = color => {
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = color;
      ctx.fillRect(0,0,canvas.width,canvas.height);
      const img = new Image();
      img.src = canvas.toDataURL();
      return img;
    };
    await visual.read("document.querySelector('.item-content p').replaceChildren(("+addDiagram+")('red'));"+
      "document.querySelector('label.option').lastChild.replaceWith(("+addDiagram+")('blue'));"+
      "document.querySelector('.item-content p').insertAdjacentHTML('beforeend','<span hidden><img></span>')");
    hold(); await press(visual); await until(waiting);
    const parts = requests.at(-1).attachments;
    assert.deepEqual(parts.map(p=>p.text || p.type),["题干配图","image_url","选项 1配图","image_url"]);
    assert.match(parts[1].image_url.url,/^data:image\/png;base64,/);
    assert.notEqual(parts[1].image_url.url,parts[3].image_url.url);
    await visual.read("document.querySelector('p img').src=("+addDiagram+")('green').src");
    release(); await expectNote(visual,"变化");
    assert.equal(await visual.read("sessionStorage.q1"),undefined);
    await press(visual); await expectNote(visual,"已完成作答");
    assert.equal(await visual.read("sessionStorage.q1"),"[1]");
    console.log("PASS image-only stem and option, changed diagram discards pending answer");
    const locked = await exam("locked",3);
    const beforeLocked = requests.length;
    await press(locked); await expectNote(locked,"开关未关闭");
    assert.equal(requests.length,beforeLocked);
    const ignored = await exam("ignored",4);
    await ignored.read("go(3)"); await press(ignored);
    await expectNote(ignored,"勾选状态");
    assert.equal(await ignored.count("index"),3);
    assert.equal(await ignored.count("nextClicks"),0);
    const timeout = await exam("timeout",1);
    hold(); await press(timeout); await until(waiting);
    await expectNote(timeout,"超时",52000); release();
    assert.equal(await timeout.read("sessionStorage.q1"),undefined);
    console.log("PASS exam missing questions, locked switch, unacknowledged choices and model timeout");
  } finally {
    release();
    for (const p of pages) {
      assert.equal(await p.count("submitClicks"),0);
      await c.send("Target.closeTarget",{targetId:p.targetId});
    }
  }
}
