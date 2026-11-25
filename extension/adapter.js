"use strict";
globalThis.CourseUI = (() => {
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== "hidden";
  const all = (root, selector) => Array.from(root.querySelectorAll(selector)).filter(visible);
  const text = el => (el?.innerText || el?.textContent || "").trim().replace(/\s+/g, " ");
  const enabled = el => el && !el.disabled && el.getAttribute("aria-disabled") !== "true";
  const buttons = (root, pattern) => all(root, "button").filter(b => pattern.test(text(b).replace(/\s/g, "")));
  const unique = list => list.length === 1 ? list[0] : null;
  const pick = (root, pattern) => unique(buttons(root, pattern));
  function visibleDialogs() {
    const dialogs = all(document, 'dialog[open],[role="dialog"],[role="alertdialog"],.ant-modal-content,.mooc-cer,.mooc-cer-mob');
    // Ant wraps a single dialog in several matching elements.
    return dialogs.filter(el => !dialogs.some(other => other !== el && el.contains(other)));
  }
  function certificateClose(dialogs) {
    if (dialogs.length !== 1) return null;
    const dialog = dialogs[0];
    const words = text(dialog).replace(/\s/g, "");
    if (!/恭喜[！!，,]?您已获得.{1,200}证书/.test(words) ||
        !all(dialog, 'button,a,[role="button"]').some(el => text(el).replace(/\s/g, "") === "查看证书")) return null;
    return unique(all(dialog, 'button,[role="button"]').filter(el => enabled(el) && (
      el.matches("button.ant-modal-close,button[nz-modal-close]") ||
      /^(关闭|close|×|✕)$/i.test(el.getAttribute("aria-label") || el.title || text(el))
    )));
  }
  function inspect() {
    const page = Study.route(location.href);
    if (page?.kind !== "course") return {};
    const root = document.querySelector("app-mooc-detail-pc") || document;
    const menu = root.querySelector("app-mooc-menu");
    const active = menu?.querySelector(".chapter-item.actived > .chapter-wrap > .level1,.level2.actived,.level3.actived");
    const heading = root.querySelector(".chapter-title .chapter-name");
    const title = text(heading?.querySelector(":scope > span") || heading) || text(active?.querySelector(".name"));
    const quiz = root.querySelector("app-mooc-class-quiz");
    const video = unique(all(root, "app-mooc-video video, app-micro-detail video, app-video-element video"));
    const single = /\/course\/video\//.test(location.pathname);
    const lessonTitle = title || (single && video ? document.title : "");
    const group = active?.closest(".chapter-wrap");
    const outline = [text(group?.querySelector(".level1 .name")), text(group?.querySelector(".level2.actived-f .name"))];
    const chapterIds = new URL(location.href).searchParams.get("choosedChapterIds");
    const identity = lessonTitle ? JSON.stringify(chapterIds ? [page.key, chapterIds] : [page.key, ...outline, lessonTitle]) : null;
    const next = unique([...root.querySelectorAll(".content-footer button.next")].filter(b => b.hidden || visible(b)));
    const nextVideo = unique(all(root, "app-mooc-video .next-chapter button"));
    const nextCourse = unique(all(root, ".nextClass .nextClassBtn")) ||
      unique(all(root, ".nextClass a[target='_blank']")) ||
      unique(all(root, "button,a").filter(el => /^(下一课|进入下一课|下一门课程)$/.test(text(el).replace(/\s/g, ""))));
    const marker = active?.querySelector('[name="mooc_learned"],[name="mooc_no_learning"]');
    const last = !!(next?.hidden && next.disabled) || (single && !!video) ||
      (!!nextCourse && (nextCourse === next || !enabled(next)));
    const entryButtons = buttons(root, /^(开始学习|继续学习|立即学习|进入学习)$/).filter(b => !b.closest(".nextClass"));
    return {root, title: lessonTitle, identity, quiz, video, last, nextCourse, next: enabled(next) && visible(next) ? next : nextVideo,
      marked: marker ? marker.getAttribute("name") === "mooc_learned" : null,
      dialogs: visibleDialogs(),
      start: entryButtons.find(b => enabled(b) && b.matches("app-introduction button.button-wrap")) || unique(entryButtons)};
  }
  function questions(quiz) {
    const result = [];
    const blocks = all(quiz, "app-object-quiz-item,app-subject-quiz-item");
    if (!blocks.length) throw Error("练习题尚未显示。");
    const unknown = [...quiz.querySelectorAll("*")].find(el => el.localName.endsWith("-quiz-item") &&
      !el.matches("app-object-quiz-item,app-subject-quiz-item"));
    if (unknown || all(quiz, 'textarea,select,input:not([type="hidden"])').some(el =>
      !el.closest("app-object-quiz-item,app-subject-quiz-item,nz-switch"))) throw Error("本页含无法识别的答题控件，请手动核对。");
    if (quiz.querySelectorAll("app-object-quiz-item,app-subject-quiz-item").length !== blocks.length &&
        !pick(quiz, /^提交本题$/)) throw Error("整页练习中有尚未展开的题目，请展开后继续。");
    for (const [i, block] of blocks.entries()) {
      const stem = block.querySelector(".question-body");
      const group = block.querySelector(".question-options");
      const invalid = () => Error("第 " + (i + 1) + " 题含不支持的组件或选项结构无法识别，请手动处理。");
      if (!stem || !group || block.matches("app-subject-quiz-item") ||
          stem.querySelector("svg,canvas,math,video") || group.querySelector("canvas,math,video")) throw invalid();
      const labels = all(group, "label").filter(l => l.querySelector('input[type="radio"],input[type="checkbox"]'));
      const inputs = labels.map(l => l.querySelector("input"));
      const {prompt,options,refs,images} = QuestionImages.inspect(stem,labels,text,"第 " + (i+1) + " 题的");
      if (all(group,"img").some(img => !images.includes(img))) throw invalid();
      if (labels.length < 2 || labels.length !== group.querySelectorAll("input").length ||
          inputs.some(el => !enabled(el) || el.type !== inputs[0].type) || options.some(x => !x) || !prompt) throw invalid();
      result.push({prompt, type:inputs[0].type === "checkbox" ? "多选" : "单选或判断", options, inputs,images,imageRefs:refs});
    }
    return result;
  }
  function outcome(view) {
    if (!view.quiz) return "";
    if (all(view.root, ".quiz-result.failed").length) return "failed";
    if (all(view.root, ".quiz-result.pass").length) return "passed";
    const blocks = all(view.quiz, "app-object-quiz-item,app-subject-quiz-item");
    if (blocks.length && blocks.every(b => b.querySelector(".question-result .result-correct"))) return "passed";
    if (blocks.some(b => b.querySelector(".question-result .result-error"))) return "failed";
    return "";
  }
  function feedback(view) {
    return all(view.quiz, "app-object-quiz-item").filter(b => b.querySelector(".result-error")).map(b =>
      [text(b.querySelector(".question-body")), ...all(b, ".question-result,.correct-answer").map(text),
        ...all(b, "label").filter(l => l.querySelector("input:checked")).map(l => "上次选择 " + text(l))].join(" ")
    ).join("\n").slice(0, 5000) || text(view.root.querySelector(".quiz-result.failed"));
  }
  function controls(quiz) {
    return {submit:pick(quiz, /^(提交|提交答案|提交试卷|交卷|提交本题)$/),
      retry:pick(quiz, /^(再考一次|再测一次|重新测试|重新作答|重新答题|重做)$/),
      nextItem:pick(quiz, /^下一题$/)};
  }
  return {inspect, questions, controls, outcome, feedback, enabled, visibleDialogs, certificateClose};
})();
