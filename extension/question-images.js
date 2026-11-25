"use strict";
globalThis.QuestionImages = (() => {
  function inspect(stem, labels, getText, context) {
    const images = [], refs = [];
    function describe(element, part) {
      const text = getText(element);
      for (const img of element.querySelectorAll("img")) {
        if (!img.getClientRects().length || getComputedStyle(img).visibility === "hidden") continue;
        const src = img.currentSrc || img.src;
        if (!src) throw Error(context + "图片尚未加载，请稍后继续或人工处理。");
        images.push(img);
        refs.push({part,src});
      }
      return text || (refs.some(ref => ref.part === part) ? "见配图" : "");
    }
    const prompt = describe(stem,"题干");
    const options = labels.map((label,i) => describe(label,"选项 " + (i+1)));
    return {prompt,options,images,refs};
  }

  function rasterize(img) {
    const scale = Math.min(1,2048 / Math.max(img.naturalWidth,img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1,Math.round(img.naturalWidth*scale));
    canvas.height = Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white";
    ctx.fillRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(img,0,0,canvas.width,canvas.height);
    const png = canvas.toDataURL("image/png");
    return png.length < 2*1024*1024 ? png : canvas.toDataURL("image/jpeg",0.92);
  }

  async function pixels(img, src) {
    await img.decode();
    try {return rasterize(img);}
    catch (e) {
      if (e.name !== "SecurityError") throw e;
      const copy = new Image();
      copy.crossOrigin = "anonymous";
      copy.src = src;
      await copy.decode();
      return rasterize(copy);
    }
  }

  async function prepare(question, images) {
    if (!images.length) return question;
    const {imageRefs,...data} = question;
    let timer, size = 0;
    const timeout = new Promise((_,reject) => {
      timer = setTimeout(() => reject(Error("图片加载超时，请稍后继续或人工处理。")),10000);
    });
    data.images = [];
    try {
      for (const [i,img] of images.entries()) {
        const {part,src} = imageRefs[i];
        const url = await Promise.race([pixels(img,src).catch(() => {
          throw Error(part + "的图片加载失败或禁止跨域读取，请人工处理。");
        }),timeout]);
        size += url.length;
        if (size > 12*1024*1024) throw Error("本题图片过大，请人工处理。");
        data.images.push({part,url});
      }
      return data;
    } finally {clearTimeout(timer);}
  }
  return {inspect,prepare};
})();
