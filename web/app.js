/**
 * 【06 · 网页交互】在浏览器中运行，不要作为 Python 文件单独运行。
 * 输入：用户点击/提问/选文件，以及 serve.py 返回的 /api/ JSON。
 * 输出：图谱、文档、问答结果和来源弹窗；模型并不在这里运行。
 * 阅读顺序：状态与请求 → 页面切换 → 数据展示 → 问答 → PDF 导入 → 事件绑定。
 * 配套：index.html 管页面结构，styles.css 管页面外观。
 */
"use strict";

// 一、基础工具：选择页面元素、转义文本、绘制图标。
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  chat: '<path d="M20 11.5a7.8 7.8 0 0 1-.9 3.7 8 8 0 0 1-7.1 4.3 7.8 7.8 0 0 1-3.7-.9L3 20l1.4-5.3a7.8 7.8 0 0 1-.9-3.7 8 8 0 0 1 4.3-7.1 7.8 7.8 0 0 1 3.7-.9h.5a8 8 0 0 1 8 8z"/>',
  graph: '<path d="m7 6 10 6M7 18l10-6"/><circle cx="5" cy="5" r="3"/><circle cx="19" cy="12" r="3"/><circle cx="5" cy="19" r="3"/>',
  document: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 12h8M8 16h6"/>',
  layers: '<path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5"/>',
  shield: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6l8-4Z"/><path d="m8 12 3 3 5-6"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4M12 17h.01"/>',
  settings: '<path d="m9 3 6 0 .6 2.3 2 .9 2.2-.7 3 5.2-1.7 1.6v2.3l1.7 1.6-3 5.2-2.2-.7-2 .9L15 24H9l-.6-2.3-2-.9-2.2.7-3-5.2 1.7-1.6v-2.3L1.2 10.8l3-5.2 2.2.7 2-.9L9 3Z" transform="translate(1 0) scale(.9)"/><circle cx="12" cy="12" r="3"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 6a8 8 0 0 1 13 3M18 18A8 8 0 0 1 5 15"/>',
  "arrow-up-right": '<path d="M6 18 18 6M6 6h12v12"/>',
  "arrow-right": '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  "arrow-up": '<path d="M12 20V4m-6 6 6-6 6 6"/>',
  focus: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/><circle cx="12" cy="12" r="4"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-5 5-5 13 0 18 5-5 5-13 0-18Z"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="1"/>',
  maximize: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
};
const icon = name => `<span data-icon="${name}"><svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.graph}</svg></span>`;
function hydrateIcons(root = document) {
  $$('[data-icon]', root).forEach(element => {
    if (!element.firstElementChild) element.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[element.dataset.icon] || paths.graph}</svg>`;
  });
}

// 中文别名只改变显示，不修改 GraphRAG 原始实体名与分类。
const aliases = {
  "CHINA": "中国", "SHENZHEN": "深圳", "BEIJING": "北京", "HANGZHOU": "杭州",
  "HUAWEI TECHNOLOGIES CO., LTD.": "华为", "ALIBABA GROUP HOLDINGS LTD.": "阿里巴巴",
  "TENCENT HOLDINGS LTD.": "腾讯", "BYTEDANCE TECHNOLOGY CO., LTD.": "字节跳动",
  "REN ZHENGFEI": "任正非", "MA YUN": "马云", "MA HUATENG": "马化腾", "ZHANG YIMING": "张一鸣",
  "ZHONGGUAN CUN SCIENCE AND TECHNOLOGY INDUSTRIAL PARK": "中关村科技园",
  "GUANGDONG-HONGKONG-MACAU BAY AREA": "粤港澳大湾区", "ZHEJIANG UNIVERSITY": "浙江大学",
  "MICROSOFT CORPORATION": "微软",
};
const reportAliases = {
  "Hangzhou and Alibaba Group Holdings Ltd.": "杭州与阿里巴巴",
  "Huawei Technologies Co., Ltd. Community": "华为的技术与产业网络",
  "Shenzhen Innovation Ecosystem - Tencent Holdings Ltd. and Ma Huateng": "深圳、腾讯与马化腾",
  "ByteDance Community": "字节跳动与内容生态",
};
const label = title => aliases[title] || title;
const kind = type => ({ ORGANIZATION: "org", PERSON: "person", GEO: "geo" }[type] || "other");
const typeName = type => ({ ORGANIZATION: "组织", PERSON: "人物", GEO: "地点", EVENT: "事件" }[type] || type || "待核对分类");
// 二、页面状态。state.data 是知识库数据；state.conversation 是当前问答。
const state = { data: null, health: null, method: "local", route: "ask", selected: null, currentJob: null, timer: null,
  zoom: 1, pan: {x: 0, y: 0}, conversation: [], history: [], activeDocument: null, submitting: false };
const HISTORY_KEY = "graphrag-workbench-history-v1";
let toastTimer;

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $("#toast").hidden = true; }, 4200);
}

async function request(url, options = {}) {
  // 所有网页请求的共同入口：连不到后台或返回错误时，给出中文提示。
  let response;
  try { response = await fetch(url, options); }
  catch { throw new Error("本地网页服务未连接。请在 PyCharm 中运行 serve.py，然后刷新页面。"); }
  let body;
  try { body = await response.json(); }
  catch { throw new Error("服务返回了无法读取的结果，请查看 PyCharm 终端。"); }
  if (!response.ok) throw new Error(body.error || "请求未完成，请重试。");
  return body;
}
const post = (url, data) => request(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(data)});

async function refresh() {
  // 向后台读取真实索引，更新数量、图谱、文档列表和社区报告。
  $("#error-banner").hidden = true;
  try {
    state.data = await request("/api/overview");
    $$('[data-count]').forEach(element => { element.textContent = state.data.counts[element.dataset.count] ?? "…"; });
    renderGraphs(); renderEntityList(); renderDocuments(); renderReports(); renderPreviews();
    if (!state.data.ready && !$("#detail-dialog").open) toast("知识库尚未构建索引。导入 PDF 或 TXT 后，可在原始文档页面更新索引。");
  } catch (error) {
    $("#error-banner").textContent = error.message;
    $("#error-banner").hidden = false;
  }
}

async function refreshHealth() {
  try {
    state.health = await request("/api/health");
    const online = state.health.online;
    $("#status-dot").className = "status-indicator " + (online ? "online" : "offline");
    $("#model-status-text").textContent = online ? `${state.health.chat_model} · 本地` : "本地模型未就绪";
    $("#model-status").title = state.health.message;
  } catch {
    $("#model-status-text").textContent = "本地服务未连接";
    $("#status-dot").className = "status-indicator offline";
  }
}

// 三、页面与检索模式切换。地址中的 #ask/#graph 等决定当前显示区域。
function setRoute() {
  const target = location.hash.slice(1) || "ask";
  state.route = ["ask", "graph", "documents", "reports"].includes(target) ? target : "ask";
  $$(".view").forEach(view => { const active = view.id === `view-${state.route}`; view.hidden = !active; view.classList.toggle("active", active); });
  $$("[data-route]").forEach(link => {
    const active = link.dataset.route === state.route;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  $("#page-title").textContent = {ask:"知识问答", graph:"知识图谱", documents:"原始文档", reports:"社区报告"}[state.route];
  if (state.route === "documents" && state.data?.documents.length && !state.activeDocument) openDocument(state.data.documents[0].name);
  if (state.route === "graph" && state.selected) selectEntity(state.selected);
  window.scrollTo({top: 0, behavior: "instant"});
}

function setMode(method) {
  // Local 针对具体实体；Global 针对全库主题。这里只设置模式，不立即查询。
  state.method = method === "global" ? "global" : "local";
  $$("[data-mode]").forEach(button => { const active = button.dataset.mode === state.method; button.classList.toggle("selected", active); button.setAttribute("aria-pressed", String(active)); });
  $("#mode-description").textContent = state.method === "local" ? "围绕具体实体，查找相关关系与原文。" : "跨社区阅读，归纳知识库中的共同主题。";
}

const previewPositions = {
  "HUAWEI TECHNOLOGIES CO., LTD.": [252, 155, 28], "ALIBABA GROUP HOLDINGS LTD.": [390, 94, 21],
  "TENCENT HOLDINGS LTD.": [416, 232, 23], "BYTEDANCE TECHNOLOGY CO., LTD.": [155, 269, 19],
  "REN ZHENGFEI": [105, 93, 9], "SHENZHEN": [283, 292, 10], "HANGZHOU": [490, 67, 8],
  "MA YUN": [359, 29, 8], "MA HUATENG": [508, 203, 8], "ZHANG YIMING": [57, 304, 8], "BEIJING": [51, 220, 8],
};
const fullPositions = {
  "HUAWEI TECHNOLOGIES CO., LTD.": [444, 268, 30], "ALIBABA GROUP HOLDINGS LTD.": [660, 199, 24],
  "TENCENT HOLDINGS LTD.": [584, 442, 25], "BYTEDANCE TECHNOLOGY CO., LTD.": [280, 468, 24],
  "REN ZHENGFEI": [374, 139, 13], "SHENZHEN": [615, 324, 15], "HANGZHOU": [797, 174, 12],
  "MA YUN": [695, 82, 13], "MA HUATENG": [729, 511, 13], "ZHANG YIMING": [206, 565, 13],
  "BEIJING": [145, 441, 13], "CHINA": [809, 412, 14], "ZHEJIANG UNIVERSITY": [123, 151, 13],
  "ZHONGGUAN CUN SCIENCE AND TECHNOLOGY INDUSTRIAL PARK": [144, 265, 17],
  "GUANGDONG-HONGKONG-MACAU BAY AREA": [786, 570, 13],
  "ZHIHUO KUAIYUN INFRASTRUCTURE": [249, 230, 12], "MICROSOFT CORPORATION": [528, 101, 12],
  "SINOMICRO ELECTRONICS CORP. LTD.": [352, 365, 12],
  'BAIDU\'S "WENXIN YIYAN" LARGE MODEL AND SENSENOVA PLATFORM': [244, 79, 12],
};

// 四、索引可视化：把实体与关系画成 SVG，并绑定点击、缩放和拖动。
function renderGraph(svg, preview) {
  const {entities, relationships} = state.data;
  const layout = preview ? previewPositions : fullPositions;
  const nodes = entities.filter(entity => !preview || layout[entity.title]);
  const positions = new Map(nodes.map((entity, index) => [entity.title, layout[entity.title] || [450 + 300 * Math.cos(index * 2.4), 320 + 230 * Math.sin(index * 2.4), 12]]));
  const edges = relationships.filter(edge => positions.has(edge.source) && positions.has(edge.target));
  const links = edges.map(edge => {
    const a = positions.get(edge.source), b = positions.get(edge.target);
    return `<line class="graph-link" data-source="${escapeHTML(edge.source)}" data-target="${escapeHTML(edge.target)}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"><title>${escapeHTML(edge.description)}</title></line>`;
  }).join("");
  const circles = nodes.map((entity, index) => {
    const [x,y,r] = positions.get(entity.title);
    let title = label(entity.title);
    if (title.length > 23) title = title.slice(0, 20) + "…";
    return `<g transform="translate(${x} ${y})"><g class="graph-node ${kind(entity.type)} ${preview ? "preview-node" : ""}" data-entity="${escapeHTML(entity.id)}" role="button" tabindex="0" aria-label="查看${escapeHTML(label(entity.title))}的关系" style="--delay:${index * 55}ms"><circle r="${r}"/><text y="${r + 23}">${escapeHTML(title)}</text><title>${escapeHTML(entity.title)} · ${escapeHTML(typeName(entity.type))}</title></g></g>`;
  }).join("");
  svg.innerHTML = `<g class="graph-transform">${links}${circles}</g>`;
  $$("[data-entity]", svg).forEach(node => {
    const activate = () => { state.selected = node.dataset.entity; if (preview) location.hash = "graph"; selectEntity(node.dataset.entity); };
    node.addEventListener("click", activate);
    node.addEventListener("keydown", event => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); activate(); } });
  });
}
function renderGraphs() { renderGraph($("#preview-svg"), true); renderGraph($("#full-graph"), false); applyGraphTransform(); }
function applyGraphTransform() { const group = $("#full-graph .graph-transform"); if (group) group.setAttribute("transform", `translate(${state.pan.x} ${state.pan.y}) translate(450 320) scale(${state.zoom}) translate(-450 -320)`); }

function selectEntity(id) {
  // 点击节点后，展示它的描述、相邻关系和实际关联原文。
  const entity = state.data?.entities.find(item => item.id === id);
  if (!entity) return;
  state.selected = id;
  const relationships = state.data.relationships.filter(item => item.source === entity.title || item.target === entity.title);
  const neighbors = new Set([entity.title, ...relationships.flatMap(item => [item.source, item.target])]);
  $$("#full-graph .graph-node").forEach(node => {
    const record = state.data.entities.find(item => item.id === node.dataset.entity);
    node.classList.toggle("selected", record?.id === id); node.classList.toggle("muted", !neighbors.has(record?.title));
  });
  $$("#full-graph .graph-link").forEach(edge => edge.classList.toggle("muted", edge.dataset.source !== entity.title && edge.dataset.target !== entity.title));
  $("#entity-detail").innerHTML = `${icon("graph")}<h2>${escapeHTML(label(entity.title))}</h2><p class="entity-original">${escapeHTML(entity.title)}</p><span class="entity-type">${escapeHTML(typeName(entity.type))}</span><p>${escapeHTML(entity.description || "此实体缺少描述。请对照原文核查抽取结果。")}</p><h3>${relationships.length} 条关联关系</h3>${relationships.map(edge => { const other = edge.source === entity.title ? edge.target : edge.source; const record = state.data.entities.find(item => item.title === other); return `<div class="relationship-item"><button data-neighbor="${escapeHTML(record?.id || "")}">${escapeHTML(label(entity.title))} ↔ ${escapeHTML(label(other))}</button><p>${escapeHTML(edge.description)}</p></div>`; }).join("") || '<p>当前索引中没有与此实体相连的关系。</p>'}<button class="source-link" id="entity-source-button">阅读关联原文 ↗</button>`;
  $$("[data-neighbor]", $("#entity-detail")).forEach(button => button.addEventListener("click", () => selectEntity(button.dataset.neighbor)));
  $("#entity-source-button").addEventListener("click", () => {
    const unit = state.data.text_units.find(item => (entity.text_unit_ids || []).includes(item.id));
    if (unit) showDialog("关联原文", `<p class="original-text">${escapeHTML(unit.text)}</p>`);
    else toast("当前实体没有可回溯的文本片段，请核对原始文档。");
  });
}

function renderEntityList() {
  if (!state.data) return;
  const search = $("#entity-search").value.trim().toLowerCase();
  const entities = state.data.entities.filter(entity => `${entity.title} ${label(entity.title)}`.toLowerCase().includes(search));
  $("#entity-list").innerHTML = entities.map(entity => `<button class="entity-pill ${kind(entity.type)}" data-entity-index="${escapeHTML(entity.id)}"><i aria-hidden="true"></i>${escapeHTML(label(entity.title))}</button>`).join("") || '<p class="history-empty">没有匹配的实体，换个名称试试。</p>';
  $$("[data-entity-index]").forEach(button => button.addEventListener("click", () => { selectEntity(button.dataset.entityIndex); $("#full-graph").scrollIntoView({behavior:"smooth", block:"center"}); }));
}

// 五、文档阅读。PDF 展示逐页提取文字，原始 PDF 可另行下载核对。
function renderDocuments() {
  if (!state.data) return;
  $("#document-list").innerHTML = state.data.documents.map(document => `<button class="document-item ${state.activeDocument === document.name ? "active" : ""}" data-document="${escapeHTML(document.name)}">${icon("document")}<span><strong>${escapeHTML(document.display_name || document.name)}</strong><small>${escapeHTML(document.format || "TXT")}${document.page_count ? ` · ${document.page_count} 页` : ""} · ${((document.source_size || document.size) / 1024).toFixed(1)} KB<br>${document.indexed ? "已建索引" : "待更新索引"}</small></span></button>`).join("") || '<p class="history-empty">还没有文档。点击“导入文档”开始。</p>';
  $$("[data-document]").forEach(button => button.addEventListener("click", () => openDocument(button.dataset.document)));
  if (state.route === "documents" && !state.activeDocument && state.data.documents.length) openDocument(state.data.documents[0].name);
}
async function openDocument(name) {
  // 从后台按文件名读取文档；不在浏览器里直接访问磁盘目录。
  try {
    const doc = await request(`/api/documents/${encodeURIComponent(name)}`);
    state.activeDocument = name;
    const pdf = doc.format === "PDF";
    $("#document-reader").innerHTML = `<h2>${escapeHTML(doc.display_name || doc.name)}</h2><p class="doc-meta">${pdf ? `PDF 提取文字 · ${doc.page_count} 页 · 不是原始排版` : "原始资料 · UTF-8 TXT"} · ${((doc.source_size || doc.size) / 1024).toFixed(1)} KB</p>${pdf ? `<a class="pdf-original-link" href="/api/originals/${encodeURIComponent(doc.name)}" download>${icon("download")}下载原始 PDF</a>${pdfWarnings(doc.warnings)}${pdfPages(doc.pages)}` : `<div class="original-text">${escapeHTML(doc.text)}</div>`}`;
    hydrateIcons($("#document-reader"));
    renderDocuments();
  } catch (error) { toast(error.message); }
}

function markdown(text) {
  // 先转义 HTML，再支持有限的 Markdown；不直接执行模型输出的 HTML。
  let value = escapeHTML(text);
  value = value.replace(/\[Data:\s*([^\]]+)\]/g, (_, citation) => `<button class="citation-button" data-citation="${citation}">[${citation}]</button>`);
  value = value.replace(/^###\s+(.+)$/gm, "<h3>$1</h3>").replace(/^##?\s+(.+)$/gm, "<h2>$1</h2>");
  value = value.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  value = value.split(/\n\s*\n/).map(block => /^<h[23]>/.test(block) ? block : `<p>${block.replace(/\n/g, "<br>")}</p>`).join("");
  return value;
}

function renderReports() {
  // 社区报告来自 output/community_reports.parquet，不是预先编造的示例。
  if (!state.data) return;
  $("#reports-list").innerHTML = state.data.reports.map((report, index) => `<details class="report-card" ${index === 0 ? "open" : ""}><summary><span class="report-symbol">${icon("graph")}</span><span><h2>${escapeHTML(reportAliases[report.title] || report.title)}</h2><p class="report-meta">${escapeHTML(report.title)} · ${report.size ?? "未知数量"} 个实体</p></span><span class="report-arrow">${icon("chevron")}</span></summary><div class="report-body">${markdown(report.full_content || report.summary || "报告尚无内容。")}</div></details>`).join("") || '<p class="history-empty">构建索引后，这里会显示生成的社区报告。</p>';
  $$("[data-citation]", $("#reports-list")).forEach(button => button.addEventListener("click", () => showReportCitation(button.dataset.citation)));
}

function renderPreviews() {
  // 首页片段必须按 document_ids 匹配来源，不能误用新导入但尚未索引的文档。
  const unit = state.data.text_units[0];
  const source = state.data.documents.find(document => (unit?.document_ids || []).includes(document.id));
  $("#source-preview").innerHTML = unit ? `<p class="preview-file">${escapeHTML(source?.display_name || source?.name || "已索引原文")}</p><p>${escapeHTML(unit.text.slice(0, 180))}${unit.text.length > 180 ? "…" : ""}</p>` : "<p>导入文档并构建索引后，这里会显示真实原文片段。</p>";
  const edges = state.data.relationships.filter(edge => aliases[edge.source] && aliases[edge.target]).slice(0, 5);
  $("#relations-preview").innerHTML = edges.length ? edges.map(edge => `<div class="relation-preview-row" title="${escapeHTML(edge.description)}"><span>${escapeHTML(label(edge.source))}</span><span aria-label="关联">↔</span><span>${escapeHTML(label(edge.target))}</span></div>`).join("") : "<p>当前尚无已抽取的关系。</p>";
  const report = state.data.reports[0];
  $("#community-preview").innerHTML = report ? `<strong>${escapeHTML(reportAliases[report.title] || report.title)}</strong><p>${escapeHTML((report.summary || "").slice(0, 420))}${(report.summary || "").length > 420 ? "…" : ""}</p>` : "<p>社区报告会在索引构建后生成。</p>";
}
function showReportCitation(citation) {
  const ids = [...citation.matchAll(/\d+/g)].map(match => Number(match[0]));
  const table = /relationship/i.test(citation) ? state.data.relationships : state.data.entities;
  const selected = table.filter(row => ids.includes(Number(row.human_readable_id)));
  showDialog("社区报告引用", selected.length ? selected.map(row => `<article class="source-record"><strong>${escapeHTML(row.title || `${label(row.source)} ↔ ${label(row.target)}`)}</strong><p>${escapeHTML(row.description)}</p></article>`).join("") : '<p>这条引用未匹配到现有索引记录，请结合原文核对。</p>');
}

function showDialog(title, content) {
  $("#dialog-title").textContent = title;
  $("#dialog-content").innerHTML = content;
  hydrateIcons($("#dialog-content"));
  if (!$("#detail-dialog").open) $("#detail-dialog").showModal();
}

function showSettings() {
  const health = state.health;
  showDialog("本地知识空间", `<dl class="settings-grid"><dt>项目</dt><dd>graphrag-study</dd><dt>聊天模型</dt><dd>${escapeHTML(health?.chat_model || "正在读取")}</dd><dt>向量模型</dt><dd>${escapeHTML(health?.embedding_model || "正在读取")}</dd><dt>模型接口</dt><dd>${escapeHTML(health?.api_base || "正在读取")}</dd><dt>模型状态</dt><dd>${escapeHTML(health?.message || "正在检查")}</dd><dt>知识存储</dt><dd>Parquet + LanceDB</dd><dt>导入格式</dt><dd>文字型 PDF：10 MB / 100 页；UTF-8 TXT：2 MB。PDF 提取文字不超过 2 MB；扫描件需先做 OCR。</dd></dl><p>配置来自项目的 settings.yaml。修改配置后刷新网页即可重新读取。</p><p>图谱展示的是模型抽取结果，包含尚未核对的分类与关系，请结合原文判断。</p>`);
}

function showGuide() {
  showDialog("从文档，到答案", `<p>在“原始文档”导入 PDF 或 TXT。PDF 会先逐页提取文字，核对预览后点击“确认导入”；原 PDF 会保留，可随时下载核对。当前不识别扫描图片、图表或复杂表格排版。</p><p>确认文档后，点击“更新索引”。GraphRAG 会调用本地模型，抽取实体关系并生成社区报告。仅上传或预览，不会让新资料立即参与问答。</p><p>在“知识问答”输入问题。局部检索适合具体人物、公司与关系；全局检索适合归纳整个知识库的主题。</p><p>在“知识图谱”点击节点，核对模型抽取的描述和关联原文。社区报告由模型生成，也需要依据原文核实。</p><h3>在 PyCharm 中启动</h3><pre><code>source .venv/bin/activate\npython serve.py</code></pre><p>在浏览器打开终端显示的本机地址。问答需要 Ollama 保持运行，浏览已有图谱不需要启动模型。</p>`);
}

// 六、提问历史与答案展示。历史保存在当前浏览器，不由后台写入磁盘。
function loadHistory() {
  try { const data = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); state.history = Array.isArray(data) ? data.slice(0, 8) : []; }
  catch { state.history = []; }
  renderHistory();
}
function renderHistory() {
  $("#history-list").innerHTML = state.history.map((item, index) => `<button class="history-item" data-history="${index}" title="${escapeHTML(item.query)}">${escapeHTML(item.query)}</button>`).join("") || '<p class="history-empty">你的探索，从一个问题开始</p>';
  $$("[data-history]").forEach(button => button.addEventListener("click", () => {
    if (state.currentJob || state.submitting) return toast("请先等待或停止当前查询。");
    const item = state.history[Number(button.dataset.history)];
    state.conversation = [item]; setMode(item.method); location.hash = "ask"; renderConversation();
  }));
}

function renderConversation() {
  const hasMessages = state.conversation.length > 0;
  $("#welcome").hidden = hasMessages; $("#suggestions").hidden = hasMessages; $("#conversation").hidden = !hasMessages;
  $("#conversation").innerHTML = state.conversation.map((item, index) => `<div class="message message-question"><div class="question-bubble">${escapeHTML(item.query)}</div></div><article class="message message-answer"><div class="answer-header"><span class="answer-mark">${icon("graph")}</span>GraphRAG<small>${item.method === "global" ? "全局检索 · Global" : "局部检索 · Local"}</small></div>${item.status === "running" ? `<div class="pending-answer" role="status"><span class="loading-ring" aria-hidden="true"></span><span>${item.method === "global" ? "正在阅读社区报告，归纳答案" : "正在检索实体关系，生成答案"}</span><small id="query-elapsed">本地模型处理中</small></div>` : item.error ? `<p class="answer-error">${escapeHTML(item.error)}</p>` : `<div class="answer-body">${markdown(item.answer || "")}</div><div class="answer-sources">${Object.entries(item.context || {}).filter(([, rows]) => Array.isArray(rows) && rows.length).map(([name,rows]) => `<button class="source-chip" data-source-index="${index}" data-source-name="${escapeHTML(name)}">${({sources:"原文片段",entities:"实体",relationships:"关系",reports:"社区报告",claims:"主张"}[name] || name)} ${rows.length}</button>`).join("")}</div><div class="answer-actions"><button data-copy="${index}">${icon("copy")}复制</button><button data-download="${index}">${icon("download")}保存回答</button><span class="history-empty">${item.elapsed ? `${item.elapsed} 秒 · ` : ""}请结合来源核对</span></div>`}</article>`).join("");
  $$("[data-source-index]").forEach(button => button.addEventListener("click", () => showContext(Number(button.dataset.sourceIndex), button.dataset.sourceName)));
  $$(".message-answer").forEach((article, index) => $$("[data-citation]", article).forEach(button => button.addEventListener("click", () => showContext(index, null, button.dataset.citation))));
  $$("[data-copy]").forEach(button => button.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.conversation[Number(button.dataset.copy)].answer); toast("回答已复制"); }
    catch { toast("浏览器未允许复制，请直接选中答案复制。"); }
  }));
  $$("[data-download]").forEach(button => button.addEventListener("click", () => {
    const item = state.conversation[Number(button.dataset.download)];
    const url = URL.createObjectURL(new Blob([`# ${item.query}\n\n${item.answer}\n\n检索方式：${item.method}\n`], {type:"text/markdown;charset=utf-8"}));
    const link = document.createElement("a"); link.href = url; link.download = "GraphRAG回答.md"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
}

function showContext(index, requestedName, citation) {
  // 按“依据表名 + 编号”定位记录，避免不同表里相同编号的引用混在一起。
  const context = state.conversation[index]?.context || {};
  let keys = requestedName ? [requestedName] : Object.keys(context);
  if (citation) {
    const mapping = {Entities:"entities", Relationships:"relationships", Reports:"reports", Sources:"sources", Claims:"claims"};
    keys = Object.keys(mapping).filter(name => citation.includes(name)).map(name => mapping[name]);
  }
  let html = "";
  for (const name of keys) {
    let rows = context[name];
    if (!Array.isArray(rows)) continue;
    if (citation) {
      const family = {entities:"Entities",relationships:"Relationships",reports:"Reports",sources:"Sources",claims:"Claims"}[name];
      const group = family ? citation.match(new RegExp(`${family}\\s*\\(([^)]+)\\)`, "i")) : null;
      const ids = group ? (group[1].match(/\d+/g) || []).map(Number) : [];
      if (ids.length) rows = rows.filter(row => ids.includes(Number(row.id ?? row.human_readable_id)));
    }
    html += rows.map(row => `<article class="source-record"><strong>${escapeHTML(row.title || row.entity || row.name || (row.source ? `${label(row.source)} ↔ ${label(row.target)}` : `${name} · ${row.id ?? ""}`))}</strong><p class="original-text">${escapeHTML(row.text || row.description || row.summary || row.content || JSON.stringify(row, null, 2))}</p></article>`).join("");
  }
  showDialog("本次检索依据", html || '<p>这条引用没有匹配到本次返回的依据。请在“原始文档”核对，不要将未匹配的引用当作证据。</p>');
}

async function submitQuery(event) {
  // 提交问题后得到任务编号，再轮询进度；真正检索由后台 web_worker.py 执行。
  event.preventDefault();
  const query = $("#query-input").value.trim();
  if (!query || state.currentJob || state.submitting) return;
  state.submitting = true; setBusy(true);
  const item = {query, method:state.method, status:"running", started:Date.now()};
  state.conversation.push(item); renderConversation(); $("#query-input").value = "";
  try {
    const job = await post("/api/query", {query, method:item.method}); state.currentJob = job.id;
    await pollJob(job.id, elapsed => {
      const output = $("#query-elapsed");
      if (output) output.textContent = `已等待 ${elapsed} 秒${elapsed > 100 ? "，本地模型仍在处理" : ""}`;
    }, result => {
      item.status = "completed"; Object.assign(item, result);
      state.history = [item, ...state.history.filter(old => old.query !== query)].slice(0,8);
      try { localStorage.setItem(HISTORY_KEY, JSON.stringify(state.history)); } catch { /* Browser storage may be disabled. */ }
      renderHistory();
    });
  } catch (error) { item.status = "failed"; item.error = error.message; }
  finally { state.currentJob = null; state.submitting = false; setBusy(false); renderConversation(); }
}

async function pollJob(id, onProgress, onComplete) {
  // 定期问后台“完成了吗”，不要求一个 HTTP 请求持续等待整个模型调用。
  const started = Date.now();
  for (;;) {
    const job = await request(`/api/jobs/${id}`);
    if (job.status === "completed") return onComplete(job.result);
    if (job.status === "failed") throw new Error(job.error);
    if (job.status === "cancelled") throw new Error("已停止本次查询，你可以修改问题后重新发送。");
    onProgress(Math.floor((Date.now() - started) / 1000));
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
}
function setBusy(busy) {
  $("#send-button").hidden = busy; $("#stop-button").hidden = !busy;
  $("#stop-button").disabled = busy && !state.currentJob;
  if (busy) setTimeout(() => { $("#stop-button").disabled = false; }, 900);
}
function newChat() {
  if (state.currentJob || state.submitting) return toast("请先等待或停止当前查询。");
  state.conversation = []; $("#query-input").value = ""; location.hash = "ask"; renderConversation(); $("#query-input").focus();
}

// 七、PDF 导入：读文件 → 后台提取 → 用户核对 → 明确确认 → 单独更新索引。
function pdfPages(pages = []) {
  return pages.map(page => `<section class="pdf-page"><h3>第 ${Number(page.number)} 页</h3><div class="original-text ${page.text ? "" : "pdf-empty-page"}">${escapeHTML(page.text || "此页未提取到文字，图片内容不会参与问答。")}</div></section>`).join("");
}
function pdfWarnings(warnings = []) {
  return warnings.map(warning => `<p class="pdf-warning">${escapeHTML(warning)}</p>`).join("");
}
function fileBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(new Error("文件读取失败，请重新选择 PDF。"));
    reader.readAsDataURL(file);
  });
}
async function previewPDF(file) {
  // 上传产生的 preview_id 只是内存预览编号；确认前不会加入知识库。
  toast(`正在提取 ${file.name} 的文字，请稍候…`);
  const preview = await post("/api/documents/preview", {name:file.name, data:await fileBase64(file)});
  $("#toast").hidden = true;
  return new Promise(resolve => {
    let completed = false, importing = false;
    const dialog = $("#detail-dialog");
    showDialog("先核对，再加入知识库", `<div class="pdf-import-summary"><span class="pdf-format">PDF</span><strong>${escapeHTML(preview.display_name)}</strong><span>${preview.page_count} 页 · ${preview.characters.toLocaleString()} 字符</span></div><p class="pdf-preview-note">以下是实际提取的文字，不是原始排版。请检查乱码和缺页；图片、复杂表格暂不识别。预览 15 分钟内有效。</p><div class="pdf-preview-scroll">${pdfWarnings(preview.warnings)}${pdfPages(preview.pages)}</div><p id="import-error" class="import-error" role="alert" hidden></p><div class="pdf-import-actions"><p>确认后保留原 PDF。<br>更新索引后，才会参与问答。</p><div><button class="secondary-button" id="cancel-import">暂不导入</button><button class="primary-button" id="confirm-import">确认导入${icon("arrow-right")}</button></div></div>`);
    const preventCancel = event => { if (importing) event.preventDefault(); };
    dialog.addEventListener("cancel", preventCancel);
    dialog.addEventListener("close", async () => {
      dialog.removeEventListener("cancel", preventCancel);
      $("#dialog-close").disabled = false;
      if (!completed) await post("/api/documents/discard", {preview_id:preview.preview_id}).catch(() => {});
      resolve();
    }, {once:true});
    $("#cancel-import").addEventListener("click", () => dialog.close());
    $("#confirm-import").addEventListener("click", async () => {
      if (importing) return;
      importing = true;
      $("#confirm-import").disabled = $("#cancel-import").disabled = $("#dialog-close").disabled = true;
      $("#confirm-import").textContent = "正在保存…";
      $("#import-error").hidden = true;
      try {
        const result = await post("/api/documents/import", {preview_id:preview.preview_id});
        completed = true;
        await refresh(); await openDocument(result.name);
        dialog.close(); toast(result.message);
      } catch (error) {
        $("#import-error").textContent = error.message; $("#import-error").hidden = false;
      } finally {
        importing = false;
        $("#dialog-close").disabled = false;
        const confirm = $("#confirm-import"), cancel = $("#cancel-import");
        if (confirm) { confirm.disabled = false; confirm.textContent = "确认导入"; }
        if (cancel) cancel.disabled = false;
      }
    });
  });
}
async function importDocuments(event) {
  // 多选文件会逐份处理，PDF 逐份确认；TXT 继续沿用直接导入流程。
  const files = [...event.target.files];
  const button = $("#import-button"), previous = button.innerHTML;
  button.disabled = true; button.textContent = "正在读取…";
  try {
    for (const file of files) {
      const pdf = /\.pdf$/i.test(file.name);
      if (!pdf && !/\.txt$/i.test(file.name)) { toast(`${file.name}：请使用 PDF 或 UTF-8 TXT。`); continue; }
      const limit = (pdf ? 10 : 2) * 1024 * 1024;
      if (!file.size || file.size > limit) { toast(`${file.name}：文件不能为空，且不能超过 ${pdf ? 10 : 2} MB。`); continue; }
      try {
        if (pdf) { await previewPDF(file); }
        else {
          const content = new TextDecoder("utf-8", {fatal:true}).decode(await file.arrayBuffer());
          const result = await post("/api/documents", {name:file.name, content});
          await refresh(); await openDocument(result.name); toast(result.message);
        }
      } catch (error) { toast(error instanceof TypeError ? "请将文档保存为 UTF-8 编码后再导入。" : error.message); }
    }
  } finally { event.target.value = ""; button.disabled = false; button.innerHTML = previous; }
}
async function reindex() {
  // 这是会更新图谱的操作，必须用户确认；仅导入 PDF 并不会自动执行它。
  if (!confirm("重新构建索引会调用本地模型，并更新现有图谱。通常需要几分钟，期间无法进行问答。现在开始？")) return;
  const button = $("#reindex-button"); button.disabled = true;
  try {
    const job = await post("/api/index", {});
    await pollJob(job.id, elapsed => { $("#index-status").textContent = `正在构建索引 · ${elapsed} 秒\n正在解析文档、抽取关系与生成社区报告，请保持服务运行。`; }, result => { $("#index-status").textContent = result.message; });
    await refresh(); toast("知识网络已更新");
  } catch (error) { $("#index-status").textContent = error.message; }
  finally { button.disabled = false; }
}

