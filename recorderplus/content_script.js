/**
 * content_script.js — Chrome Recorder Plus
 *
 * 職責：
 * 1. 捕獲 mousedown / input / keyup 事件
 * 2. 為每個被交互元素生成與 Google Recorder 完全一致的 selectors
 *    格式：[[aria chain...], [css], [xpath], [pierce]]
 * 3. 直接同時採集座標字段（clientX/Y、pageX/Y、_coordXPath、_coordText、_coordPointText）
 *    不再需要後置 mergeCoordinates 步驟
 * 4. 響應 background 的 cr_get_viewport 請求
 */
"use strict";

(function () {
  if (window.__crPlusInjected) return;
  window.__crPlusInjected = true;

  // ── 心跳防 Service Worker 休眠 ──────────────────────────────
  setInterval(() => {
    try { chrome.runtime.sendMessage({ action: "cr_ping" }, () => { void chrome.runtime.lastError; }); }
    catch (_) {}
  }, 20000);

  function safeSend(data) {
    try {
      chrome.runtime.sendMessage({ action: "cr_record", data }, () => {
        void chrome.runtime.lastError;
      });
    } catch (_) {}
  }

  // ════════════════════════════════════════════════════════════
  //  Selector Generation
  // ════════════════════════════════════════════════════════════

  function cssEsc(id) {
    try { return CSS.escape(id); }
    catch (_) { return id.replace(/([^\w-])/g, "\\$1"); }
  }

  function isUniqueId(id) {
    if (!id) return false;
    try { return document.querySelectorAll("#" + cssEsc(id)).length === 1; }
    catch (_) { return false; }
  }

  // ── ARIA ──────────────────────────────────────────────────────

  const IMPLICIT_ROLES = {
    a: "link", button: "button", select: "listbox", textarea: "textbox",
    h1: "heading", h2: "heading", h3: "heading", h4: "heading", h5: "heading", h6: "heading",
    img: "image", svg: "image", table: "table", nav: "navigation",
    main: "main", header: "banner", footer: "contentinfo",
    form: "form", ul: "list", ol: "list", li: "listitem",
    article: "article", section: "region", dialog: "dialog",
  };
  const INPUT_ROLES = {
    checkbox: "checkbox", radio: "radio", range: "slider", search: "searchbox",
    text: "textbox", email: "textbox", password: "textbox", tel: "textbox",
    url: "textbox", number: "spinbutton", submit: "button", button: "button", reset: "button",
  };

  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return INPUT_ROLES[t] || null;
    }
    return IMPLICIT_ROLES[tag] || null;
  }

  function getAccessibleName(el) {
    const ariaLabel = el.getAttribute("aria-label");
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.trim().split(/\s+/)
        .map(id => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean).join(" ");
      if (text) return text;
    }

    const tag = el.tagName.toLowerCase();

    if (tag === "input" || tag === "textarea") {
      const ph = el.getAttribute("placeholder");
      if (ph && ph.trim()) return ph.trim();
    }

    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();

    if (tag === "img" || tag === "svg") {
      const alt = el.getAttribute("alt");
      if (alt !== null && alt.trim()) return alt.trim();
    }

    if (["button", "a", "h1", "h2", "h3", "h4", "label"].includes(tag)) {
      const text = el.textContent?.replace(/\s+/g, " ").trim();
      if (text && text.length > 0 && text.length <= 80) return text;
    }

    return null;
  }

  const FORM_INPUT_TAGS = new Set(["input", "textarea", "select"]);
  const FORM_INPUT_ROLES = new Set(["textbox", "combobox", "listbox", "spinbutton", "slider", "searchbox"]);
  function isFormInput(el) {
    if (FORM_INPUT_TAGS.has(el.tagName.toLowerCase())) return true;
    const role = el.getAttribute("role");
    return !!(role && FORM_INPUT_ROLES.has(role));
  }

  function buildAriaChain(el) {
    const name = getAccessibleName(el);
    if (name) {
      if (isFormInput(el)) {
        let dlgAnc = el.parentElement;
        for (let d = 0; d < 8 && dlgAnc && dlgAnc.tagName !== "BODY"; d++) {
          const r = dlgAnc.getAttribute("role");
          if (r === "dialog" || dlgAnc.tagName.toLowerCase() === "dialog") {
            return [`aria/[role="dialog"]`, `aria/${name}`];
          }
          dlgAnc = dlgAnc.parentElement;
        }
      }
      return [`aria/${name}`];
    }

    const role = el.getAttribute("role") || getImplicitRole(el);
    if (!role) return null;

    let ancestor = el.parentElement;
    for (let depth = 0; depth < 3 && ancestor && ancestor.tagName !== "BODY"; depth++) {
      const ancestorName = getAccessibleName(ancestor);
      if (ancestorName) {
        return [`aria/${ancestorName}`, `aria/[role="${role}"]`];
      }
      ancestor = ancestor.parentElement;
    }

    return [`aria/[role="${role}"]`];
  }

  // ── CSS Selector ──────────────────────────────────────────────

  function isSemClass(cls) {
    if (!cls || cls.length === 0 || cls.length > 40) return false;
    if (/^\d/.test(cls)) return false;
    if (/^[0-9a-f]{5,8}$/i.test(cls)) return false;
    return true;
  }

  function cssStep(node) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    const classes = [...node.classList].filter(isSemClass);

    if (classes.length > 0) {
      for (const cls of classes) {
        const sibs = parent
          ? [...parent.children].filter(s => s.tagName === node.tagName && s.classList.contains(cls))
          : [];
        if (sibs.length <= 1) return `${tag}.${cls}`;
      }
      const sibs = parent ? [...parent.children].filter(s => s.tagName === node.tagName) : [];
      if (sibs.length > 1) {
        return `${tag}.${classes[0]}:nth-of-type(${sibs.indexOf(node) + 1})`;
      }
      return `${tag}.${classes[0]}`;
    }

    if (parent) {
      const sibs = [...parent.children].filter(s => s.tagName === node.tagName);
      if (sibs.length > 1) return `${tag}:nth-of-type(${sibs.indexOf(node) + 1})`;
    }
    return tag;
  }

  function nodeStep(node) {
    if (node.id && isUniqueId(node.id)) return `#${cssEsc(node.id)}`;
    return cssStep(node);
  }

  function ok(sel) {
    try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; }
  }

  const _CSS_SKIP_IDS = new Set([
    "top", "main", "content", "wrapper", "header", "footer",
    "container", "page", "app", "root", "layout", "body",
  ]);

  const _DYNAMIC_ID_PREFIXES = [
    "_",
    "mantine-r",
    "ember",
    "p0-", "p1-",
    "headlessui-",
    "radix-",
    "floating-ui-",
  ];

  function isDynamicId(id) {
    const lower = id.toLowerCase();
    return _DYNAMIC_ID_PREFIXES.some(p => lower.startsWith(p));
  }

  const _SKIP_ANCHOR_TAGS = new Set(['ul', 'ol', 'dl', 'dd', 'dt']);
  const _INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'summary']);

  function buildCSSSelector(el) {
    if (el.id && isUniqueId(el.id)) return `#${cssEsc(el.id)}`;

    const leafTag    = el.tagName.toLowerCase();
    const leafCls    = [...el.classList].filter(isSemClass);

    function leafCandidates() {
      const v = [leafTag];
      for (const c of leafCls) v.push(`${leafTag}.${c}`);
      return v;
    }
    const lvs = leafCandidates();

    const lvs1 = _INTERACTIVE_TAGS.has(leafTag) ? lvs : [leafTag];
    for (const lv of lvs1) {
      if (ok(lv)) return lv;
    }

    let anc = el.parentElement;
    while (anc && anc.tagName !== "HTML") {
      const ancTag   = anc.tagName.toLowerCase();
      const ancS     = cssStep(anc);
      const isDirect = (anc === el.parentElement);

      const _ancHasCls = [...anc.classList].filter(isSemClass).length > 0;
      const _ancHasNth = ancS.includes(':nth-of-type');
      if (_ancHasCls && !_ancHasNth && !_SKIP_ANCHOR_TAGS.has(ancTag)) {
        if (isDirect) {
          for (const lv of lvs) {
            if (ok(`${ancS} > ${lv}`)) return `${ancS} > ${lv}`;
          }
          for (const lv of lvs) {
            if (ok(`${ancS} ${lv}`)) return `${ancS} ${lv}`;
          }
        } else {
          if (ok(`${ancS} ${leafTag}`)) return `${ancS} ${leafTag}`;
          let ancDirectChild = el;
          while (ancDirectChild.parentElement && ancDirectChild.parentElement !== anc) {
            ancDirectChild = ancDirectChild.parentElement;
          }
          if (ancDirectChild !== el) {
            const intS   = cssStep(ancDirectChild);
            const intTag = ancDirectChild.tagName.toLowerCase();
            if (ok(`${ancS} > ${intTag} ${leafTag}`)) return `${ancS} > ${intTag} ${leafTag}`;
            if (intS !== intTag && ok(`${ancS} > ${intS} ${leafTag}`)) return `${ancS} > ${intS} ${leafTag}`;
          }
        }
      }

      const ancId = anc.id;
      if (ancId && isUniqueId(ancId)
          && !_CSS_SKIP_IDS.has(ancId.toLowerCase())
          && !isDynamicId(ancId)) {
        const pfx = `#${cssEsc(ancId)}`;

        for (const lv of lvs) {
          if (ok(`${pfx} ${lv}`)) return `${pfx} ${lv}`;
        }
        if (isDirect) {
          for (const lv of lvs) {
            if (ok(`${pfx} > ${lv}`)) return `${pfx} > ${lv}`;
          }
        }
        if (el.parentElement && el.parentElement !== anc) {
          const pS   = cssStep(el.parentElement);
          const pTag = el.parentElement.tagName.toLowerCase();
          for (const lv of lvs) {
            if (ok(`${pfx} ${pTag} > ${lv}`)) return `${pfx} ${pTag} > ${lv}`;
            if (pS !== pTag && ok(`${pfx} ${pS} > ${lv}`)) return `${pfx} ${pS} > ${lv}`;
          }
          const pEl   = el.parentElement;
          const pSibs = pEl.parentElement
            ? [...pEl.parentElement.children].filter(s => s.tagName === pEl.tagName)
            : [];
          if (pSibs.length > 1) {
            const nth = `${pTag}:nth-of-type(${pSibs.indexOf(pEl) + 1})`;
            for (const lv of lvs) {
              if (ok(`${pfx} ${nth} > ${lv}`)) return `${pfx} ${nth} > ${lv}`;
            }
          }
        }
        const parts = [selfStepOf(el)];
        let cur = el.parentElement;
        while (cur && cur !== anc) {
          parts.unshift(cssStep(cur));
          cur = cur.parentElement;
        }
        return `${pfx} > ${parts.join(" > ")}`;
      }

      anc = anc.parentElement;
    }

    const parts = [selfStepOf(el)];
    if (ok(parts[0])) return parts[0];
    let cur = el.parentElement;
    while (cur && cur.tagName !== "HTML") {
      parts.unshift(nodeStep(cur));
      if (ok(parts.join(" > "))) return parts.join(" > ");
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function selfStepOf(el) {
    const tag = el.tagName.toLowerCase();
    const classes = [...el.classList].filter(isSemClass);
    const parent = el.parentElement;
    if (classes.length > 0) {
      for (const cls of classes) {
        const sibs = parent
          ? [...parent.children].filter(s => s.tagName === el.tagName && s.classList.contains(cls))
          : [];
        if (sibs.length <= 1) return `${tag}.${cls}`;
      }
      const sibs = parent ? [...parent.children].filter(s => s.tagName === el.tagName) : [];
      if (sibs.length > 1) return `${tag}.${classes[0]}:nth-of-type(${sibs.indexOf(el) + 1})`;
      return `${tag}.${classes[0]}`;
    }
    if (parent) {
      const sibs = [...parent.children].filter(s => s.tagName === el.tagName);
      if (sibs.length > 1) return `${tag}:nth-of-type(${sibs.indexOf(el) + 1})`;
    }
    return tag;
  }

  // ── XPath（Google Recorder 格式，用於 selectors 字段）─────────

  function xpathStep(el) {
    const tag = el.tagName.toLowerCase();
    const parent = el.parentElement;
    if (!parent) return tag;
    const tagSibs = [...parent.children].filter(s => s.tagName === el.tagName);
    if (tagSibs.length <= 1) return tag;
    return `${tag}[${tagSibs.indexOf(el) + 1}]`;
  }

  function xpathPathBetween(ancestor, el) {
    const parts = [];
    let cur = el;
    while (cur && cur !== ancestor) {
      parts.unshift(xpathStep(cur));
      cur = cur.parentElement;
      if (!cur) return null;
    }
    return "/" + parts.join("/");
  }

  function buildXPath(el) {
    if (el.id && isUniqueId(el.id))
      return `xpath///*[@id="${el.id}"]`;

    let ancestor = el.parentElement;
    while (ancestor && ancestor.tagName !== "HTML") {
      if (ancestor.id && isUniqueId(ancestor.id)) {
        const path = xpathPathBetween(ancestor, el);
        if (path) return `xpath///*[@id="${ancestor.id}"]${path}`;
      }
      ancestor = ancestor.parentElement;
    }

    const parts = [];
    let cur = el;
    while (cur && cur.tagName !== "HTML") {
      parts.unshift(xpathStep(cur));
      cur = cur.parentElement;
    }
    return `xpath///${parts.join("/")}`;
  }

  // ── 原始絕對 XPath（用於 _coord_xpath 字段，格式 //tag[n]/tag[n]/...）─
  // 與 Google Recorder 的 xpath/// 格式不同，此為純位置路徑供 universal_runner 備用
  function buildRawXPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur.tagName !== "BODY" && cur.tagName !== "HTML") {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent) {
        parts.unshift(tag + "[1]");
        break;
      }
      const sibs = [...parent.children].filter(s => s.tagName === cur.tagName);
      parts.unshift(tag + "[" + (sibs.indexOf(cur) + 1) + "]");
      cur = parent;
    }
    return "//" + parts.join("/");
  }

  // ── text/ selector ────────────────────────────────────────────
  function buildTextSelector(el) {
    const tag = el.tagName.toLowerCase();
    if ((tag === "input" || tag === "textarea") && el.value) {
      if ((el.getAttribute("type") || "").toLowerCase() === "file") return null;
      const v = el.value.trim();
      if (v) return `text/${v}`;
    }
    const text = el.textContent?.replace(/\s+/g, " ").trim();
    if (text && text.length > 0 && text.length <= 100) {
      return `text/${text}`;
    }
    return null;
  }

  // ── 主入口：生成 selector（與 Google Recorder 格式完全一致）────
  function generateSelectors(el) {
    const result = [];

    const aria = buildAriaChain(el);
    if (aria) result.push(aria);

    const css = buildCSSSelector(el);
    if (css) result.push([css]);

    const xpath = buildXPath(el);
    if (xpath) result.push([xpath]);

    if (css) result.push([`pierce/${css}`]);

    const text = buildTextSelector(el);
    if (text) result.push([text]);

    return result;
  }

  // ════════════════════════════════════════════════════════════
  //  Event Capture
  // ════════════════════════════════════════════════════════════

  const SVG_PRIMITIVES = new Set([
    "path", "circle", "ellipse", "rect", "line",
    "polyline", "polygon", "tspan", "use", "defs",
  ]);

  // click：mousedown 時採集（元素未消失）
  document.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    let el = e.target;
    if (!el || el.tagName === "HTML" || el.tagName === "BODY") return;

    // ① SVG primitive → 冒泡到最近的 svg 容器
    while (el && SVG_PRIMITIVES.has(el.tagName.toLowerCase())) {
      const p = el.parentElement;
      if (!p || p.tagName === "BODY") break;
      el = p;
      if (el.tagName.toLowerCase() === "svg") break;
    }

    // ② Geometric deepen：找 A/BUTTON 內的最深可見文字子元素
    if ((el.tagName === "A" || el.tagName === "BUTTON") && el.children.length > 0) {
      const _DEEPEN_TAGS = new Set(["span","em","strong","i","b","label","cite","abbr"]);
      const _allAtPt = document.elementsFromPoint(e.clientX, e.clientY);
      for (const _cand of _allAtPt) {
        if (_cand !== el && el.contains(_cand)) {
          if (!_DEEPEN_TAGS.has(_cand.tagName.toLowerCase())) continue;
          if (!_cand.textContent?.trim()) continue;
          el = _cand;
          break;
        }
      }
    }

    // ③ ContentEditable walk-up：導航到持有 contenteditable 屬性的根元素
    if (el.isContentEditable && !el.hasAttribute('contenteditable')) {
      let candidate = el.parentElement;
      while (candidate && candidate.tagName !== "BODY" && candidate.tagName !== "HTML") {
        if (candidate.hasAttribute('contenteditable')) { el = candidate; break; }
        candidate = candidate.parentElement;
      }
    }

    const selectors = generateSelectors(el);
    const rect = el.getBoundingClientRect();

    // ── 座標採集（_coordPointText 用 elementFromPoint 取鼠標正下方元素的短文本）──
    const _coordPointText = (() => {
      try {
        const pt = document.elementFromPoint(e.clientX, e.clientY);
        if (!pt) return "";
        const t = (pt.innerText || pt.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 20 && !t.includes("\n")) return t;
        return "";
      } catch (_) { return ""; }
    })();

    // ── _coordText：aria-label 或 textContent（短文本）──
    const _coordText = (() => {
      const aria = el.getAttribute?.("aria-label");
      if (aria) return aria;
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (txt && txt.length <= 40) return txt;
      return "";
    })();

    // ── _coordXPath（原始絕對路徑）──
    const _coordXPath = buildRawXPath(el);

    // ── 構建消息 ──
    const msg = {
      type:      "click",
      selectors: selectors,
      offsetY:   e.offsetY ?? Math.round(e.clientY - rect.top),
      offsetX:   e.offsetX ?? Math.round(e.clientX - rect.left),
      clientX:   Math.round(e.clientX),
      clientY:   Math.round(e.clientY),
      pageX:     Math.round(e.pageX),
      pageY:     Math.round(e.pageY),
      button:    e.button,
      buttons:   e.buttons,
      _coordXPath,
      _coordText,
      _coordPointText,
    };

    safeSend(msg);
  }, true);

  // ── input/change ──────────────────────────────────────────────
  document.addEventListener("change", (e) => {
    let el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (tag !== "select") return;

    const selectors = generateSelectors(el);
    safeSend({
      type:      "change",
      value:     el.value,
      selectors: selectors,
    });
  }, true);

  // input 事件（文字輸入）
  document.addEventListener("input", (e) => {
    let el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (tag !== "input" && tag !== "textarea") return;
    if ((el.getAttribute("type") || "").toLowerCase() === "file") return;

    const selectors = generateSelectors(el);
    safeSend({
      type:      "change",
      value:     el.value,
      selectors: selectors,
    });
  }, true);

  // ── keyUp ─────────────────────────────────────────────────────
  document.addEventListener("keyup", (e) => {
    if (e.key === "Shift" || e.key === "Control" || e.key === "Alt" || e.key === "Meta") return;
    let el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea") return; // handled by input event

    safeSend({
      type: "keyUp",
      key:  e.key,
    });
  }, true);
})();
