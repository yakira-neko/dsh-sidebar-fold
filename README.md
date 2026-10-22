# dsh-sidebar-manager

把左侧栏里「插件们各自加进来的全局面板」收进一个可折叠的分组，避免入口越装越多时列表失控。

- **折叠组**：不是内置面板的入口默认收进一行「展开 N 项面板」后面，点一下整组展开/收起；展开状态记在本机。
- **逐项三态**：设置 → 侧边栏里给每个入口选「显示 / 折叠 / 隐藏」。列表是活的 —— 读当前注册的 `sidebar.panellist` 条目，装一个插件就多一行，谁被收纳由你决定，还能「全部折叠 / 全部显示」。
- **两处开关**：面板列表内部的那一行开关；侧边栏底部还有一个快捷折叠按钮。
- **零侵入**：不改动、不移动、不卸载 shell 自己的 React 节点，只给行加属性 + 一条 CSS 规则，卸载插件立刻恢复原状。

## 安装

桌面版（Electron）的 `desktop` profile 由应用独占管理，CLI 会直接拒绝：

```text
error: profile "desktop" is managed exclusively by the Electron application
```

所以在桌面版里手工装（本机就是这么装的），三步：

```powershell
# 1) 把包放进 profile 的 node_modules（junction 也行，改代码免重装）
$link = Join-Path $HOME '.dsh\profiles\desktop\node_modules\dsh-sidebar-manager'
New-Item -ItemType Junction -Path $link -Target 'D:\code\dsh-plugin\dsh-sidebar-manager'

# 2) profile/package.json 里加依赖
#    "dsh-sidebar-manager": "link:D:/code/dsh-plugin/dsh-sidebar-manager"

# 3) 同一个文件里把包名追加进 dsh.profile.bundles（本包声明了 dsh.bundle.patch，
#    是一层独立 patch；bundles 里没有它，host 半不会成为 Loader 行，client 也不会被下发）
```

命令行环境（`dsh web`、自建 profile）可以直接用官方路径，它会自动把包名补进 `dsh.profile.bundles`：

```bash
dsh plugin --profile <name> add link:D:/code/dsh-plugin/dsh-sidebar-manager
```

改完配置要**完全退出并重开** DeepSeek Harness Desktop（客户端 bundle 在启动时随 `__DSH_BOOT__` 图一起下发）。

卸载：从 `dsh.profile.bundles` 删掉 `dsh-sidebar-manager`，删掉 `node_modules/dsh-sidebar-manager`，再删 `package.json` 里那行依赖。本机状态（哪些入口被折叠）存在浏览器 `localStorage` 的 `dsh-sidebar-manager/v1`，卸载后可手动清掉。

## 用法

1. 打开 设置 → **侧边栏**。
2. 列表不是写死的：它读的是此刻真正注册到 `sidebar.panellist` 的条目（`ctx.slots.entriesOfSlot('sidebar.panellist')`），装了新插件、面板一挂载就会自动多一行，卸载就自动消失。内置 `plugins` / `schedules` 默认「显示」，其余默认「折叠」，每个条目都能单独改。
3. 想常驻的选「显示」，想彻底不看见的选「隐藏」，其余留「折叠」；「全部折叠 / 全部显示」是对当前列表一次性批量设置。
4. 左侧栏面板列表底部会出现「展开 N 项面板 / 收起 N 项面板」那一行；点它整组开合，状态会被记住。
5. 顶部的「启用折叠」总开关关掉后，列表回到未折叠的原始形态（逐项「隐藏」也一并失效）。

## 配置结构

`localStorage["dsh-sidebar-manager/v1"]`：

```json
{
  "enabled": true,
  "collapsed": true,
  "modes": { "plugins": "show", "ssh": "fold", "dshmarket": "hide" }
}
```

- `enabled`：折叠功能总开关。
- `collapsed`：折叠组当前是否收起。
- `modes`：按 `sidebar.panellist` 条目 id 的三态覆盖；缺省时内置面板 `show`、其余 `fold`。

## 实现要点

左侧栏的行由 `@deepseek-ai/dsh-client-ui-sidebar` 渲染，slot 只提供「一项」的注册位（没有分组位），所以本插件在 shell 渲染完之后做归属标注：

1. 从 `ctx.slots.entriesOfSlot('sidebar.panellist')` 取当前条目，按 `order` 升序——这正是 shell 渲染行的顺序。
2. 找到面板列表 `nav`（`[data-slot="sidebar.panellist"]` 内的第一个带 `button` 子元素的 `nav`；老 shell 只有 `[data-slot="sidebar"]`，两种都认），把它的直接 `button` 子节点与条目配对：先看行的 `aria-label`（shell 用面板标题写的），对不上再按位置兜底，逐行写 `data-dsh-sm-row="<id>"`。
3. 需要隐藏的行写 `data-dsh-sm-hidden="1"`，配套只有一条规则：`[data-dsh-sm-hidden="1"] { display: none !important }`。
4. 折叠开关是自己插入 `nav` 的一个 `div[data-dsh-sm-host]`（`display: contents`，`order: 10000` 视觉置底），里层用 `react-dom/client` 渲染成和原生行同构的按钮；侧边栏收成 56px 图标栏时自动切成 36×36 图标。
5. `MutationObserver` 只盯侧边栏子树 + 500ms 轮询兜底（侧边栏晚于插件挂载、或被整体重挂时能接回来），不观察整页。

宿主侧（`lib/index.js`）没有行为，只为了让这个包成为 profile 里的一条正常 Loader 行，并被 client 扫描发现。

## 测试

```bash
npm test    # node --test test/dom.test.mjs
```

`test/dom.test.mjs` 用最小 DOM/React 打桩直接跑 `lib/client.js`，覆盖：配置归一化、默认三态、折叠/隐藏判定、行标注顺序、行与条目的 `aria-label`/位置配对、展开/关闭总开关、rail 模式识别、侧边栏重挂后重新标注、老 shell 的 `[data-slot="sidebar"]` 回退、条目减少后的清理、`apply()` 的座位注册与 CSS 注入。

## 兼容性

- 针对 `@deepseek-ai/dsh-client-ui-sidebar` 0.2.1-rc.2 的行结构（`nav` 的直接 `button` 子节点 + 一个可选标题 `span`）。若上游把行包进额外容器，行标注会退化为「不生效」而不是报错——`[data-dsh-sm-row]` 找不到对应行时干净退出。
- 依赖 `ctx.slots`（`entriesOfSlot` / `subscribe` / `inject` / `register`）、`ctx.locale`、`react`、`react-dom/client`，均在 `dsh.client.inject` 里声明。
