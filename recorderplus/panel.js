/**
 * panel.js — Chrome Recorder Plus
 */
"use strict";

const dot       = document.getElementById("dot");
const statusEl  = document.getElementById("status");
const countEl   = document.getElementById("count");
const btnStart  = document.getElementById("btnStart");
const btnStop   = document.getElementById("btnStop");
const btnOutput = document.getElementById("btnOutput");
const msgEl     = document.getElementById("msg");
const domainBar = document.getElementById("domainBar");
const preview   = document.getElementById("preview");

let isRecording = false;
let stepCount   = 0;

function showMsg(text, isErr = false) {
  msgEl.textContent = text;
  msgEl.className = "msg" + (isErr ? " err" : "");
}

function setUI(recording, count = 0) {
  isRecording = recording;
  stepCount   = count;
  countEl.textContent = String(count);

  if (recording) {
    dot.className        = "dot recording";
    statusEl.textContent = "● 录制中...";
    statusEl.className   = "status rec";
    btnStart.disabled    = true;
    btnStop.disabled     = false;
    btnOutput.disabled   = true;
  } else {
    dot.className        = "dot";
    statusEl.textContent = "空闲，等待开始录制";
    statusEl.className   = "status";
    btnStart.disabled    = false;
    btnStop.disabled     = true;
    btnOutput.disabled   = count === 0;
  }
}

function send(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (resp) => {
      resolve(resp || null);
    });
  });
}

// ── 初始化：恢复状态 ─────────────────────────────────────────────
(async () => {
  const status = await send({ action: "cr_status" });
  if (status) setUI(status.recording, status.count);
  if (status?.startUrl) {
    try { domainBar.textContent = "🌐 " + new URL(status.startUrl).hostname; }
    catch (_) {}
  }
})();

// ── 开始录制 ─────────────────────────────────────────────────────
btnStart.addEventListener("click", async () => {
  // 優先使用 background 在 action.onClicked 時捕獲的用戶 tab
  // 避免查詢到面板自身的 chrome-extension:// tab
  const status2 = await send({ action: "cr_status" });
  let tab = status2?.userTab || null;

  // 備用：查詢所有 active tabs，過濾掉擴充套件頁面
  if (!tab) {
    const tabs = await chrome.tabs.query({ active: true }).catch(() => []);
    const found = tabs.find(t => t.url &&
      !t.url.startsWith("chrome-extension://") &&
      !t.url.startsWith("chrome://") &&
      !t.url.startsWith("about:"));
    if (found) tab = { id: found.id, url: found.url, title: found.title || "" };
  }
  if (!tab) { showMsg("未找到活动标签页，请先打开目标网页", true); return; }

  const resp = await send({
    action:   "cr_start",
    tabId:    tab.id,     // background 会用 chrome.tabs.get 取最新 URL
    tabUrl:   tab.url   || "",
    tabTitle: tab.title || "",
  });

  if (resp?.ok) {
    setUI(true, 1); // navigate 步骤计1
    preview.innerHTML = "";
    try { domainBar.textContent = "🌐 " + new URL(tab.url).hostname; }
    catch (_) { domainBar.textContent = ""; }
    showMsg("");
    appendPreviewStep({ type: "navigate", url: tab.url });
  } else {
    showMsg("启动失败，请重试", true);
  }
});

// ── 停止录制 ─────────────────────────────────────────────────────
btnStop.addEventListener("click", async () => {
  const resp = await send({ action: "cr_stop" });
  if (resp?.ok) {
    setUI(false, resp.count);
    showMsg(`录制完成，共 ${resp.count} 个事件`);
  }
});

// ── 导出 JSON ────────────────────────────────────────────────────
btnOutput.addEventListener("click", async () => {
  const title = buildTitle();
  const resp  = await send({ action: "cr_assemble", title });
  if (!resp?.json) { showMsg("导出失败：无事件数据", true); return; }

  const blob = new Blob(
    [JSON.stringify(resp.json, null, 4)],
    { type: "application/json" }
  );
  const url  = URL.createObjectURL(blob);
  const safe = title.replace(/[/\\:*?"<>|]/g, "_");

  await chrome.downloads.download({ url, filename: safe + ".json", saveAs: true });
  URL.revokeObjectURL(url);
  showMsg(`已导出：${title}.json`);
});

// ── 接收 background 的实时更新 ────────────────────────────────────
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "count_update") {
    stepCount = msg.count;
    countEl.textContent = String(msg.count);
    if (!isRecording) btnOutput.disabled = msg.count === 0;
  }
  // 实时预览最新步骤（由 cr_record 传来的摘要）
  if (msg.action === "step_preview" && msg.step) {
    appendPreviewStep(msg.step);
  }
});

// ── 步骤预览渲染 ─────────────────────────────────────────────────
const TYPE_CLASS = {
  navigate:    "t-nav",
  click:       "t-click",
  change:      "t-change",
  keyUp:       "t-key",
  setViewport: "t-vp",
};

function appendPreviewStep(ev) {
  if (!ev?.type) return;
  const div = document.createElement("div");
  div.className = "step";

  let text = "";
  if (ev.type === "navigate")    text = `🔗 navigate  ${shortUrl(ev.url)}`;
  else if (ev.type === "click")  text = `🖱 click     sel:${selectorSummary(ev.selectors)}`;
  else if (ev.type === "change") text = `✏️ change    "${ev.value?.slice(0, 20) || ""}"`;
  else if (ev.type === "keyUp")  text = `⌨️ keyUp     ${ev.key}`;
  else if (ev.type === "setViewport") text = `📐 viewport  ${ev.width}×${ev.height}`;
  else text = ev.type;

  div.innerHTML = `<span class="${TYPE_CLASS[ev.type] || ""}">${esc(text)}</span>`;
  preview.appendChild(div);
  preview.scrollTop = preview.scrollHeight;

  // 超过 200 行删最早的
  while (preview.children.length > 200) {
    preview.removeChild(preview.firstChild);
  }
}

function shortUrl(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.slice(0, 30);
  } catch (_) { return (url || "").slice(0, 40); }
}

function selectorSummary(selectors) {
  if (!selectors?.length) return "(none)";
  const first = selectors[0];
  if (Array.isArray(first) && first.length > 0) return first[0].slice(0, 30);
  return String(first).slice(0, 30);
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildTitle() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()} ` +
         `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} 录制的内容`;
}
