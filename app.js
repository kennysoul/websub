// ===== State =====
let subtitles = [];
let selectedIndices = new Set();
let lastClickedIndex = -1;
let originalBaseName = '';  // filename without extension
let currentSuffix = '';
let undoStack = [];
let redoStack = [];

// ===== DOM =====
const $ = (sel) => document.querySelector(sel);
const dropZone = $('#drop-zone');
const fileInput = $('#file-input');
const editor = $('#editor');
const filenameInput = $('#filename-input');
const subCount = $('#sub-count');
const subtitleBody = $('#subtitle-body');
const undoBtn = $('#undo-btn');
const redoBtn = $('#redo-btn');
const emptyState = $('#empty-state');
const contextMenu = $('#context-menu');
const toast = $('#toast');

// ===== Encoding Detection =====
function detectEncoding(uint8Array) {
  if (uint8Array.length < 2) return 'utf-8';
  // UTF-8 BOM
  if (uint8Array[0] === 0xEF && uint8Array[1] === 0xBB && uint8Array[2] === 0xBF) return 'utf-8';
  // UTF-16 BE BOM
  if (uint8Array[0] === 0xFE && uint8Array[1] === 0xFF) return 'utf-16be';
  // UTF-16 LE BOM
  if (uint8Array[0] === 0xFF && uint8Array[1] === 0xFE) return 'utf-16le';
  return null;
}

function isLikelyValidChineseText(text) {
  if (!text || text.length === 0) return false;
  const cjkRegex = /[\u4e00-\u9fff\u3400-\u4dbf]/;
  const hasCJK = cjkRegex.test(text);
  if (!hasCJK) return true;
  const replacementCount = (text.match(/\uFFFD/g) || []).length;
  const invalidControl = (text.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g) || []).length;
  const totalLen = text.length;
  return replacementCount / totalLen < 0.01 && invalidControl / totalLen < 0.01;
}

function decodeText(uint8Array) {
  const bomEncoding = detectEncoding(uint8Array);
  if (bomEncoding === 'utf-16be') {
    return new TextDecoder('utf-16be').decode(uint8Array.slice(2));
  }
  if (bomEncoding === 'utf-16le') {
    return new TextDecoder('utf-16le').decode(uint8Array.slice(2));
  }

  let text = new TextDecoder('utf-8', { fatal: false }).decode(uint8Array);
  if (isLikelyValidChineseText(text)) return text;

  try {
    const gbkText = new TextDecoder('gbk').decode(uint8Array);
    if (isLikelyValidChineseText(gbkText)) return gbkText;
  } catch (e) { /* GBK not supported */ }

  try {
    const big5Text = new TextDecoder('big5').decode(uint8Array);
    if (isLikelyValidChineseText(big5Text)) return big5Text;
  } catch (e) { /* Big5 not supported */ }

  return text;
}

// ===== File Import =====
dropZone.addEventListener('click', () => fileInput.click());
$('#file-btn').addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
$('#import-another-btn').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => { if (e.target.files.length) handleFile(e.target.files[0]); });

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', (e) => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});

function handleFile(file) {
  originalBaseName = file.name.replace(/\.[^.]+$/, '');
  currentSuffix = '';
  filenameInput.value = originalBaseName;
  const ext = file.name.split('.').pop().toLowerCase();
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const uint8Array = new Uint8Array(e.target.result);
      const text = decodeText(uint8Array);
      subtitles = parseSubtitle(text, ext);
      selectedIndices.clear();
      lastClickedIndex = -1;
      undoStack = [];
      redoStack = [];
      updateUndoRedoButtons();
      showEditor();
      showToast(`已导入 ${subtitles.length} 条字幕`);
    } catch (err) { showToast('解析失败: ' + err.message, true); }
  };
  reader.readAsArrayBuffer(file);
}

function showEditor() {
  dropZone.classList.add('hidden');
  editor.classList.remove('hidden');
  updateSubCount();
  renderTable();
}

function updateSubCount() {
  subCount.textContent = `${subtitles.length} 条字幕`;
}

function getExportFilename() {
  const name = filenameInput.value.trim() || originalBaseName || 'subtitles';
  return name + '.srt';
}

