// ComfyUI-RunGroup · 运行组开关 (Run Group Switch)
//
// 纯前端虚拟节点：枚举画布分组，按运行模式施加节点 mode。
// 原理：ComfyUI 后端不认节点 mode，前端 graphToPrompt() 提交前会把
// mode=NEVER(2) 的节点整个剔除——静音组对后端完全不可见。
//
// 两种运行模式（runMode）：
// - 单选运行 radio：只有选中组执行，其余组静音。适合相互独立的组。
// - 接力运行 chain：组按画布上下排序，选中组N = 组1..N 全部执行。
//   后组直接连线前组的输出（如 高清组 ← 抽卡组的 VAE解码）。
//   前置组输入未变时命中执行缓存零开销；前置组的终端节点
//   （Save/Preview 等无对外输出的节点）自动静音避免重复落盘。
//
// 设计参考 rgthree-comfy 的 FastGroupsModeChanger（mode 即权威状态，
// 不序列化 widget 值），差异：固定单选语义，无 bypass 模式。
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "RunGroupSwitch";
const NODE_TITLE = "运行组开关 (Run Group Switch)";
const MODE_ALWAYS = 0;
const MODE_MUTE = 2;
const POLL_MS = 1500;
const RUN_MODES = ["单选运行", "接力运行（含前置组）"];

const liveNodes = new Set();

function getGraph() {
  return app.rootGraph ?? app.graph;
}

// 枚举根画布全部分组，接力顺序 = 画布从上到下（同排从左到右）。
// 返回 [{group, title, nodes, active}]
function getGroups() {
  const graph = getGraph();
  const raw = [...(graph?._groups ?? graph?.groups ?? [])];
  raw.sort(
    (a, b) =>
      (a.bounding?.[1] ?? 0) - (b.bounding?.[1] ?? 0) ||
      (a.bounding?.[0] ?? 0) - (b.bounding?.[0] ?? 0)
  );
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

// 组内成员：优先 LiteGraph 自算的 _children/_nodes（新版是 Set），
// 缺失时按节点中心点落在分组框内兜底
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

// 终端节点 = 没有任何对外输出链接（Save/Preview 等落盘/预览节点）。
// 不用节点类型判断：这版前端 SaveImage 实例没有 isOutputNode 标记，
// 链接拓扑判定版本兼容更稳。
function isTerminal(n) {
  return !(n.outputs ?? []).some((o) => (o.links ?? []).some((l) => l != null));
}

// 应用选中：radio = 只选中组；chain = 组1..选中组，其中前置组终端节点静音。
// 组外共享节点永远不碰。
function applySelection(node, index) {
  const groups = getGroups();
  if (!groups.length || index < 0 || index >= groups.length) return;
  const chain = node.properties.runMode === "chain";
  groups.forEach((g, i) => {
    const mode = (chain ? i <= index : i === index) ? MODE_ALWAYS : MODE_MUTE;
    for (const n of g.nodes) {
      n.mode = chain && i < index && isTerminal(n) ? MODE_MUTE : mode;
    }
  });
  node.properties.selectedGroup = groups[index].title;
  getGraph()?.change?.();
  app.canvas?.setDirty?.(true, true);
  refreshRows(node);
}

function onRowClick(node, idx, v) {
  const chain = node.properties.runMode === "chain";
  if (!v) {
    if (chain && idx >= 1) {
      // 接力模式关掉第N组 = 退挡到第N-1段：前组恢复为自己的最终阶段
      // （它的 Save 复活），第N组及其后的组全部静音。
      applySelection(node, idx - 1);
      return;
    }
    // 单选模式关选中组 / 接力模式关第一组 = 全部静音（空闲态）。
    // 接力链上第一组是依赖源头，关掉它整条链都无法成立。
    const groups = getGroups();
    for (const g of groups) {
      for (const n of g.nodes) n.mode = MODE_MUTE;
    }
    node.properties.selectedGroup = "";
    getGraph()?.change?.();
    app.canvas?.setDirty?.(true, true);
    refreshRows(node);
    return;
  }
  applySelection(node, idx);
}

// 行 widget 与分组做增量对齐：先清掉行区里的非行 widget（保留 runMode
// combo），再补行/删行；标签、勾选态每轮刷新。行回调动态解析自身当前
// 行位置，杜绝分组增删导致行序变化后的错位（工作流加载时分组晚于节点
// 配置，提示按钮会先占住第 0 行，必须自愈）。
function refreshRows(node) {
  try {
    node.widgets = node.widgets ?? [];

    for (let i = node.widgets.length - 1; i >= 0; i--) {
      const w = node.widgets[i];
      if (w.name !== "runMode" && w.type !== "toggle") {
        node.widgets.splice(i, 1);
        node.setSize?.(node.computeSize());
      }
    }

    const groups = getGroups();
    if (!groups.length) {
      if (!node.widgets.some((w) => w.type === "button")) {
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

    let rows = node.widgets.filter((w) => w.type === "toggle");
    let structureChanged = false;
    while (rows.length > groups.length) {
      const w = rows.pop();
      const i = node.widgets.indexOf(w);
      if (i >= 0) node.widgets.splice(i, 1);
      structureChanged = true;
    }
    while (rows.length < groups.length) {
      node.addWidget(
        "toggle",
        `组${rows.length + 1}`,
        false,
        null,
        { on: "▶ 运行", off: "静音" }
      );
      rows = node.widgets.filter((w) => w.type === "toggle");
      structureChanged = true;
    }

    for (let i = 0; i < groups.length; i++) {
      const w = rows[i];
      const label = `${groups[i].title} · ${groups[i].nodes.length}节点`;
      if (w.label !== label) w.label = label;
      w.callback = (v) => {
        const idx = node.widgets
          .filter((x) => x.type === "toggle")
          .indexOf(w);
        onRowClick(node, idx, v);
      };
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
        "单选/接力运行画布分组，未选分组自动静音（提交 prompt 前整组剔除）。注意：每组需自带输出节点（接力模式下前置组终端节点会被自动静音）。",
    };
  },

  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      this.isVirtualNode = true; // graphToPrompt 跳过自身
      this.serialize_widgets = false; // 状态权威来源是组员节点的 mode + properties
      if (!this.properties) this.properties = {};
      this.properties.runMode = this.properties.runMode ?? "radio";
      this.properties.selectedGroup = this.properties.selectedGroup ?? "";
      this.addWidget(
        "combo",
        "runMode",
        this.properties.runMode === "chain" ? RUN_MODES[1] : RUN_MODES[0],
        (v) => {
          this.properties.runMode = v === RUN_MODES[1] ? "chain" : "radio";
          // 切模式后按记住的选中组立即重新施加
          const groups = getGroups();
          const idx = groups.findIndex(
            (g) => g.title === this.properties.selectedGroup
          );
          if (idx >= 0) applySelection(this, idx);
        },
        { values: RUN_MODES }
      );
      this.size[0] = Math.max(this.size?.[0] ?? 0, 280);
      liveNodes.add(this);
      refreshRows(this);
      return r;
    };

    // 工作流加载：properties（runMode/selectedGroup）此时才从 JSON 恢复，
    // 同步 combo 显示
    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure?.apply(this, arguments);
      this.properties.runMode = this.properties.runMode ?? "radio";
      const combo = this.widgets?.find((w) => w.name === "runMode");
      if (combo) {
        combo.value =
          this.properties.runMode === "chain" ? RUN_MODES[1] : RUN_MODES[0];
      }
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