function bindGraphPan() {
  const svg = $("#full-graph"); let drag = null;
  svg.addEventListener("pointerdown", event => {
    if (event.target.closest(".graph-node")) return;
    drag = {x:event.clientX, y:event.clientY, pan:{...state.pan}}; svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", event => {
    if (!drag) return;
    const scale = 900 / svg.getBoundingClientRect().width;
    state.pan = {x:drag.pan.x + (event.clientX - drag.x) * scale, y:drag.pan.y + (event.clientY - drag.y) * scale}; applyGraphTransform();
  });
  const end = () => { drag = null; }; svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end);
}

// 八、启动网页：初始化界面，然后为按钮、表单和图谱绑定事件。
hydrateIcons(); loadHistory(); setRoute();
window.addEventListener("hashchange", setRoute);
$("#query-form").addEventListener("submit", submitQuery);
$("#query-input").addEventListener("keydown", event => { if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); $("#query-form").requestSubmit(); } });
$$("[data-mode]").forEach(button => button.addEventListener("click", () => setMode(button.dataset.mode)));
$$("[data-question]").forEach(button => button.addEventListener("click", () => { setMode(button.dataset.questionMode); $("#query-input").value = button.dataset.question; $("#query-input").focus(); }));
$("#new-chat").addEventListener("click", newChat);
$("#refresh-button").addEventListener("click", async () => { await refresh(); await refreshHealth(); toast("知识库状态已刷新"); });
$("#model-status").addEventListener("click", showSettings); $("#settings-button").addEventListener("click", showSettings); $("#workspace-button").addEventListener("click", showSettings);
$("#help-button").addEventListener("click", showGuide);
$("#dialog-close").addEventListener("click", () => $("#detail-dialog").close());
$("#detail-dialog").addEventListener("click", event => { if (event.target === $("#detail-dialog") && !$("#dialog-close").disabled) { const box=event.target.getBoundingClientRect(); if(event.clientX<box.left || event.clientX>box.right || event.clientY<box.top || event.clientY>box.bottom) event.target.close(); } });
$("#entity-search").addEventListener("input", renderEntityList);
$("#zoom-in").addEventListener("click", () => { state.zoom = Math.min(2.5, state.zoom + .2); applyGraphTransform(); });
$("#zoom-out").addEventListener("click", () => { state.zoom = Math.max(.5, state.zoom - .2); applyGraphTransform(); });
$("#zoom-reset").addEventListener("click", () => { state.zoom = 1; state.pan = {x:0,y:0}; applyGraphTransform(); });
$("#import-button").addEventListener("click", () => $("#file-input").click());
$("#file-input").addEventListener("change", importDocuments);
$("#reindex-button").addEventListener("click", reindex);
$("#stop-button").addEventListener("click", async () => { if(state.currentJob) { try { await post(`/api/jobs/${state.currentJob}/cancel`, {}); } catch(error) { toast(error.message); } } });
document.addEventListener("keydown", event => { if((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); if(state.route !== "ask") location.hash="ask"; $("#query-input").focus(); } });
bindGraphPan();
refresh(); refreshHealth();