// ===== Suffix Dropdown =====
$('#suffix-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  $('#suffix-menu').classList.toggle('hidden');
});

$('#suffix-menu').querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    const suffix = btn.dataset.suffix;
    // Remove old suffix, add new
    let name = filenameInput.value.trim();
    if (currentSuffix && name.endsWith(currentSuffix)) {
      name = name.slice(0, -currentSuffix.length);
    }
    currentSuffix = suffix;
    filenameInput.value = name + suffix;
    $('#suffix-menu').classList.add('hidden');
  });
});

// ===== Parsers =====
function parseSubtitle(text, ext) {
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  switch (ext) {
    case 'srt': return parseSRT(text);
    case 'ass': case 'ssa': return parseASS(text);
    case 'vtt': return parseVTT(text);
    case 'sub': return parseSUB(text);
    default: throw new Error('不支持的格式: ' + ext);
  }
}

function parseSRT(text) {
  const blocks = text.trim().split(/\n\n+/);
  const result = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) continue;
    const idx = lines.indexOf(timeLine);
    const [s, e] = timeLine.split('-->').map(t => t.trim());
    result.push({ startTime: srtTimeToMs(s), endTime: srtTimeToMs(e), text: lines.slice(idx + 1).join('\n') });
  }
  return result;
}

function parseASS(text) {
  const result = [];
  const lines = text.split('\n');
  let inEvents = false, formatFields = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase() === '[events]') { inEvents = true; continue; }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) { inEvents = false; continue; }
    if (!inEvents) continue;
    if (trimmed.toLowerCase().startsWith('format:')) {
      formatFields = line.substring(line.indexOf(':') + 1).split(',').map(f => f.trim().toLowerCase());
      continue;
    }
    if (!trimmed.toLowerCase().startsWith('dialogue:') && !trimmed.toLowerCase().startsWith('comment:')) continue;
    if (!formatFields) continue;
    const fields = splitAssFields(line.substring(line.indexOf(':') + 1), formatFields.length);
    const si = formatFields.indexOf('start'), ei = formatFields.indexOf('end'), ti = formatFields.indexOf('text');
    if (si < 0 || ei < 0 || ti < 0) continue;
    result.push({
      startTime: assTimeToMs(fields[si].trim()),
      endTime: assTimeToMs(fields[ei].trim()),
      text: (fields[ti] || '').replace(/\\N/gi, '\n').replace(/\\n/gi, '\n'),
    });
  }
  return result;
}

function splitAssFields(line, count) {
  const fields = []; let cur = '', n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ',' && n < count - 1) { fields.push(cur); cur = ''; n++; } else { cur += line[i]; }
  }
  fields.push(cur);
  return fields;
}

function parseVTT(text) {
  const blocks = text.replace(/^WEBVTT[^\n]*\n*/i, '').trim().split(/\n\n+/);
  const result = [];
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const timeLine = lines.find(l => l.includes('-->'));
    if (!timeLine) continue;
    const idx = lines.indexOf(timeLine);
    const [s, e] = timeLine.split('-->').map(t => t.trim().split(' ')[0]);
    result.push({ startTime: vttTimeToMs(s), endTime: vttTimeToMs(e), text: lines.slice(idx + 1).join('\n') });
  }
  return result;
}

function parseSUB(text) {
  const result = [], fps = 25;
  for (const line of text.trim().split('\n')) {
    const m = line.match(/^\{(\d+)\}\{(\d+)\}(.*)$/);
    if (!m) continue;
    result.push({
      startTime: Math.round(parseInt(m[1]) / fps * 1000),
      endTime: Math.round(parseInt(m[2]) / fps * 1000),
      text: m[3].replace(/\|/g, '\n'),
    });
  }
  return result;
}

