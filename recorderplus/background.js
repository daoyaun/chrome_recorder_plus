/**
 * background.js — Chrome Recorder Plus Service Worker
 *
 * 職責：
 * 1. 管理錄製狀態（recording / events / startUrl）
 * 2. 監聽 chrome.tabs.onUpdated 追蹤頁面導航
 *    - 緊跟 click 的導航 → assertedEvents 附加到該 click
 *    - 無前置 click 的導航 → 插入 navigate 步驟
 * 3. 組裝最終 JSON，click 步驟含完整字段：
 *    clientX/Y、pageX/Y、_coord_match、_coord_score、_coord_event_type、
 *    _coord_xpath、_coord_text、_coord_point_text、ocr_hint
 */
"use strict";

// ── 內存狀態 ────────────────────────────────────────────────────
let recording     = false;
let events        = [];
let startUrl      = "";
let panelWindowId = null;

let lastClickIdx  = -1;
let lastNavUrl    = "";
let recordingTabId = -1;
let userTab = null;

// 防抖 flush
let flushTimer = null;
function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    chrome.storage.session.set({ recording, events, startUrl });
  }, 250);
}

// ── 啟動時從 session storage 恢復狀態 ───────────────────────────
async function restoreState() {
  const d = await chrome.storage.session.get(["recording", "events", "startUrl"]);
  if (d.recording !== undefined) recording = d.recording;
  if (Array.isArray(d.events))   events    = d.events;
  if (d.startUrl  !== undefined) startUrl  = d.startUrl;
}
restoreState();

// ── Panel 窗口管理 ───────────────────────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  userTab = tab ? { id: tab.id, url: tab.url || "", title: tab.title || "" } : null;
  openOrFocusPanel();
});

function openOrFocusPanel() {
  if (panelWindowId !== null) {
    chrome.windows.update(panelWindowId, { focused: true }, () => {
      if (chrome.runtime.lastError) { panelWindowId = null; createPanel(); }
    });
  } else {
    createPanel();
  }
}
function createPanel() {
  chrome.windows.create(
    { url: chrome.runtime.getURL("panel.html"), type: "popup", width: 380, height: 420, focused: true },
    (win) => { panelWindowId = win.id; }
  );
}
chrome.windows.onRemoved.addListener((winId) => {
  if (winId === panelWindowId) panelWindowId = null;
});
function notifyPanel(msg) {
  if (panelWindowId === null) return;
  chrome.tabs.query({ windowId: panelWindowId }, (tabs) => {
    if (!tabs?.length) return;
    chrome.tabs.sendMessage(tabs[0].id, msg, () => { void chrome.runtime.lastError; });
  });
}

// ── 導航追蹤 ────────────────────────────────────────────────────
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!recording) return;
  if (changeInfo.status !== "complete") return;

  const newUrl = tab.url || "";
  if (!newUrl || newUrl === "about:blank" || newUrl === lastNavUrl) return;
  if (newUrl.startsWith("chrome-extension://") || newUrl.startsWith("chrome://")) return;
  if (recordingTabId !== -1 && tabId !== recordingTabId) return;
  lastNavUrl = newUrl;

  const assertedEvent = {
    type:  "navigation",
    url:   newUrl,
    title: tab.title || "",
  };

  if (lastClickIdx >= 0 && lastClickIdx < events.length) {
    const lastClick = events[lastClickIdx];
    if (lastClick && lastClick.type === "click") {
      if (!lastClick.assertedEvents) lastClick.assertedEvents = [];
      lastClick.assertedEvents.push(assertedEvent);
      lastClickIdx = -1;
      scheduleFlush();
      notifyPanel({ action: "count_update", count: events.length });
      return;
    }
  }

  if (newUrl !== startUrl || events.filter(e => e.type === "navigate").length > 0) {
    events.push({
      type: "navigate",
      url:  newUrl,
      assertedEvents: [assertedEvent],
      _ts:  Date.now(),
    });
    scheduleFlush();
    notifyPanel({ action: "count_update", count: events.length });
  }
});

