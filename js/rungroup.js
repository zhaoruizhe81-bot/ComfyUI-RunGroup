// ComfyUI-RunGroup · 运行组开关 (Run Group Switch)
//
// 纯前端虚拟节点：枚举画布分组，单选一个组"运行"，其余组整组静音。
// 原理：ComfyUI 后端不认节点 mode，前端 graphToPrompt() 提交前会把
// mode=NEVER(2) 的节点整个剔除——静音组对后端完全不可见。
// 选中组节点 mode=0，其余组 mode=2；组外共享节点不碰。
//
// 设计参考 rgthree-comfy 的 FastGroupsModeChanger（mode 即权威状态，
// 不序列化 widget 值），差异：固定单选（radio），无 bypass 模式。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "RunGroupSwitch";
const NODE_TITLE = "运行组开关 (Run Group Switch)";
const MODE_ALWAYS = 0;
const MODE_MUTE = 2;
const POLL_MS = 1500;

const liveNodes = new Set();

function getGraph() {
  return app.rootGraph ?? app.graph;
}

// 枚举根画布全部分组：[{group, title, nodes, active}]
function getGroups() {
  const graph = getGraph();
  const raw = graph?._groups ?? graph?.groups ?? [];
  const out = [];
  for (const group of raw) {
    const gnodes = membersOf(group);
    out.push({
      group,
      title: group.title || "(未命名组)",
      nodes: gnodes,
      active: gnodes.some((n) => n.mode === MODE_ALWAYS),
    });
  }
  return out;
}

// 组内成员：优先 LiteGraph 自算的 _children/_nodes，缺失时按节点中心点兜底
function membersOf(group) {
  try {
    group.recomputeInsideNodes?.();
  } catch {}
  const children = group._children ?? group._nodes;
  if (children) {
    const list = [];
    for (const c of children) {
      // 嵌套分组框也有 recomputeInsideNodes 方法，借此与普通节点区分
      if (!c || typeof c.recomputeInsideNodes === "function") continue;
      if (typeof c.mode === "number") list.push(c);
    }
    return list;
  }
  const b = group.bounding ?? group._bounding;
  const all = getGraph()?._nodes ?? [];
  if (!b) return [];
  return all.filter((n) => {
    const p = n.pos ?? [0, 0];
    const s = n.size ?? [0, 0];
    const cx = p[0] + s[0] / 2;
    const cy = p[1] + s[1] / 2;
    return cx >= b[0] && cx <= b[0] + b[2] && cy >= b[1] && cy <= b[1] + b[3];
  });
}

// 单选应用：选中组全开、其余组全静音，组外节点不碰
function applySelection(node, index) {
  const groups = getGroups();
  if (!groups.length || index < 0 || index >= groups.length) return;
  groups.forEach((g, i) => {
    const mode = i === index ? MODE_ALWAYS : MODE_MUTE;
    for (const n of g.nodes) n.mode = mode;
  });
  node.properties.selectedGroup = groups[index].title;
  getGraph()?.change?.();
  app.canvas?.setDirty?.(true, true);
  refreshRows(node);
}

function onRowClick(node, idx, v) {
  const groups = getGroups();
  if (!v) {
    // 不允许全关（always one）：把当前运行中的行勾回去
    const cur = groups.findIndex((g) => g.active);
    if (cur >= 0 && node.widgets[cur]) node.widgets[cur].value = true;
    app.canvas?.setDirty?.(true, true);
    return;
  }
  applySelection(node, idx);
}

// 行 widget 与分组做增量对齐：行数缺则补、多则删；标签/勾选态每轮刷新。
// 行与分组按位置索引对应，callback 里的 idx 永远指向点击时的 groups[idx]。
function refreshRows(node) {
  try {
    node.widgets = node.widgets ?? [];
    const groups = getGroups();

    if (!groups.length) {
      if (node.widgets.length !== 1 || node.widgets[0].type !== "button") {
        node.widgets.length = 0;
        node.addWidget(
          "button",
          "画布上还没有分组（框选节点后 Ctrl+G 创建）",
          null,
          () => {}
        );
        node.setSize?.(node.computeSize());
      }
      return;
    }

    let structureChanged = false;
    while (node.widgets.length > groups.length) {
      node.removeWidget?.(node.widgets[node.widgets.length - 1]);
      structureChanged = true;
    }
    while (node.widgets.length < groups.length) {
      const idx = node.widgets.length;
      node.addWidget(
        "toggle",
        `组${idx + 1}`,
        false,
        (v) => onRowClick(node, idx, v),
        { on: "▶ 运行", off: "静音" }
      );
      structureChanged = true;
    }

    for (let i = 0; i < groups.length; i++) {
      const w = node.widgets[i];
      const label = `${groups[i].title} · ${groups[i].nodes.length}节点`;
      if (w.label !== label) w.label = label;
      if (w.value !== groups[i].active) w.value = groups[i].active;
    }

    if (structureChanged) node.setSize?.(node.computeSize());
    app.canvas?.setDirty?.(true, true);
  } catch (e) {
    console.warn("[RunGroup] refresh failed:", e);
  }
}

function refreshAll() {
  for (const n of liveNodes) refreshRows(n);
}

app.registerExtension({
  name: "RunGroup.Switch",

  // 纯前端节点进入注册流程的官方通道：注入 def 后标准注册机制即可建类，
  // 无需触碰 LiteGraph 全局，也不会出现在后端 /object_info
  addCustomNodeDefs(defs) {
    defs[NODE_TYPE] = {
      name: NODE_TYPE,
      display_name: NODE_TITLE,
      category: "utils",
      input: { required: {} },
      input_order: {},
      output: [],
      output_name: [],
      python_module: "custom_nodes.ComfyUI-RunGroup",
      description:
        "单选一个分组运行，其余分组自动静音（提交 prompt 前整组剔除）。注意：每个分组需自带输出节点（Save Image / Preview）。",
    };
  },

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      this.isVirtualNode = true; // graphToPrompt 跳过自身
      this.serialize_widgets = false; // 状态权威来源是组员节点的 mode
      if (!this.properties) this.properties = {};
      this.properties.selectedGroup = this.properties.selectedGroup ?? "";
      this.size[0] = Math.max(this.size?.[0] ?? 0, 280);
      liveNodes.add(this);
      refreshRows(this);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      liveNodes.delete(this);
      return onRemoved?.apply(this, arguments);
    };
  },

  // 工作流加载完毕：组员节点的 mode 已随 JSON 恢复，刷新即可还原单选显示
  afterConfigureGraph() {
    refreshAll();
  },

  setup() {
    api.addEventListener("graphChanged", () => refreshAll());
    // 兜底轮询：分组改名/挪节点进组等操作不保证触发 graphChanged
    setInterval(refreshAll, POLL_MS);
  },
});
