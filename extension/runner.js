"use strict";
(() => {
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const keyOf = () => Study.route(location.href)?.key;
  let pageKey, version = 0, run;
  let latestAutoAdvance;
  let status = {running:false, note:"正在识别课程"};
  const stop = message => { throw Error(message); };
  function live(r) {
    if (r !== run || r.key !== keyOf()) stop("操作已取消。");
  }
  function call(r, type, fields) {
    live(r);
    return Study.rpc(type, {course:r.key, token:r.token, ...fields});
  }
  async function inspectCourse(r) {
    live(r);
    const view = CourseUI.inspect();
    const close = CourseUI.certificateClose(view.dialogs);
    if (!close) return view;
    status.note = "正在关闭获证提示";
    close.click();
    const deadline = performance.now() + 5000;
    while (CourseUI.visibleDialogs().includes(view.dialogs[0])) {
      if (performance.now() >= deadline) stop("获证提示仍在显示，请点击右上角的关闭按钮。");
      await sleep(100);
      live(r);
    }
    live(r);
    return CourseUI.inspect();
  }
  async function current(r) {
    live(r);
    const v = await inspectCourse(r);
    if (v.identity !== r.identity || v.dialogs.length) stop("页面已变化或出现弹窗，请核对后继续。");
    return v;
  }
  async function record(r, patch) {
    const updated = {...r.record, ...patch};
    await call(r, "record", {lesson:r.lesson, record:updated});
    live(r);
    r.record = updated;
  }
  function waitFor(r, note, timeout = 20000) {
    status.note = note;
    if (r.waitNote !== note) { r.waitNote = note; r.since = Date.now(); }
    if (Date.now() - r.since >= timeout) stop(note + "；请核对页面后继续。");
  }
  async function finish(r, type, note) {
    await call(r, type, {note});
    live(r);
    run = null;
    status = {...status, running:false, done:type === "done", note};
  }
  async function navigate(r, button, kind) {
    const mark = crypto.randomUUID();
    button.dataset.studyNavigation = mark;
    try {
      const result = await call(r, "navigate", {kind, mark});
      live(r);
      if (result.examOpen) {
        if (kind === "section") await record(r, {moving:false});
        stop("检测到考试标签页，已暂停课件导航。交卷并离开考试页后可继续。");
      }
      if (result.opened) {
        run = null;
        status = {...status, running:false, done:result.done, note:result.note};
      }
      return result;
    } finally {
      if (button.dataset.studyNavigation === mark) delete button.dataset.studyNavigation;
    }
  }
  async function advance(r, v) {
    if (r.record.moving) return waitFor(r, "已请求下一节，等待页面切换");
    if (v.last) {
      // The course schedules its certificate check after recording completion.
      r.lastSeenAt ??= Date.now();
      if (Date.now() - r.lastSeenAt < 4000) {
        status.note = "最后一节已完成，正在检查获证提示";
        return;
      }
      if (!v.nextCourse) return finish(r, "done", "已完成当前课件的最后一节。");
      if (!r.autoAdvance) {
        status.note = "当前课件已完成，等待手动进入下一课";
        return;
      }
      if (!CourseUI.enabled(v.nextCourse)) return waitFor(r, "等待下一课入口可用");
      status.note = "正在新标签页打开下一课";
      await navigate(r, v.nextCourse, "course");
      return;
    }
    if (!r.autoAdvance) {
      r.waitNote = null;
      status.note = "本节已完成，等待手动进入下一节";
      return;
    }
    if (!CourseUI.enabled(v.next)) return waitFor(r, "等待页面显示可用的下一节按钮");
    await record(r, {moving:true});
    const fresh = CourseUI.inspect();
    if (!r.autoAdvance || fresh.dialogs?.length || fresh.identity !== r.identity) {
      await record(r, {moving:false});
      return;
    }
    const next = fresh.next;
    if (!CourseUI.enabled(next)) stop("下一节按钮已变化，请手动切到下一节。");
    const result = await navigate(r, next, "section");
    if (result.cancelled) await record(r, {moving:false});
    else if (!result.opened) status.note = "正在进入下一节";
  }
  const payload = q => ({prompt:q.prompt, options:q.options, type:q.type, ...(q.imageRefs.length ? {imageRefs:q.imageRefs} : {})});
  async function samePage(r, expected) {
    const v = await current(r);
    const qs = CourseUI.questions(v.quiz);
    if (JSON.stringify(qs.map(payload)) !== expected) stop("题目或选项已经变化，请核对后继续。");
    return {v, qs};
  }
  function selectionError(index, expected, inputs) {
    const actual = inputs.flatMap((input, j) => input.checked ? [j + 1] : []);
    return "第 " + (index + 1) + " 题选项未同步。AI 选择第 " + expected.join("、") +
      " 项，页面" + (actual.length ? "选中第 " + actual.join("、") + " 项" : "尚未选中任何项") + "。";
  }
  async function selectAnswer(r, snapshot, index, answer) {
    const read = async () => (await samePage(r, snapshot)).qs[index].inputs;
    const inputs = await read();
    // Clear unwanted checks first for widgets that limit the number of selections.
    const unwanted = inputs.flatMap((input, j) =>
      input.type === "checkbox" && input.checked && !answer.includes(j + 1) ? [j + 1] : []);
    for (const number of [...unwanted, ...answer]) {
      const wanted = answer.includes(number);
      const input = (await read())[number - 1];
      if (input.checked === wanted) continue;
      input.closest("label").click();
      const deadline = performance.now() + 2000;
      let matched = false;
      while (true) {
        await sleep(60);
        const latest = await read();
        const matches = latest[number - 1].checked === wanted;
        if (matches && matched) break;
        if (performance.now() >= deadline) stop(selectionError(index, answer, latest));
        matched = matches;
      }
    }
  }
  async function solve(r, v, controls) {
    const qs = CourseUI.questions(v.quiz);
    const snapshot = JSON.stringify(qs.map(payload));
    const signature = await Study.digest(snapshot);
    const answers = [];
    for (const [i, q] of qs.entries()) {
      status.note = "AI 正在回答第 " + (i + 1) + " / " + qs.length + " 题";
      const question = await QuestionImages.prepare(payload(q),q.images);
      if (q.images.length) await samePage(r,snapshot);
      const answer = await call(r, "answer", {question, feedback:r.record.feedback || ""});
      await samePage(r, snapshot);
      answers.push(Study.indices(answer, q));
    }
    for (const [i, answer] of answers.entries()) {
      status.note = "正在核对第 " + (i + 1) + " / " + answers.length + " 题的选项";
      await selectAnswer(r, snapshot, i, answer);
    }
    const verify = async () => {
      const {v:page, qs:now} = await samePage(r, snapshot);
      for (const [i, q] of now.entries()) {
        if (q.inputs.some((input,j) => input.checked !== answers[i].includes(j + 1)))
          stop(selectionError(i, answers[i], q.inputs));
      }
      const button = CourseUI.controls(page.quiz).submit;
      if (!CourseUI.enabled(button)) stop("页面未允许提交，请核对题目。");
      return button;
    };
    await verify();
    // Write the intent before clicking. Even a process crash cannot replay this submission.
    await record(r, {pending:signature, perItem:controls.submit.textContent.trim() === "提交本题",
      itemNumber:Number(qs[0].prompt.match(/^\d+/)?.[0] || 0),
      sentAt:Date.now(), retryOpening:false});
    let button;
    try { button = await verify(); }
    catch (error) {
      // The click has not happened. The next run can safely reconcile these choices.
      await record(r, {pending:null});
      throw error;
    }
    button.click();
    status.note = "已提交，正在核对平台结果";
  }
  async function exercise(r, v) {
    const result = CourseUI.outcome(v);
    const c = CourseUI.controls(v.quiz);
    if (result === "failed") {
      if (r.record.retryOpening) return waitFor(r, "已请求重做，等待新试题");
      if (r.record.retries) stop("重试后仍未通过，已保留平台结果。");
      if (!CourseUI.enabled(c.retry)) return waitFor(r, "未通过，等待平台提供重做入口");
      await record(r, {retries:1, retryOpening:true, feedback:CourseUI.feedback(v), pending:null});
      const retryView = await current(r);
      const retry = CourseUI.controls(retryView.quiz).retry;
      if (CourseUI.outcome(retryView) !== "failed" || !CourseUI.enabled(retry)) stop("重做入口已变化，请核对页面。");
      retry.click();
      return;
    }
    if (result === "passed") {
      if (!CourseUI.enabled(c.nextItem)) return advance(r, v);
      if (r.record.itemMoving) return waitFor(r, "等待进入下一题");
      await record(r, {itemMoving:true});
      const next = CourseUI.controls((await current(r)).quiz).nextItem;
      if (!CourseUI.enabled(next)) stop("下一题按钮已变化。");
      next.click();
      return;
    }
    if (r.record.pending) {
      if (r.record.perItem && c.submit) {
        const items = CourseUI.questions(v.quiz);
        const sig = await Study.digest(JSON.stringify(items.map(payload)));
        if (sig !== r.record.pending && (r.record.itemMoving ||
            (items.length === 1 && Number(items[0].prompt.match(/^\d+/)?.[0]) === r.record.itemNumber + 1))) {
          await record(r, {pending:null, itemMoving:false});
          return;
        }
      }
      if (Date.now() - r.record.sentAt > 15000) stop("上次提交结果尚未确认，请在页面核对学习记录。");
      status.note = "上次提交结果尚未确认，等待平台反馈";
      return;
    }
    if (!c.submit) return waitFor(r, "等待可识别的练习提交按钮");
    if (r.record.itemMoving) await record(r, {itemMoving:false});
    await solve(r, v, c);
  }
  async function tick(r) {
    const v = await inspectCourse(r);
    if (v.dialogs.length) return waitFor(r, "请处理页面弹窗");
    if (!v.identity || (!v.video && !v.quiz && CourseUI.enabled(v.start))) {
      if (CourseUI.enabled(v.start) && !r.started) {
        r.started = true;
        await call(r, "check");
        live(r);
        const entry = await inspectCourse(r);
        if (!entry.dialogs.length && CourseUI.enabled(entry.start)) {
          await navigate(r, entry.start, "entry");
          if (r !== run) return;
        }
        else r.started = false;
      }
      return waitFor(r, "等待课件打开，请确认已登录并进入具体小节", 30000);
    }
    if (r.identity !== v.identity) {
      r.identity = v.identity;
      r.lesson = await Study.digest(v.identity);
      r.record = await call(r, "lesson", {lesson:r.lesson, title:v.title});
      live(r);
      status.title = v.title;
      r.waitNote = r.played = null;
      r.lastSeenAt = null;
      r.playback = new VideoPlayback();
      // Give Angular a render cycle to replace the previous lesson's controls.
      return;
    }
    if (r.record.moving) return waitFor(r, "已请求下一节，等待页面切换");
    if (v.quiz) return exercise(r, v);
    if (v.video) {
      if (v.video.ended) {
        if (v.marked === false) return waitFor(r, "播放已结束，等待平台记录完成", 45000);
        return advance(r, v);
      }
      if (v.video.error) stop("视频加载失败，请检查播放器后继续。");
      const playbackNote = r.playback.update(v.video, r.mode);
      if (r.played !== v.video && v.video.readyState >= 1) {
        r.played = v.video;
        if (v.video.paused) {
          try { await v.video.play(); }
          catch (error) {
            live(r);
            if (r.autoOpened && error.name === "NotAllowedError" && !v.video.muted && v.video.isConnected) {
              v.video.muted = true;
              try { await v.video.play(); r.mutedForAutoplay = v.video; }
              catch { v.video.muted = false; }
            }
          }
        }
        live(r);
      }
      status.note = v.video.paused ? "等待播放，请点击页面播放器" : playbackNote;
      if (!v.video.paused && r.mutedForAutoplay === v.video && v.video.muted) status.note += "（静音自动播放）";
      return;
    }
    if (v.marked === true) return advance(r, v);
    return waitFor(r, "本节暂无可操作的视频或随堂练习，请在页面完成学习");
  }
  async function loop(r) {
    try {
      while (r === run && r.key === keyOf()) {
        await tick(r);
        await sleep(r.playback?.fastForward && r.mode === 32 ? 400 : 700);
      }
    } catch (e) {
      if (r !== run || r.key !== keyOf()) return;
      try { await finish(r, "pause", e.message); }
      catch { if (r === run) {run = null; status = {...status, running:false, note:e.message};} }
    }
  }
  async function activate(type) {
    const rev = ++version;
    const key = keyOf();
    if (!key) {status = {running:false, note:"请打开班级或课件页。"}; return;}
    const info = await Study.rpc(type, {course:key});
    if (version !== rev || key !== keyOf()) return;
    if (Study.route(location.href).kind === "class") {
      status = {running:!!info.armed, note:info.armed ? "请在本班级中打开要学习的课件。" : "从这里开始，然后选择一个课件。"};
    } else if (info.running) {
      if (run?.token === info.token) return;
      run = {key, token:info.token, autoOpened:info.autoOpened, mode:Study.playbackMode(info.mode),
        autoAdvance:latestAutoAdvance ?? info.autoAdvance};
      status = {running:true, note:info.note, title:info.title};
      void loop(run);
    } else {status = {running:false, title:info.title, note:info.note, done:info.done};}
  }
  async function pause() {
    ++version;
    const old = run;
    run = null;
    const note = "已暂停";
    await Study.rpc("pause", {course:keyOf(), token:old?.token, note});
    status = {...status, running:false, note};
    if (old) CourseUI.inspect().video?.pause();
  }
  chrome.runtime.onMessage.addListener((m, sender, reply) => {
    if (m.command === "preferences" && !sender.tab) {
      if (run && m.mode !== undefined) run.mode = Study.playbackMode(m.mode);
      if (typeof m.autoAdvance === "boolean") {
        latestAutoAdvance = m.autoAdvance;
        if (run) run.autoAdvance = m.autoAdvance;
      }
      reply({ok:true});
      return;
    }
    if (!["status","start","pause"].includes(m.command) || sender.tab) return;
    if (Study.examKey(location.href)) {
      reply({ok:true,value:{exam:true,title:"考试模式",note:"请使用当前考试页题号下方的作答按钮。"}});
      return;
    }
    (async () => {
      if (m.command === "start") await activate("start");
      if (m.command === "pause") await pause();
      if (m.command === "status" && Study.route(location.href)?.kind === "class") await activate("attach");
      return status;
    })().then(value => reply({ok:true,value}), e => reply({ok:false,error:e.message}));
    return true;
  });
  function routeChanged() {
    if (pageKey === keyOf()) return;
    pageKey = keyOf();
    run = null;
    activate("attach").catch(e => {status = {running:false,note:e.message};});
  }
  routeChanged();
  setInterval(routeChanged, 500);
})();
