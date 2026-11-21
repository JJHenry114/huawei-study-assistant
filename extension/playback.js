"use strict";

// One controller per lesson. Only the runner decides when the lesson is complete.
globalThis.VideoPlayback = class {
  update(video, mode) {
    if (video.readyState < 1) return "正在读取视频时长";
    if (this.video !== video || this.src !== video.currentSrc || this.mode !== mode) {
      this.video = video;
      this.src = video.currentSrc;
      this.mode = mode;
      this.seekTarget = null;
      this.seekError = false;
      this.fastForward = false;
      const requested = mode === "end" ? 1 : mode;
      try { video.playbackRate = requested; }
      catch (error) {
        // Some native media engines reject 32x but accept 16x.
        if (requested === 32 && error.name === "NotSupportedError") {
          try {
            video.playbackRate = 16;
            this.fastForward = video.playbackRate === 16;
          } catch { /* Report the actual native speed below. */ }
        }
      }
      this.lastTime = video.currentTime;
      this.lastTick = performance.now();
    }
    if (mode === "end") return this.toLastSecond(video);
    if (this.fastForward && video.playbackRate === 16) return this.forward32(video);
    return (video.playbackRate === mode ? "" : "已选 " + mode + "×，实际 ") + video.playbackRate + "× 播放";
  }

  canSeek(video, target) {
    const ranges = video.seekable;
    for (let i = 0; i < ranges.length; i++) {
      if (target >= ranges.start(i) && target <= ranges.end(i)) return true;
    }
    return false;
  }

  toLastSecond(video) {
    if (!Number.isFinite(video.duration) || video.duration <= 0) return "等待视频提供可定位的时长";
    const target = Math.max(0, video.duration - 1);
    if (video.currentTime >= target) return "正在播放最后一秒";
    if (this.seekError || (this.seekTarget !== null && !video.seeking))
      return "播放器未保留末尾位置，继续从当前位置播放";
    if (video.seeking) return "正在定位到最后一秒";
    if (!this.canSeek(video, target)) return "末尾暂不可定位，继续播放";
    try {
      this.seekTarget = target;
      video.currentTime = target;
    } catch { this.seekError = true; return "播放器未接受跳转，继续播放"; }
    return "正在定位到最后一秒";
  }

  forward32(video) {
    const now = performance.now();
    const elapsed = Math.max(0, (now - this.lastTick) / 1000);
    const current = video.currentTime;
    const played = current - this.lastTime;
    // Cap each step so a suspended tab never makes a large catch-up jump.
    const target = Math.min(video.duration - 1, this.lastTime + Math.min(elapsed, 1) * 32);
    this.lastTick = now;
    this.lastTime = current;
    if (this.seekTarget !== null && !video.seeking && current + 0.1 < this.seekTarget)
      this.seekError = true;
    if (this.seekError) return "播放器未接受快进，实际 16× 播放";
    if (!video.paused && !video.seeking && video.readyState >= 3 && played > 0 && target > current) {
      if (!this.canSeek(video, target)) return "当前区间无法快进，实际 16× 播放";
      try {
        video.currentTime = target;
        this.seekTarget = target;
        this.lastTime = target;
      } catch { this.seekError = true; return "播放器未接受快进，实际 16× 播放"; }
    }
    return "约 32× 快进（16× 播放加分段跳转）";
  }
};
