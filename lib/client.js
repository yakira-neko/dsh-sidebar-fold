/**
 * Browser half of dsh-sidebar-manager.
 *
 * Goal: keep the left sidebar's global panel list (`sidebar.panellist`, the
 * rows every plugin adds) usable when it grows long. The plugin:
 *
 *  - classifies each panel row as `show` / `fold` / `hide` (per entry id),
 *  - folds the `fold` rows behind one in-list toggle row that is rendered
 *    into the same `nav` the shell owns,
 *  - persists the decision in localStorage,
 *  - exposes the whole model on a Settings page (Settings → 侧边栏).
 *
 * The shell renders the panel rows itself and offers no grouping seat, so the
 * rows are addressed after the fact: each direct `button` child of the panel
 * `nav` is mapped, in order, to the `sidebar.panellist` registrations the
 * shell sorted by `order` (that mapping is exactly what the shell renders).
 * Hidden rows get a data attribute and one CSS rule; no React node is moved,
 * replaced or unmounted.
 */

window.__ModuleLoader__.load({
  id: 'dsh-sidebar-manager',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createRoot } = require('react-dom/client')

    const NS = 'sidebar-manager'
    const STORAGE_KEY = 'dsh-sidebar-manager/v1'
    const ROW_ATTR = 'data-dsh-sm-row'
    const HIDDEN_ATTR = 'data-dsh-sm-hidden'
    const NAV_ATTR = 'data-dsh-sm-nav'
    const HOST_ATTR = 'data-dsh-sm-host'
    const STYLE_ID = 'dsh-sidebar-manager/styles'
    const PLUGIN_ID = 'dsh-sidebar-manager'

    /** Entries that ship with the harness UI and default to `show`. */
    const DEFAULT_SHOW = new Set(['plugins', 'schedules', 'plugin-market', 'marketplace'])
    const MODES = ['show', 'fold', 'hide']

    // ---------------------------------------------------------------- copy --
    const zh = {
      'settings.title': '侧边栏',
      'settings.summary': '管理左侧全局面板：哪些始终显示、哪些收进折叠组、哪些完全隐藏。',
      'settings.enable': '启用折叠',
      'settings.enableHint': '关闭后所有面板按各自状态直接显示，折叠组不再隐藏任何入口。',
      'settings.listTitle': '全局面板',
      'settings.listHint': '列表跟着实际注册情况变：装了新插件、面板一出现就会自动列在这里，可单独选择它是否被收纳。',
      'settings.listEmpty': '当前没有插件向左侧栏添加全局面板。',
      'settings.mode.show': '显示',
      'settings.mode.fold': '折叠',
      'settings.mode.hide': '隐藏',
      'settings.mode.showHint': '始终显示在左侧栏',
      'settings.mode.foldHint': '收进折叠组，点按「更多」展开',
      'settings.mode.hideHint': '完全从左侧栏移除',
      'settings.bulk.fold': '全部折叠',
      'settings.bulk.show': '全部显示',
      'settings.bulk.foldHint': '把当前列出的所有面板都收进折叠组',
      'settings.bulk.showHint': '把当前列出的所有面板都常驻显示',
      'settings.reset': '恢复默认',
      'settings.resetHint': '内置面板恢复显示，插件添加的面板恢复折叠。',
      'settings.saved': '已保存到本机',
      'settings.count': '{fold} 项折叠 · {hidden} 项隐藏',
      'toggle.fold': '展开 {count} 项面板',
      'toggle.unfold': '收起 {count} 项面板',
      'toggle.title': '侧边栏面板折叠',
      'panel.label': '侧边栏',
      'footer.label': '折叠/展开侧边栏面板',
    }
    const en = {
      'settings.title': 'Sidebar',
      'settings.summary': 'Manage the left global panel list: what stays visible, what folds away, what is hidden.',
      'settings.enable': 'Enable folding',
      'settings.enableHint': 'When off, every panel renders by its own state and the fold group hides nothing.',
      'settings.listTitle': 'Global panels',
      'settings.listEmpty': 'No plugin has added a global panel to the left sidebar yet.',
      'settings.mode.show': 'Show',
      'settings.mode.fold': 'Fold',
      'settings.mode.hide': 'Hide',
      'settings.mode.showHint': 'Always visible in the sidebar',
      'settings.mode.foldHint': 'Lives behind the "more" toggle',
      'settings.mode.hideHint': 'Removed from the sidebar entirely',
      'settings.listHint': 'The list tracks what is actually registered: a new plugin panel shows up here as soon as it mounts, and you pick whether it folds.',
      'settings.bulk.fold': 'Fold all',
      'settings.bulk.show': 'Show all',
      'settings.bulk.foldHint': 'Put every listed panel behind the fold group',
      'settings.bulk.showHint': 'Keep every listed panel visible',
      'settings.reset': 'Reset',
      'settings.resetHint': 'Built-in panels go back to visible; plugin panels go back to folded.',
      'settings.saved': 'Saved on this device',
      'settings.count': '{fold} folded · {hidden} hidden',
      'toggle.fold': 'Show {count} more panels',
      'toggle.unfold': 'Fold {count} panels',
      'toggle.title': 'Sidebar panel folding',
      'panel.label': 'Sidebar',
      'footer.label': 'Fold or unfold sidebar panels',
    }

    // --------------------------------------------------------------- utils --
    const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined'

    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(fn) {
          listeners.add(fn)
          return () => { listeners.delete(fn) }
        },
        set(next) {
          if (Object.is(next, value)) return
          value = next
          for (const fn of [...listeners]) fn()
        },
        update(fn) {
          this.set(fn(value))
        },
        notify() {
          for (const fn of [...listeners]) fn()
        },
      }
    }

    function useStore(store) {
      return React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    }

    function resolveSlotLabel(label) {
      try {
        return typeof label === 'function' ? label() : label
      } catch {
        return undefined
      }
    }

    // --------------------------------------------------------------- config --
    const DEFAULTS = Object.freeze({ enabled: true, collapsed: true, modes: Object.freeze({}) })

    function normalizeConfig(raw) {
      const source = raw !== null && typeof raw === 'object' ? raw : {}
      const modes = {}
      if (source.modes !== null && typeof source.modes === 'object') {
        for (const [id, mode] of Object.entries(source.modes)) {
          if (typeof id === 'string' && MODES.includes(mode)) modes[id] = mode
        }
      }
      return {
        enabled: source.enabled === undefined ? DEFAULTS.enabled : source.enabled !== false,
        collapsed: source.collapsed === undefined ? DEFAULTS.collapsed : source.collapsed !== false,
        modes,
      }
    }

    function readConfig() {
      try {
        const raw = hasDOM ? window.localStorage.getItem(STORAGE_KEY) : null
        return raw === null ? normalizeConfig({}) : normalizeConfig(JSON.parse(raw))
      } catch {
        return normalizeConfig({})
      }
    }

    function writeConfig(config) {
      try {
        if (hasDOM) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(config))
      } catch {
        /* private mode / quota: the session keeps working from memory */
      }
    }

    /** Effective mode for one entry id: user override first, built-in default second. */
    function effectiveMode(config, id) {
      const mode = config.modes[id]
      if (mode === 'show' || mode === 'fold' || mode === 'hide') return mode
      return DEFAULT_SHOW.has(id) ? 'show' : 'fold'
    }

    /** Fold/hide counters for the current panel list. */
    function foldStats(config, entries) {
      let fold = 0
      let hidden = 0
      for (const entry of entries) {
        const mode = effectiveMode(config, entry.id)
        if (mode === 'fold') fold += 1
        else if (mode === 'hide') hidden += 1
      }
      return { fold, hidden }
    }

    /** Whether one row must be display:none right now. */
    function isRowHidden(config, id) {
      if (!config.enabled) return false
      const mode = effectiveMode(config, id)
      if (mode === 'hide') return true
      return mode === 'fold' && config.collapsed
    }

    /** Panel rows in the order the shell renders them (ascending `order`). */
    function readPanels(slots) {
      let rows = []
      try {
        rows = slots.entriesOfSlot('sidebar.panellist')
      } catch {
        return []
      }
      return rows
        .map(({ options }) => {
          const id = String(options.id)
          const label = resolveSlotLabel(options.label)
          return {
            id,
            order: typeof options.order === 'number' ? options.order : 0,
            label: label === undefined || label === null || label === '' ? id : String(label),
          }
        })
        .sort((a, b) => a.order - b.order)
    }

    /**
     * Pair rendered panel rows with their slot entries. The shell renders one
     * `<button aria-label={label}>` per `sidebar.panellist` entry in order, so
     * the position is the primary key; a row whose `aria-label` identifies a
     * still-unclaimed entry wins instead, which keeps the pairing stable when a
     * panel renders nothing or a row is filtered out of the list.
     * @param rows - direct BUTTON children of the panel `nav`, in DOM order.
     * @param entries - `readPanels` output, in render order.
     */
    function matchRows(rows, entries) {
      const remaining = [...entries]
      return rows.map((row, index) => {
        const label = typeof row.getAttribute === 'function' ? row.getAttribute('aria-label') : null
        let at = label === null || label === undefined ? -1 : remaining.findIndex((entry) => entry.label === label)
        if (at < 0) {
          const positional = entries[index]
          if (positional !== undefined) at = remaining.findIndex((entry) => entry.id === positional.id)
        }
        // A row that lost its entry to a label match takes the next free one.
        if (at < 0 && remaining.length > 0) at = 0
        const entry = at < 0 ? undefined : remaining.splice(at, 1)[0]
        return { row, entry }
      })
    }

    // ----------------------------------------------------------------- css --
    const CSS = `
[${NAV_ATTR}] { --dsh-sm-toggle-order: 10000; }
[${HIDDEN_ATTR}="1"] { display: none !important; }
[${HOST_ATTR}] { display: contents; }
[${HOST_ATTR}] > .dsm-toggle {
  order: var(--dsh-sm-toggle-order, 10000);
  box-sizing: border-box;
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  margin: 0 2px;
  padding: 7px 8px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
}
[${HOST_ATTR}] > .dsm-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
}
[${HOST_ATTR}] > .dsm-toggle:focus-visible {
  outline: 2px solid var(--dsw-alias-brand-primary);
  outline-offset: -2px;
}
[${HOST_ATTR}] > .dsm-toggle > .dsm-toggle-glyph {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
}
[${HOST_ATTR}] > .dsm-toggle > .dsm-toggle-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
}
[${HOST_ATTR}][data-dsh-sm-rail="1"] > .dsm-toggle {
  width: 36px;
  height: 36px;
  min-height: 36px;
  margin: 0;
  padding: 0;
  justify-content: center;
  gap: 0;
}
[${HOST_ATTR}][data-dsh-sm-rail="1"] > .dsm-toggle > .dsm-toggle-glyph { width: 18px; height: 18px; }
[${HOST_ATTR}][data-dsh-sm-rail="1"] > .dsm-toggle > .dsm-toggle-label { display: none; }

.dsm-page { display: flex; flex-direction: column; gap: 16px; }
.dsm-hero { display: flex; flex-direction: column; gap: 6px; }
.dsm-hero-title { margin: 0; font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsm-hero-text { margin: 0; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-secondary); }
.dsm-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsm-switch-row { display: flex; align-items: center; gap: 10px; }
.dsm-switch {
  position: relative;
  flex: none;
  width: 36px;
  height: 20px;
  margin: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dsw-alias-bg-module-platform);
  cursor: pointer;
  transition: background .16s ease;
}
.dsm-switch[data-on="1"] { background: var(--dsw-alias-brand-primary); }
.dsm-switch > span {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform .16s ease;
}
.dsm-switch[data-on="1"] > span { transform: translateX(16px); }
.dsm-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.dsm-switch-label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.dsm-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.dsm-list { display: flex; flex-direction: column; gap: 8px; }
.dsm-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-3);
}
.dsm-item-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsm-item-label { font-size: 13px; font-weight: 500; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-item-id { font-size: 11px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsm-seg { display: inline-flex; flex: none; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-module-platform); }
.dsm-seg > button {
  appearance: none;
  border: 0;
  border-radius: 6px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 1.4;
  padding: 3px 9px;
  cursor: pointer;
}
.dsm-seg > button[data-active="1"] {
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
  box-shadow: 0 1px 2px var(--dsw-alias-bg-mask-2, rgba(0, 0, 0, .12));
}
.dsm-seg > button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsm-footer-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.dsm-count { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsm-reset {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}
.dsm-reset:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); }
.dsm-reset:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsm-bulk { display: flex; align-items: center; gap: 8px; }
.dsm-bulk-btn {
  appearance: none;
  border: 1px solid var(--dsw-alias-border-l2);
  border-radius: 8px;
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  padding: 4px 10px;
  cursor: pointer;
}
.dsm-bulk-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-label-dimmed); background: var(--dsw-alias-interactive-bg-hover); }
.dsm-bulk-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsm-foot-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  box-sizing: border-box;
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: 0;
  border-radius: var(--dsw-radius-md);
  background: none;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.dsm-foot-btn:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.dsm-foot-btn:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: -2px; }
`

    function ensureStyles() {
      if (!hasDOM) return () => {}
      let tag = document.getElementById(STYLE_ID)
      if (tag === null) {
        tag = document.createElement('style')
        tag.id = STYLE_ID
        tag.dataset.plugin = PLUGIN_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      }
      return () => {
        const live = document.getElementById(STYLE_ID)
        if (live !== null) live.remove()
      }
    }

    // ---------------------------------------------------------------- icons --
    function chevron(direction, size) {
      const down = direction === 'down'
      return React.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        React.createElement('path', {
          d: down ? 'M4 6.5 8 10.5 12 6.5' : 'M4 9.5 8 5.5 12 9.5',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // --------------------------------------------------------------- plugin --
    const inject = ['slots', 'locale']

    /**
     * Mount the fold behavior plus its two seats.
     * @param ctx - client root context (slots, locale).
     */
    function apply(ctx) {
      let t = (key, params) => String(key)
      try {
        t = ctx.locale.bind(NS)
      } catch {
        /* locale service missing: fall back to raw keys */
      }
      ctx.effect(() => {
        try {
          return ctx.locale.register(NS, { zh, en })
        } catch {
          return () => {}
        }
      }, 'dsh-sidebar-manager: dictionaries')

      const configStore = createStore(readConfig())
      const panelsStore = createStore(readPanels(ctx.slots))
      const disposers = []

      configStore.subscribe(() => { writeConfig(configStore.getSnapshot()) })

      const refreshPanels = () => { panelsStore.set(readPanels(ctx.slots)) }
      ctx.effect(() => {
        try {
          return ctx.slots.subscribe('sidebar.panellist', refreshPanels)
        } catch {
          return () => {}
        }
      }, 'dsh-sidebar-manager: panel entries')

      // Locale switches re-render every surface that projects copy.
      ctx.effect(() => {
        try {
          return ctx.locale.subscribe(() => {
            try { t = ctx.locale.bind(NS) } catch { /* keep previous bound copy */ }
            configStore.notify()
            panelsStore.notify()
          })
        } catch {
          return () => {}
        }
      }, 'dsh-sidebar-manager: locale')

      if (hasDOM) {
        const disposeStyles = ensureStyles()
        const augmenter = createAugmenter({ configStore, panelsStore, t: () => t })
        disposers.push(disposeStyles, augmenter.dispose)
        augmenter.start()
      }

      // Settings page: the management surface.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'sidebar-manager',
        order: 60,
        label: () => t('settings.title'),
      }, () => React.createElement(SettingsSection, { configStore, panelsStore, t: () => t })))

      // A compact foot control keeps the fold reachable from anywhere.
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'sidebar-manager-fold',
        order: 60,
        label: () => t('footer.label'),
      }, (props) => React.createElement(FooterFold, {
        configStore,
        panelsStore,
        t: () => t,
        wide: props !== null && props !== undefined && props.wide === true,
      })))

      ctx.effect(() => () => {
        for (const dispose of disposers.splice(0)) {
          try { dispose() } catch { /* already gone */ }
        }
      }, 'dsh-sidebar-manager: mounts')
    }

    // ------------------------------------------------------------ augmenter --
    /**
     * Keep the shell's panel `nav` in sync with the config: tag each row with
     * its entry id, hide the folded/hidden ones, and render the toggle row.
     * @param options - shared stores and the live translate getter.
     */
    function createAugmenter({ configStore, panelsStore, t }) {
      let nav = null
      let observer = null
      let hostEl = null
      let root = null
      let retry = null
      let frame = 0
      let disposed = false

      // The renderer stamps every slot container with `data-slot="<slot key>"`
      // (see dsh-client-ui-renderer lib/client.js: `"data-slot": slotKey`), so
      // the panel list lives under `[data-slot="sidebar.panellist"]`. Older
      // shells only had the coarse `[data-slot="sidebar"]`, hence both scopes.
      const SCOPES = ['[data-slot="sidebar.panellist"]', '[data-slot="sidebar"]']

      function findNav() {
        const candidates = []
        for (const scope of SCOPES) {
          const node = document.querySelector(scope)
          if (node !== null) candidates.push(...node.querySelectorAll('nav'))
        }
        const withButtons = candidates.find((node) => node.querySelector(':scope > button') !== null)
        if (withButtons !== undefined) return withButtons
        return [...document.querySelectorAll('nav')].find((node) =>
          [...node.children].some((child) => child.tagName === 'BUTTON' && /panelRow/.test(String(child.className)))) ?? null
      }

      function rowsOf(target) {
        return [...target.children].filter((child) => child.tagName === 'BUTTON')
      }

      function ensureToggle(target, rows) {
        const rail = rows.length > 0 && rows[0].children.length < 2
        const config = configStore.getSnapshot()
        const stats = foldStats(config, panelsStore.getSnapshot())
        if (!config.enabled || stats.fold === 0) {
          if (hostEl !== null && hostEl.parentNode === target) target.removeChild(hostEl)
          hostEl = null
          if (root !== null) { root.unmount(); root = null }
          return
        }
        if (hostEl === null || !hostEl.isConnected) {
          hostEl = document.createElement('div')
          hostEl.setAttribute(HOST_ATTR, '')
          target.appendChild(hostEl)
          root = createRoot(hostEl)
        }
        hostEl.setAttribute('data-dsh-sm-rail', rail ? '1' : '0')
        if (root !== null) {
          root.render(React.createElement(ToggleRow, { configStore, panelsStore, t, rail }))
        }
      }

      function sync() {
        if (disposed) return
        const target = nav !== null && nav.isConnected ? nav : findNav()
        if (target === null) return
        if (target !== nav) {
          nav = target
          target.setAttribute(NAV_ATTR, '1')
          observe(target)
        }
        const rows = rowsOf(target)
        const entries = panelsStore.getSnapshot()
        const config = configStore.getSnapshot()
        matchRows(rows, entries).forEach(({ row, entry }) => {
          if (entry === undefined) {
            row.removeAttribute(ROW_ATTR)
            row.removeAttribute(HIDDEN_ATTR)
            return
          }
          row.setAttribute(ROW_ATTR, entry.id)
          if (isRowHidden(config, entry.id)) row.setAttribute(HIDDEN_ATTR, '1')
          else row.removeAttribute(HIDDEN_ATTR)
        })
        ensureToggle(target, rows)
      }

      function schedule() {
        if (disposed || frame !== 0) return
        frame = window.requestAnimationFrame(() => {
          frame = 0
          sync()
        })
      }

      function observe(target) {
        if (observer !== null) observer.disconnect()
        const scope = target.closest(SCOPES.join(',')) ?? target.parentElement ?? document.body
        observer = new MutationObserver(() => { schedule() })
        observer.observe(scope, { childList: true, subtree: true })
      }

      function start() {
        sync()
        configStore.subscribe(schedule)
        panelsStore.subscribe(schedule)
        // The sidebar may mount after this plugin applies (boot order), and it
        // survives reloads of its own subtree: poll until the nav exists.
        retry = window.setInterval(() => {
          if (disposed) return
          if (nav === null || !nav.isConnected) sync()
        }, 500)
      }

      function dispose() {
        disposed = true
        if (retry !== null) window.clearInterval(retry)
        if (frame !== 0) window.cancelAnimationFrame(frame)
        if (observer !== null) observer.disconnect()
        observer = null
        if (root !== null) { try { root.unmount() } catch { /* already unmounted */ } }
        root = null
        hostEl = null
        nav = null
      }

      return { start, dispose }
    }

    // ----------------------------------------------------------- components --
    /** The in-list fold toggle, styled as one more panel row. */
    function ToggleRow({ configStore, panelsStore, t, rail }) {
      const config = useStore(configStore)
      const entries = useStore(panelsStore)
      const stats = foldStats(config, entries)
      if (!config.enabled || stats.fold === 0) return null
      const label = config.collapsed
        ? t()('toggle.fold', { count: stats.fold })
        : t()('toggle.unfold', { count: stats.fold })
      const toggle = () => {
        configStore.update((current) => ({ ...current, collapsed: !current.collapsed }))
      }
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsm-toggle',
          title: label,
          'aria-label': label,
          'aria-expanded': !config.collapsed,
          'data-dsh-sm-toggle': '',
          onClick: toggle,
        },
        React.createElement('span', { className: 'dsm-toggle-glyph', 'aria-hidden': 'true' },
          chevron(config.collapsed ? 'down' : 'up', rail ? 18 : 16)),
        React.createElement('span', { className: 'dsm-toggle-label' }, label),
      )
    }

    /** Small foot control: fold / unfold, with the folded count. */
    function FooterFold({ configStore, panelsStore, t, wide }) {
      const config = useStore(configStore)
      const entries = useStore(panelsStore)
      const stats = foldStats(config, entries)
      if (!config.enabled || stats.fold === 0) return null
      const label = config.collapsed
        ? t()('toggle.fold', { count: stats.fold })
        : t()('toggle.unfold', { count: stats.fold })
      return React.createElement(
        'button',
        {
          type: 'button',
          className: 'dsm-foot-btn',
          title: label,
          'aria-label': label,
          onClick: () => configStore.update((current) => ({ ...current, collapsed: !current.collapsed })),
        },
        chevron(config.collapsed ? 'down' : 'up', 16),
        wide ? React.createElement('span', null, String(stats.fold)) : null,
      )
    }

    /** Settings → 侧边栏: the full list with a per-entry tri-state control. */
    function SettingsSection({ configStore, panelsStore, t }) {
      const config = useStore(configStore)
      const entries = useStore(panelsStore)
      const stats = foldStats(config, entries)
      const setMode = (id, mode) => {
        configStore.update((current) => {
          const modes = { ...current.modes }
          if (mode === 'show' || mode === 'fold' || mode === 'hide') modes[id] = mode
          else delete modes[id]
          return { ...current, modes }
        })
      }
      const reset = () => {
        configStore.set(normalizeConfig({}))
      }
      // Bulk selection over whatever is registered right now — the list is
      // live, so "all" means all currently mounted panels, not a fixed set.
      const setAll = (mode) => {
        configStore.update((current) => {
          const modes = { ...current.modes }
          for (const entry of entries) modes[entry.id] = mode
          return { ...current, modes }
        })
      }
      const strip = React.createElement('div', { className: 'dsm-card' },
        React.createElement('div', { className: 'dsm-switch-row' },
          React.createElement('button', {
            type: 'button',
            className: 'dsm-switch',
            'data-on': config.enabled ? '1' : '0',
            role: 'switch',
            'aria-checked': config.enabled,
            'aria-label': t()('settings.enable'),
            onClick: () => configStore.update((current) => ({ ...current, enabled: !current.enabled })),
          }, React.createElement('span', null)),
          React.createElement('span', { className: 'dsm-switch-label' }, t()('settings.enable')),
        ),
        React.createElement('p', { className: 'dsm-hint' }, t()('settings.enableHint')),
      )

      const list = entries.length === 0
        ? React.createElement('p', { className: 'dsm-hint' }, t()('settings.listEmpty'))
        : React.createElement('div', { className: 'dsm-list' },
          entries.map((entry) => {
            const mode = effectiveMode(config, entry.id)
            return React.createElement('div', { className: 'dsm-item', key: entry.id },
              React.createElement('div', { className: 'dsm-item-text' },
                React.createElement('span', { className: 'dsm-item-label', title: entry.label }, entry.label),
                React.createElement('span', { className: 'dsm-item-id' }, entry.id),
              ),
              React.createElement('div', { className: 'dsm-seg', role: 'group', 'aria-label': entry.label },
                MODES.map((candidate) => React.createElement('button', {
                  key: candidate,
                  type: 'button',
                  'data-active': mode === candidate ? '1' : '0',
                  title: t()(`settings.mode.${candidate}Hint`),
                  'aria-pressed': mode === candidate,
                  onClick: () => setMode(entry.id, mode === candidate ? 'show' : candidate),
                }, t()(`settings.mode.${candidate}`))),
              ),
            )
          }),
        )

      const bulk = entries.length === 0 ? null : React.createElement('div', { className: 'dsm-bulk' },
        React.createElement('button', {
          type: 'button',
          className: 'dsm-bulk-btn',
          title: t()('settings.bulk.foldHint'),
          onClick: () => setAll('fold'),
        }, t()('settings.bulk.fold')),
        React.createElement('button', {
          type: 'button',
          className: 'dsm-bulk-btn',
          title: t()('settings.bulk.showHint'),
          onClick: () => setAll('show'),
        }, t()('settings.bulk.show')),
      )

      return React.createElement('div', { className: 'dsm-page', 'data-dsh-plugin': 'dsh-sidebar-manager' },
        React.createElement('div', { className: 'dsm-hero' },
          React.createElement('h2', { className: 'dsm-hero-title' }, t()('settings.title')),
          React.createElement('p', { className: 'dsm-hero-text' }, t()('settings.summary')),
        ),
        strip,
        React.createElement('div', { className: 'dsm-card' },
          React.createElement('div', { className: 'dsm-switch-row' },
            React.createElement('span', { className: 'dsm-switch-label' }, t()('settings.listTitle')),
            React.createElement('span', { className: 'dsm-count' },
              t()('settings.count', { fold: stats.fold, hidden: stats.hidden })),
          ),
          React.createElement('p', { className: 'dsm-hint' }, t()('settings.listHint')),
          bulk,
          list,
          React.createElement('div', { className: 'dsm-footer-row' },
            React.createElement('span', { className: 'dsm-hint' }, t()('settings.resetHint')),
            React.createElement('button', {
              type: 'button',
              className: 'dsm-reset',
              onClick: reset,
            }, t()('settings.reset')),
          ),
        ),
      )
    }

    exports.apply = apply
    exports.inject = inject
    exports.createAugmenter = createAugmenter
    exports.effectiveMode = effectiveMode
    exports.foldStats = foldStats
    exports.isRowHidden = isRowHidden
    exports.matchRows = matchRows
    exports.normalizeConfig = normalizeConfig
    exports.readPanels = readPanels
    exports.SettingsSection = SettingsSection
    return module.exports
  },
})
