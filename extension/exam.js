"use strict";
(() => {
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const visible = el => el.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  const shown = (root, selector) => [...root.querySelectorAll(selector)].filter(visible);
  const one = (root, selector) => {
    const matches = shown(root, selector);
    return matches.length === 1 ? matches[0] : null;
  };
  const words = el => (el?.innerText || el?.textContent || "").trim();
  const fail = message => { throw Error(message); };
  let page;

  function position(root) {
    const header = one(root, ".question-content .crumb");
    const match = words(header?.querySelector(".sort")).match(/^第\s*(\d+)\s*[/／]\s*(\d+)\s*题$/);
    if (!match) fail("暂时无法识别当前题号。");
    const number = Number(match[1]), total = Number(match[2]);
    if (number < 1 || number > total || total > 10000) fail("题号与试卷总数不一致。");
    return {header, number, total};
  }
  function readQuestion(root) {
    const {header, number, total} = position(root);
    const type = words(header.querySelector(":scope > span:first-child")).replace(/\s/g, "").replace(/题$/, "");
    if (!["判断","单选","单项选择","多选","多项选择"].includes(type)) fail("当前题型需要人工处理。");
    const block = one(root, ".question-item-container app-exam-item");
    const stem = block && one(block, ".item-content > p");
    const answers = block && one(block, ".item-content .answer");
    if (!stem || !answers || block.querySelector("svg:not(.anticon svg),canvas,math,iframe,video,audio,.exam-code,community-codelabels-highlight"))
      fail("题目含不支持的组件，或页面结构无法识别，请人工处理。");
    const labels = shown(answers,"label.option");
    const multiple = type.startsWith("多");
    const kind = multiple ? "checkbox" : "radio";
    const inputs = labels.map(label => label.querySelector('input[type="' + kind + '"]'));
    const {prompt,options,images,refs} = QuestionImages.inspect(stem,labels,words,"本题");
    if (shown(block,"img").some(img => !images.includes(img))) fail("无法确认图片属于题干还是选项，请人工处理。");
    const question = {type:multiple ? "多选" : type === "判断" ? "判断" : "单选", prompt,options};
    if (images.length) question.imageRefs = refs;
    if (labels.length < 2 || labels.length !== answers.querySelectorAll("input").length ||
        inputs.some(input => !input || input.disabled) || !question.prompt || question.options.some(s => !s))
      fail("无法可靠识别可选答案，请核对页面。");
    return {number,total,question,images,inputs,labels,signature:JSON.stringify([number,total,question])};
  }
  function jumpSwitch(root, type) {
    const area = one(root,".crumb .auto-jump");
    if (!area && type === "多选") return null;
    if (!area) fail("无法确认本题的自动跳题开关。");
    const control = one(area,'[role="switch"],input[type="checkbox"],button.ant-switch');
    if (!control) fail("无法读取自动跳题开关。");
    const aria = control.getAttribute("aria-checked");
    if ((aria !== null && aria !== "true" && aria !== "false") ||
        (aria === null && control.type !== "checkbox" && !control.matches(".ant-switch")))
      fail("无法确认自动跳题开关状态。");
    return {control, on:aria !== null ? aria === "true" : control.type === "checkbox" ? control.checked : control.classList.contains("ant-switch-checked")};
  }
  function ended(root) {
    return shown(document, "app-exam-result,app-exam-report,app-exam-normal-pc .result-loading").length > 0 ||
      shown(root,".tips,.tips-content,.result-loading,.exam-ended").some(el => /考试已结束|已(?:自动)?交卷|交卷成功/.test(words(el)));
  }
  function selected(q) { return q.inputs.flatMap((el,i) => el.checked ? [i+1] : []); }
  function matches(a,b) {return a.length === b.length && a.every(n => b.includes(n));}
  function missingNumbers(journal) {
    return Array.from({length:journal.total},(_,i)=>i+1).filter(n => !journal.verified[n]);
  }
  function selectionError(q, choices) {
    const actual = selected(q);
    return "AI 选择第 " + choices.join("、") + " 项，页面" +
      (actual.length ? "勾选第 " + actual.join("、") + " 项" : "尚未勾选") + "，请核对勾选状态。";
  }
  function exactNext(root) {
    const buttons = shown(root,".exam-btn-group button").filter(el =>
      words(el).replace(/\s/g,"") === "下一题" && !el.disabled && el.getAttribute("aria-disabled") !== "true" &&
      !el.classList.contains("submit-btn") && !(el.form && el.type === "submit"));
    if (buttons.length !== 1) fail("未找到唯一可用的下一题按钮，请人工核对。");
    return buttons[0];
  }
  function check(session, run) {
    if (page !== session || session.run !== run || session.key !== Study.examKey(location.href)) fail("操作已取消。");
    const root = one(document,"app-exam-normal-pc");
    if (!root || ended(root)) fail("考试已结束或答题页面已离开。");
    if (CourseUI.visibleDialogs().length) fail("请先处理平台提示，再继续作答。");
    return root;
  }
  function reread(session, run, signature) {
    const q = readQuestion(check(session,run));
    if (q.signature !== signature) fail("题目或选项已变化，已丢弃原题答案。");
    return q;
  }
  function pause(s, note) {
    s.run = null;
    s.note.textContent = note;
    s.button.textContent = "继续 AI 作答";
  }
  async function setChoices(s, run, original, choices) {
    const read = () => {
      const q = reread(s,run,original.signature);
      if (jumpSwitch(check(s,run),q.question.type)?.on) fail("自动跳题已重新开启。");
      return q;
    };
    const q = read();
    const remove = q.question.type === "多选" ? selected(q).filter(n => !choices.includes(n)) : [];
    for (const n of [...remove,...choices]) {
      const live = read(), wanted = choices.includes(n);
      if (live.inputs[n-1].checked === wanted) continue;
      live.labels[n-1].click();
      const deadline = performance.now() + 2500;
      let stable = 0;
      while (stable < 2) {
        await delay(65);
        const current = read();
        stable = current.inputs[n-1].checked === wanted ? stable + 1 : 0;
        if (performance.now() > deadline) fail(selectionError(current,choices));
      }
    }
    const final = read();
    if (!matches(selected(final),choices)) fail(selectionError(final,choices));
  }
  async function solve(s, run) {
    let number, total;
    try {
      while (s.run === run) {
        const root = check(s,run);
        const pos = position(root);
        number = pos.number;
        total = pos.total;
        if (s.journal.total !== total) s.journal = {total, verified:{}};
        const q = readQuestion(root);
        run.expected = q.signature;
        const readSwitch = () => jumpSwitch(check(s,run),q.question.type);
        const toggle = readSwitch();
        if (toggle?.on) {
          toggle.control.click();
          for (let i=0; i<20 && readSwitch()?.on; i++) await delay(75);
          reread(s,run,q.signature);
          if (readSwitch()?.on !== false) fail("自动跳题开关未关闭。");
        }
        const initial = selected(reread(s,run,q.signature));
        const fingerprint = choices => Study.digest(JSON.stringify([q.signature,[...choices].sort((a,b)=>a-b)]));
        const cached = s.journal.verified[number];
        let choices = initial;
        const existing = initial.length && await fingerprint(initial);
        reread(s,run,q.signature);
        if (!cached || cached !== existing) {
          delete s.journal.verified[number];
          sessionStorage.setItem(s.storageKey,JSON.stringify(s.journal));
          s.note.textContent = "正在回答第 " + number + " / " + q.total + " 题";
          const request = await QuestionImages.prepare(q.question,q.images);
          reread(s,run,q.signature);
          choices = Study.indices(await Study.rpc("examAnswer",{attempt:s.key,question:request}),q.question);
          reread(s,run,q.signature);
          s.note.textContent = "第 " + number + " 题 · AI 选择第 " + choices.join("、") + " 项";
          await setChoices(s,run,q,choices);
        }
        const digest = await fingerprint(choices);
        if (!matches(selected(reread(s,run,q.signature)),choices)) fail("本题勾选已发生变化。");
        s.journal.verified[number] = digest;
        sessionStorage.setItem(s.storageKey,JSON.stringify(s.journal));
        s.last.textContent = "第 " + number + " 题已核对 · 选项 " + [...choices].sort((a,b)=>a-b).join("、");
        if (number === q.total) {
          const missing = missingNumbers(s.journal);
          pause(s,missing.length ? "已到最后一题，请人工复查第 " + missing.join("、") + " 题后手动交卷。" : "已完成作答，请复查并手动交卷。");
          return;
        }
        if (readSwitch()?.on) fail("自动跳题已重新开启。");
        run.expected = null;
        exactNext(root).click();
        const deadline = performance.now()+5000;
        while (true) {
          await delay(80);
          const next = position(check(s,run));
          if (next.total !== q.total || (next.number !== number && next.number !== number+1)) fail("题号变化与预期不一致。");
          if (next.number === number+1) break;
          if (performance.now() >= deadline) fail("等待下一题超时，请核对页面。");
        }
        await delay(100);
        if (position(check(s,run)).number !== number+1) fail("当前题号已变化。");
      }
    } catch (e) {
      if (s.run === run) {
        const last = number && number === total;
        const missing = last ? missingNumbers(s.journal) : [];
        pause(s,(number ? "第 " + number + " 题 · " : "") + e.message +
          (missing.length ? " 请人工复查第 " + missing.join("、") + " 题。" : ""));
      }
    }
  }
  function makePanel(key) {
    const host = document.createElement("div");
    host.id = "study-exam-assistant";
    const shadow = host.attachShadow({mode:"open"});
    shadow.innerHTML = '<style>:host{display:block;margin:8px 0;font:14px/1.5 system-ui;color:#183d30}.bar{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:8px 12px;background:#f0f7f4;border-radius:8px}button{font:inherit;background:#165f49;color:white;border:0;border-radius:6px;padding:6px 12px;cursor:pointer}small{color:#49635a}</style><div class="bar"><button type="button">开始 AI 作答</button><span role="status"></span><small></small></div>';
    const s = {key,host,button:shadow.querySelector("button"),note:shadow.querySelector("span"),last:shadow.querySelector("small"),run:null,
      storageKey:"study:exam:1:"+key, journal:{total:0,verified:{}}};
    try {
      const stored = JSON.parse(sessionStorage.getItem(s.storageKey));
      if (stored?.verified && Number.isInteger(stored.total)) {
        s.journal = stored;
        s.button.textContent = "继续 AI 作答";
      }
    } catch { /* A missing journal starts a new local review. */ }
    s.note.textContent = s.journal.total ? "已恢复核对记录，点击继续将重新核对当前题。" : "逐题核对，最后手动交卷";
    s.button.onclick = () => {
      if (s.run) {pause(s,"已暂停"); return;}
      s.run = {expected:null};
      s.button.textContent = "暂停";
      void solve(s,s.run);
    };
    return s;
  }
  function sync() {
    const key = Study.examKey(location.href);
    if (page && page.key !== key) {page.run = null; page.host.remove(); page = null;}
    if (!key) return;
    const root = one(document,"app-exam-normal-pc");
    const crumb = root && one(root,".question-content .crumb");
    if (!crumb || ended(root)) {
      if (page?.run) pause(page,"已离开可作答页面。");
      page?.host.remove();
      return;
    }
    page ??= makePanel(key);
    if (crumb.nextElementSibling !== page.host) crumb.after(page.host);
    if (page.run?.expected) {
      try {reread(page,page.run,page.run.expected);}
      catch(e) {pause(page,e.message);}
    }
  }
  function manualInput(event) {
    if (page?.run && event.isTrusted && event.target.closest?.("app-exam-normal-pc") &&
        !event.composedPath().includes(page.host)) pause(page,"已切换为人工操作，点击继续可从当前题恢复。");
  }
  document.addEventListener("pointerdown",manualInput,true);
  document.addEventListener("keydown",manualInput,true);
  document.addEventListener("change",event => {
    if (!page || !event.target.matches?.("app-exam-normal-pc label.option input")) return;
    const root = event.target.closest("app-exam-normal-pc");
    let number;
    try {number = position(root).number;} catch {return;}
    if (page.journal.verified[number]) {
      delete page.journal.verified[number];
      sessionStorage.setItem(page.storageKey,JSON.stringify(page.journal));
      page.last.textContent = "第 " + number + " 题的勾选已更改，待重新核对。";
      if (!page.run) page.note.textContent = "请复查已更改的答案。";
    }
  },true);
  sync();
  setInterval(sync,250);
})();