// ===== Time Utils =====
function srtTimeToMs(str) {
  const m = str.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return 0;
  return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + parseInt(m[4].padEnd(3, '0').slice(0, 3));
}
function assTimeToMs(str) {
  const m = str.match(/(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return 0;
  return (+m[1]) * 3600000 + (+m[2]) * 60000 + (+m[3]) * 1000 + parseInt(m[4].padEnd(3, '0').slice(0, 3));
}
function vttTimeToMs(str) {
  const parts = str.split(':');
  if (parts.length === 3) return srtTimeToMs(str.replace('.', ','));
  if (parts.length === 2) {
    const [min, secMs] = parts;
    const [sec, ms] = secMs.split('.');
    return (+min) * 60000 + (+sec) * 1000 + parseInt((ms || '0').padEnd(3, '0').slice(0, 3));
  }
  return 0;
}
function msToSrtTime(ms) {
  if (ms < 0) ms = 0;
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000),
        s = Math.floor((ms % 60000) / 1000), mil = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad3(mil)}`;
}
function pad(n) { return String(n).padStart(2, '0'); }
function pad3(n) { return String(n).padStart(3, '0'); }

// ===== Tag Removal =====
function stripTags(text) {
  return text.replace(/\{[^}]*\}/g, '').replace(/<[^>]+>/g, '').trim();
}

// ===== Render Table =====
function renderTable() {
  subtitleBody.innerHTML = '';
  if (subtitles.length === 0) { emptyState.classList.remove('hidden'); return; }
  emptyState.classList.add('hidden');

  const frag = document.createDocumentFragment();
  subtitles.forEach((sub, i) => {
    const tr = document.createElement('tr');
    tr.dataset.index = i;
    if (selectedIndices.has(i)) tr.classList.add('selected');

    // Row click for selection
    tr.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Only trigger selection on left-click
      // Don't interfere with contenteditable cells
      if (e.target.contentEditable === 'true') return;
      handleRowSelect(i, e);
    });

    // Index
    const tdIdx = document.createElement('td');
    tdIdx.className = 'cell-index';
    tdIdx.textContent = i + 1;
    tr.appendChild(tdIdx);

    // Start
    const tdStart = document.createElement('td');
    tdStart.className = 'cell-time';
    tdStart.contentEditable = 'true';
    tdStart.textContent = msToSrtTime(sub.startTime);
    tdStart.addEventListener('mousedown', (e) => e.stopPropagation());
    tdStart.addEventListener('focus', () => {
      tdStart._prevVal = tdStart.textContent.trim();
    });
    tdStart.addEventListener('blur', () => {
      const val = tdStart.textContent.trim();
      if (val !== tdStart._prevVal) {
        saveState();
        subtitles[i].startTime = srtTimeToMs(val);
        tdStart.textContent = msToSrtTime(subtitles[i].startTime);
      }
    });
    tr.appendChild(tdStart);

    // End
    const tdEnd = document.createElement('td');
    tdEnd.className = 'cell-time';
    tdEnd.contentEditable = 'true';
    tdEnd.textContent = msToSrtTime(sub.endTime);
    tdEnd.addEventListener('mousedown', (e) => e.stopPropagation());
    tdEnd.addEventListener('focus', () => {
      tdEnd._prevVal = tdEnd.textContent.trim();
    });
    tdEnd.addEventListener('blur', () => {
      const val = tdEnd.textContent.trim();
      if (val !== tdEnd._prevVal) {
        saveState();
        subtitles[i].endTime = srtTimeToMs(val);
        tdEnd.textContent = msToSrtTime(subtitles[i].endTime);
      }
    });
    tr.appendChild(tdEnd);

    // Text
    const tdText = document.createElement('td');
    tdText.className = 'cell-text';
    tdText.contentEditable = 'true';
    tdText.textContent = sub.text;
    tdText.addEventListener('mousedown', (e) => e.stopPropagation());
    tdText.addEventListener('focus', () => {
      tdText._prevVal = tdText.textContent;
    });
    tdText.addEventListener('blur', () => {
      const val = tdText.textContent;
      if (val !== tdText._prevVal) {
        saveState();
        subtitles[i].text = val;
      }
    });
    tr.appendChild(tdText);

    frag.appendChild(tr);
  });
  subtitleBody.appendChild(frag);
}

// ===== Row Selection =====
function handleRowSelect(index, e) {
  if (e.metaKey || e.ctrlKey) {
    // Toggle single
    if (selectedIndices.has(index)) selectedIndices.delete(index);
    else selectedIndices.add(index);
    lastClickedIndex = index;
  } else if (e.shiftKey && lastClickedIndex >= 0) {
    // Range select
    const from = Math.min(lastClickedIndex, index);
    const to = Math.max(lastClickedIndex, index);
    for (let i = from; i <= to; i++) selectedIndices.add(i);
  } else {
    // Single select
    selectedIndices.clear();
    selectedIndices.add(index);
    lastClickedIndex = index;
  }
  updateSelectionUI();
}

function selectAll() {
  selectedIndices.clear();
  for (let i = 0; i < subtitles.length; i++) selectedIndices.add(i);
  updateSelectionUI();
}

function updateSelectionUI() {
  subtitleBody.querySelectorAll('tr').forEach(tr => {
    const idx = parseInt(tr.dataset.index);
    tr.classList.toggle('selected', selectedIndices.has(idx));
  });
}

// ===== Context Menu =====
subtitleBody.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const tr = e.target.closest('tr');
  let clickedIndex = tr ? parseInt(tr.dataset.index) : -1;

  // If right-clicked on unselected row, select only that row
  // If right-clicked on already-selected row, keep current multi-selection
  if (clickedIndex >= 0 && !selectedIndices.has(clickedIndex)) {
    selectedIndices.clear();
    selectedIndices.add(clickedIndex);
    lastClickedIndex = clickedIndex;
    updateSelectionUI();
  }

  // Update delete count
  $('#ctx-delete-count').textContent = selectedIndices.size;
  $('#ctx-delete').style.display = selectedIndices.size > 0 ? '' : 'none';

  showContextMenu(e.clientX, e.clientY, clickedIndex);
});

// Also allow right-click on empty table area
$('.table-container').addEventListener('contextmenu', (e) => {
  if (e.target.closest('tbody') || e.target.closest('thead')) return;
  e.preventDefault();
  showContextMenu(e.clientX, e.clientY, -1);
});

function showContextMenu(x, y, clickedIndex) {
  contextMenu.classList.remove('hidden');
  // Position
  const menuW = contextMenu.offsetWidth, menuH = contextMenu.offsetHeight;
  if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
  contextMenu.style.left = x + 'px';
  contextMenu.style.top = y + 'px';
  contextMenu._clickedIndex = clickedIndex;
}

function hideContextMenu() { contextMenu.classList.add('hidden'); }
document.addEventListener('click', hideContextMenu);
document.addEventListener('scroll', hideContextMenu, true);

// Context menu actions
$('#ctx-insert-above').addEventListener('click', () => {
  const idx = contextMenu._clickedIndex;
  openInsertModal(idx >= 0 ? idx : 0, 'above');
});

$('#ctx-insert-below').addEventListener('click', () => {
  const idx = contextMenu._clickedIndex;
  openInsertModal(idx >= 0 ? idx : subtitles.length - 1, 'below');
});

$('#ctx-select-all').addEventListener('click', selectAll);

$('#ctx-delete').addEventListener('click', () => {
  if (selectedIndices.size === 0) return;
  saveState();
  const sorted = [...selectedIndices].sort((a, b) => b - a);
  sorted.forEach(i => subtitles.splice(i, 1));
  const count = sorted.length;
  selectedIndices.clear();
  lastClickedIndex = -1;
  updateSubCount();
  renderTable();
  showToast(`已删除 ${count} 条字幕`);
});

// ===== Insert Modal =====
let insertPosition = 0; // the index to insert at

function openInsertModal(refIndex, direction) {
  insertPosition = direction === 'above' ? refIndex : refIndex + 1;
  const ref = subtitles[refIndex];
  let startMs, endMs;
  if (direction === 'above') {
    endMs = ref ? ref.startTime : 3000;
    startMs = Math.max(0, endMs - 3000);
  } else {
    startMs = ref ? ref.endTime + 100 : 0;
    endMs = startMs + 3000;
  }
  $('#add-start').value = msToSrtTime(startMs);
  $('#add-end').value = msToSrtTime(endMs);
  $('#add-text').value = '';
  $('#add-modal-title').textContent = direction === 'above' ? '在上方插入字幕' : '在下方插入字幕';
  openModal('add-modal');
  setTimeout(() => $('#add-text').focus(), 100);
}

$('#apply-add').addEventListener('click', () => {
  const startMs = srtTimeToMs($('#add-start').value);
  const endMs = srtTimeToMs($('#add-end').value);
  const text = $('#add-text').value.trim();
  if (!text) { showToast('请输入字幕内容', true); return; }
  if (endMs <= startMs) { showToast('结束时间必须大于开始时间', true); return; }
  saveState();
  subtitles.splice(insertPosition, 0, { startTime: startMs, endTime: endMs, text });
  selectedIndices.clear();
  selectedIndices.add(insertPosition);
  lastClickedIndex = insertPosition;
  updateSubCount();
  renderTable();
  closeModal('add-modal');
  showToast('已插入字幕');
});

// ===== Remove Tags =====
$('#remove-tags-btn').addEventListener('click', () => {
  let count = 0;
  const indices = selectedIndices.size > 0 ? [...selectedIndices] : subtitles.map((_, i) => i);
  
  // Track if any changes actually happen
  let changed = false;
  indices.forEach(i => {
    const cleaned = stripTags(subtitles[i].text);
    if (cleaned !== subtitles[i].text) {
      if (!changed) { saveState(); changed = true; }
      count++;
      subtitles[i].text = cleaned;
    }
  });

  if (changed) {
    renderTable();
    const scope = selectedIndices.size > 0 ? `所选 ${indices.length} 条中的` : '';
    showToast(`已清除 ${scope}${count} 条字幕的特效标签`);
  } else {
    showToast('无需清除特效标签');
  }
});

// ===== Timeline Adjustment =====
$('#timeline-btn').addEventListener('click', () => {
  $('#offset-input').value = '0';
  $('#scale-input').value = '1.0';
  $('#scope-sel-count').textContent = selectedIndices.size;
  // Disable selected/before/after if nothing selected
  const hasSelection = selectedIndices.size > 0;
  document.querySelectorAll('input[name="scope"]').forEach(r => {
    if (r.value !== 'all') {
      r.disabled = !hasSelection;
      r.closest('.scope-option').style.opacity = hasSelection ? 1 : 0.4;
    }
  });
  if (!hasSelection) $('input[name="scope"][value="all"]').checked = true;
  openModal('timeline-modal');
});

$('#offset-minus').addEventListener('click', () => { const i = $('#offset-input'); i.value = parseInt(i.value || 0) - 100; });
$('#offset-plus').addEventListener('click', () => { const i = $('#offset-input'); i.value = parseInt(i.value || 0) + 100; });

$('#apply-timeline').addEventListener('click', () => {
  const offset = parseInt($('#offset-input').value) || 0;
  const scale = parseFloat($('#scale-input').value) || 1.0;
  if (offset === 0 && scale === 1.0) { closeModal('timeline-modal'); return; }

  const scope = $('input[name="scope"]:checked').value;
  const targetIndices = getTargetIndices(scope);
  if (targetIndices.length === 0) { showToast('没有可调整的字幕', true); return; }

  saveState();

  // Find anchor for scaling (first target subtitle)
  const anchor = subtitles[targetIndices[0]].startTime;

  targetIndices.forEach(i => {
    if (scale !== 1.0) {
      subtitles[i].startTime = anchor + (subtitles[i].startTime - anchor) * scale;
      subtitles[i].endTime = anchor + (subtitles[i].endTime - anchor) * scale;
    }
    subtitles[i].startTime = Math.round(subtitles[i].startTime + offset);
    subtitles[i].endTime = Math.round(subtitles[i].endTime + offset);
  });

  renderTable();
  closeModal('timeline-modal');
  const parts = [];
  if (offset !== 0) parts.push(`偏移 ${offset > 0 ? '+' : ''}${offset}ms`);
  if (scale !== 1.0) parts.push(`缩放 ${scale}x`);
  const scopeLabels = { all: '全部', selected: `所选 ${targetIndices.length} 条`, before: '所选及之前', after: '所选及之后' };
  showToast(`${scopeLabels[scope]}: ${parts.join(', ')}`);
});

function getTargetIndices(scope) {
  if (scope === 'all') return subtitles.map((_, i) => i);
  if (selectedIndices.size === 0) return subtitles.map((_, i) => i);

  const selSorted = [...selectedIndices].sort((a, b) => a - b);
  const minSel = selSorted[0], maxSel = selSorted[selSorted.length - 1];

  if (scope === 'selected') return selSorted;
  if (scope === 'before') {
    const result = [];
    for (let i = 0; i <= maxSel; i++) result.push(i);
    return result;
  }
  if (scope === 'after') {
    const result = [];
    for (let i = minSel; i < subtitles.length; i++) result.push(i);
    return result;
  }
  return [];
}

// ===== Export SRT =====
$('#export-btn').addEventListener('click', () => {
  if (subtitles.length === 0) { showToast('没有字幕可导出', true); return; }
  const sorted = [...subtitles].sort((a, b) => a.startTime - b.startTime);
  let output = '';
  sorted.forEach((sub, i) => {
    output += `${i + 1}\n${msToSrtTime(sub.startTime)} --> ${msToSrtTime(sub.endTime)}\n${stripTags(sub.text).replace(/\n{2,}/g, '\n')}\n\n`;
  });
  downloadFile(output, getExportFilename(), 'text/plain;charset=utf-8');
  showToast('已导出: ' + getExportFilename());
});

function downloadFile(content, filename, type) {
  const blob = new Blob(['\ufeff' + content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===== Modal =====
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }
document.querySelectorAll('[data-modal]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.modal));
});
document.querySelectorAll('.modal-overlay').forEach(overlay => {
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.classList.add('hidden'); });
});

// ===== Toast =====
let toastTimer;
function showToast(msg, isError = false) {
  clearTimeout(toastTimer);
  toast.textContent = msg;
  toast.className = 'toast show' + (isError ? ' error' : '');
  toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 2500);
}

// ===== Undo / Redo =====
function saveState() {
  undoStack.push(JSON.stringify(subtitles));
  redoStack = [];
  updateUndoRedoButtons();
}

function undo() {
  if (undoStack.length === 0) return;
  redoStack.push(JSON.stringify(subtitles));
  subtitles = JSON.parse(undoStack.pop());
  selectedIndices.clear();
  lastClickedIndex = -1;
  updateSubCount();
  renderTable();
  updateUndoRedoButtons();
  showToast('已撤销');
}

function redo() {
  if (redoStack.length === 0) return;
  undoStack.push(JSON.stringify(subtitles));
  subtitles = JSON.parse(redoStack.pop());
  selectedIndices.clear();
  lastClickedIndex = -1;
  updateSubCount();
  renderTable();
  updateUndoRedoButtons();
  showToast('已重做');
}

function updateUndoRedoButtons() {
  undoBtn.disabled = undoStack.length === 0;
  redoBtn.disabled = redoStack.length === 0;
}

undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

// ===== Global Keys =====
document.addEventListener('keydown', (e) => {
  // Escape: close modals & context menu
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    hideContextMenu();
  }
  // Ctrl+Z / Cmd+Z: Undo / Redo (Shift+Z)
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    if (e.shiftKey) {
      redo();
    } else {
      undo();
    }
  }
  // Ctrl+Y / Cmd+Y: Redo
  if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    redo();
  }
  // Ctrl+A: select all (only when not editing)
  if ((e.ctrlKey || e.metaKey) && e.key === 'a') {
    const active = document.activeElement;
    if (active && (active.contentEditable === 'true' || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    if (editor.classList.contains('hidden')) return;
    e.preventDefault();
    selectAll();
  }
  // Delete/Backspace: delete selected
  if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIndices.size > 0) {
    const active = document.activeElement;
    if (active && (active.contentEditable === 'true' || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    saveState();
    const sorted = [...selectedIndices].sort((a, b) => b - a);
    sorted.forEach(i => subtitles.splice(i, 1));
    const count = sorted.length;
    selectedIndices.clear();
    updateSubCount();
    renderTable();
    showToast(`已删除 ${count} 条字幕`);
  }
});

// ===== Close suffix dropdown on outside click =====
document.addEventListener('click', (e) => {
  if (!e.target.closest('.suffix-dropdown')) {
    $('#suffix-menu').classList.add('hidden');
  }
});