// ── 消息處理 ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg?.action) return false;

  if (msg.action === "cr_ping") {
    chrome.storage.session.get(["recording", "events", "startUrl"], (d) => {
      if (d.recording !== undefined) recording = d.recording;
      if (Array.isArray(d.events) && events.length === 0) events = d.events;
      if (d.startUrl  !== undefined) startUrl  = d.startUrl;
    });
    return false;
  }

  if (msg.action === "cr_record") {
    if (!recording) return false;
    const ev = { ...msg.data, _tabId: sender.tab?.id ?? -1 };
    events.push(ev);
    if (ev.type === "click") {
      lastClickIdx = events.length - 1;
      lastNavUrl = "";
    }
    scheduleFlush();
    notifyPanel({ action: "count_update", count: events.length });
    return false;
  }

  if (msg.action === "cr_status") {
    sendResponse({ recording, count: events.length, startUrl, userTab });
    return false;
  }

  if (msg.action === "cr_start") {
    const doStart = (currentTab) => {
      recording      = true;
      events         = [];
      lastClickIdx   = -1;
      startUrl       = currentTab.url  || "";
      lastNavUrl     = startUrl;
      recordingTabId = currentTab.id   || -1;

      chrome.scripting.executeScript(
        { target: { tabId: currentTab.id, allFrames: true }, files: ["content_script.js"] },
        () => { void chrome.runtime.lastError; }
      );

      chrome.scripting.executeScript(
        {
          target: { tabId: currentTab.id, frameIds: [0] },
          func: () => ({
            width:    document.documentElement.clientWidth,
            height:   document.documentElement.clientHeight,
            isMobile: /Mobi|Android/i.test(navigator.userAgent),
            hasTouch: navigator.maxTouchPoints > 0,
          })
        },
        (results) => {
          void chrome.runtime.lastError;
          const vp = results?.[0]?.result;
          if (vp && vp.width > 0) {
            events.push({
              type:              "setViewport",
              width:             vp.width,
              height:            vp.height,
              deviceScaleFactor: 1,
              isMobile:          vp.isMobile,
              hasTouch:          vp.hasTouch,
              isLandscape:       vp.width > vp.height,
            });
          }
          events.push({
            type: "navigate",
            url:  startUrl,
            assertedEvents: [{
              type:  "navigation",
              url:   startUrl,
              title: currentTab.title || "",
            }],
          });
          chrome.storage.session.set({ recording: true, events, startUrl });
          notifyPanel({ action: "count_update", count: events.length });
        }
      );
    };

    if (msg.tabId) {
      chrome.tabs.get(msg.tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) {
          doStart({ id: msg.tabId, url: msg.tabUrl || "", title: msg.tabTitle || "" });
        } else {
          doStart(tab);
        }
      });
    } else {
      doStart({ id: -1, url: msg.tabUrl || "", title: msg.tabTitle || "" });
    }

    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === "cr_stop") {
    recording = false;
    chrome.storage.session.set({ recording: false });
    sendResponse({ ok: true, count: events.length });
    return true;
  }

  if (msg.action === "cr_get_events") {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    sendResponse({ events: [...events] });
    return false;
  }

  if (msg.action === "cr_clear") {
    events = []; lastClickIdx = -1;
    chrome.storage.session.set({ events: [] });
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

// ── 從 selectors 提取 ocr_hint（取第一個 text/ 前綴的值）─────────
// 跳過純 role 模式如 "[role=button]"
function extractOcrHint(selectors) {
  for (const group of (selectors || [])) {
    const arr = Array.isArray(group) ? group : [group];
    for (const sel of arr) {
      if (typeof sel !== "string") continue;
      if (!sel.startsWith("text/")) continue;
      const h = sel.slice(5).replace(/\s+/g, " ").trim();
      if (h && !/^\[role\s*=.+\]$/i.test(h)) return h;
    }
  }
  return null;
}

// ── JSON 組裝 ────────────────────────────────────────────────────
function assembleJSON(rawEvents, title) {
  const steps = [];

  for (const ev of rawEvents) {
    const type = ev.type;

    if (type === "setViewport") {
      steps.push({
        type:              "setViewport",
        width:             ev.width,
        height:            ev.height,
        deviceScaleFactor: ev.deviceScaleFactor,
        isMobile:          ev.isMobile,
        hasTouch:          ev.hasTouch,
        isLandscape:       ev.isLandscape,
      });

    } else if (type === "navigate") {
      const step = { type: "navigate", url: ev.url };
      if (ev.assertedEvents?.length) step.assertedEvents = ev.assertedEvents;
      steps.push(step);

    } else if (type === "click") {
      const step = {
        type:      "click",
        target:    "main",
        selectors: ev.selectors || [],
        offsetY:   ev.offsetY,
        offsetX:   ev.offsetX,
      };
      if (ev.assertedEvents?.length) step.assertedEvents = ev.assertedEvents;

      // ── 座標字段（由 content_script.js 的 mousedown 直接採集）──
      if (ev.clientX !== undefined) {
        step.clientX = ev.clientX;
        step.clientY = ev.clientY;
        step.pageX   = ev.pageX;
        step.pageY   = ev.pageY;
      }

      // ── _coord_* 元數據字段 ──
      step._coord_match      = "direct";   // 直接採集，無需匹配算法
      step._coord_score      = 999;        // 最高可信度
      step._coord_event_type = "mousedown";
      if (ev._coordXPath)     step._coord_xpath       = ev._coordXPath;
      if (ev._coordText)      step._coord_text        = ev._coordText;
      if (ev._coordPointText) step._coord_point_text  = ev._coordPointText;

      // ── ocr_hint：從 selectors 的 text/ 字段提取 ──
      const ocrHint = extractOcrHint(ev.selectors);
      step.ocr_hint = ocrHint;  // null 表示無文字標識（universal_runner 會跳過 OCR 回退）

      steps.push(step);

    } else if (type === "change") {
      steps.push({
        type:      "change",
        value:     ev.value,
        selectors: ev.selectors || [],
        target:    "main",
      });

    } else if (type === "keyDown") {
      steps.push({
        type:   "keyDown",
        target: "main",
        key:    ev.key,
      });

    } else if (type === "keyUp") {
      steps.push({
        type:   "keyUp",
        key:    ev.key,
        target: "main",
      });
    }
  }

  return { title, steps };
}

// ── cr_assemble 消息（panel.js 點擊導出時調用）──────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.action === "cr_assemble") {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const json = assembleJSON(events, msg.title || buildTitle());
    sendResponse({ json });
    return false;
  }
});

function buildTitle() {
  const now = new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${now.getFullYear()}/${now.getMonth()+1}/${now.getDate()} ` +
         `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())} 录制的内容`;
}
