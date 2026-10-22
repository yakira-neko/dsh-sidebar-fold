/**
 * Headless contract tests for dsh-sidebar-fold.
 *
 * The plugin's risky surface is DOM bookkeeping against a shell it does not
 * own, so these tests run the real `lib/client.js` against a minimal DOM shim
 * that implements exactly the API the plugin uses. React and react-dom are
 * stubbed: the row mapping / hiding / toggle lifecycle is what must be right,
 * and that runs entirely on plain DOM calls.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

// ------------------------------------------------------------------ shim --
class ClassList {
  constructor(el) { this.el = el }
}

let styles = []

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase()
    this.children = []
    this.parentNode = null
    this.className = ''
    this.id = ''
    this.textContent = ''
    this.dataset = {}
    this.style = {}
    this.attrs = new Map()
    this.classList = new ClassList(this)
    this.removed = false
  }

  get isConnected() {
    let node = this
    while (node.parentNode !== null) node = node.parentNode
    return node === document
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value))
    if (name === 'id') this.id = String(value)
    if (name.startsWith('data-')) {
      const key = name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      this.dataset[key] = String(value)
    }
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }

  hasAttribute(name) {
    return this.attrs.has(name)
  }

  removeAttribute(name) {
    this.attrs.delete(name)
  }

  appendChild(child) {
    child.parentNode = this
    this.children.push(child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode !== null) this.parentNode.removeChild(this)
    this.removed = true
  }

  matches(simple) {
    const text = String(simple).trim()
    if (text.startsWith('.')) return this.className.split(/\s+/).includes(text.slice(1))
    const attrEqual = /^\[([\w-]+)="([^"]*)"\]$/.exec(text)
    if (attrEqual !== null) return this.getAttribute(attrEqual[1]) === attrEqual[2]
    const attrOnly = /^\[([\w-]+)\]$/.exec(text)
    if (attrOnly !== null) return this.hasAttribute(attrOnly[1])
    return this.tagName === text.toUpperCase()
  }

  querySelectorAll(selector) {
    if (String(selector).startsWith(':scope >')) {
      const rest = String(selector).slice(':scope >'.length).trim()
      return this.children.filter((child) => child.matches(rest))
    }
    const out = []
    const walk = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) out.push(child)
        walk(child)
      }
    }
    walk(this)
    return out
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  closest(selector) {
    let node = this
    while (node !== null && node !== document) {
      if (node.matches && node.matches(selector)) return node
      node = node.parentNode
    }
    return null
  }

  contains(other) {
    let node = other
    while (node !== null) {
      if (node === this) return true
      node = node.parentNode
    }
    return false
  }
}

const document = new El('document')
document.head = new El('head')
document.body = new El('body')
document.appendChild(document.head)
document.appendChild(document.body)
document.createElement = (tag) => new El(tag)
document.getElementById = (id) => {
  const found = document.body.querySelectorAll('style').concat(document.head.children)
  return found.find((node) => node.id === id) ?? null
}

const frames = []
const timers = []
class MutationObserverShim {
  constructor(callback) { this.callback = callback; this.records = [] }
  observe(target, options) { this.target = target; this.options = options }
  disconnect() { this.active = false }
  takeRecords() { return [] }
}

const storage = new Map()
const windowShim = {
  document,
  localStorage: {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)) },
    removeItem: (key) => { storage.delete(key) },
  },
  requestAnimationFrame: (fn) => { frames.push(fn); return frames.length },
  cancelAnimationFrame: (id) => { frames[id - 1] = null },
  setInterval: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length },
  clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true },
  MutationObserver: MutationObserverShim,
  setTimeout,
  clearTimeout,
}

globalThis.window = windowShim
globalThis.document = document
globalThis.MutationObserver = MutationObserverShim

function flushFrames() {
  while (frames.length > 0) {
    const fn = frames.shift()
    if (typeof fn === 'function') fn(0)
  }
}

// ----------------------------------------------------------------- react --
function Text(props) { return { type: 'TEXT', props } }
const ReactShim = {
  createElement(type, props, ...children) {
    return { type, props: { ...(props ?? {}), children: children.length <= 1 ? children[0] : children } }
  },
  Fragment: 'Fragment',
  useSyncExternalStore(subscribe, getSnapshot) {
    return getSnapshot()
  },
}

let lastToggleRender = null
const createRootShim = (host) => ({
  render(element) {
    const rendered = element !== null && typeof element.type === 'function'
      ? element.type(element.props)
      : element
    lastToggleRender = { host, element: rendered }
  },
  unmount() { lastToggleRender = null },
})

const requireShim = (id) => {
  if (id === 'react') return ReactShim
  if (id === 'react-dom/client') return { createRoot: createRootShim }
  throw new Error(`unexpected require: ${id}`)
}

// ------------------------------------------------------------- load module --
let factory = null
windowShim.__ModuleLoader__ = {
  load(entry) { factory = entry.factory },
}

const modulePath = pathToFileURL(resolve(import.meta.dirname, '../lib/client.js')).href
await import(modulePath)

assert.equal(typeof factory, 'function', 'client.js must register through __ModuleLoader__')
const client = factory(requireShim)

// ------------------------------------------------------------- unit tests --
/** Depth-first collect of rendered elements carrying an exact className. */
function collect(node, className, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) collect(child, className, found)
    return found
  }
  if (node.props !== undefined && node.props.className === className) found.push(node)
  if (node.props !== undefined) collect(node.props.children, className, found)
  return found
}

test('config normalization rejects unknown modes and defaults to enabled+folded', () => {
  assert.deepEqual(client.normalizeConfig(undefined), { enabled: true, collapsed: true, modes: {} })
  assert.deepEqual(
    client.normalizeConfig({ enabled: false, collapsed: false, modes: { a: 'fold', b: 'nope', c: 42 } }),
    { enabled: false, collapsed: false, modes: { a: 'fold' } },
  )
  assert.equal(client.normalizeConfig({ enabled: 'yes' }).enabled, true)
})

test('built-in panels show by default, plugin panels fold', () => {
  const config = client.normalizeConfig({})
  assert.equal(client.effectiveMode(config, 'plugins'), 'show')
  assert.equal(client.effectiveMode(config, 'schedules'), 'show')
  assert.equal(client.effectiveMode(config, 'ssh'), 'fold')
  assert.equal(client.effectiveMode({ ...config, modes: { ssh: 'hide' } }, 'ssh'), 'hide')
  assert.equal(client.effectiveMode({ ...config, modes: { plugins: 'fold' } }, 'plugins'), 'fold')
})

test('hidden rows follow enabled/collapsed/mode', () => {
  const base = client.normalizeConfig({})
  assert.equal(client.isRowHidden(base, 'plugins'), false)
  assert.equal(client.isRowHidden(base, 'ssh'), true) // fold + collapsed
  assert.equal(client.isRowHidden({ ...base, collapsed: false }, 'ssh'), false)
  assert.equal(client.isRowHidden({ ...base, enabled: false }, 'ssh'), false)
  assert.equal(client.isRowHidden({ ...base, collapsed: false, modes: { ssh: 'hide' } }, 'ssh'), true)
})

test('foldStats counts folded and hidden entries', () => {
  const entries = [{ id: 'plugins' }, { id: 'schedules' }, { id: 'ssh' }, { id: 'board' }]
  const config = client.normalizeConfig({ modes: { board: 'hide' } })
  assert.deepEqual(client.foldStats(config, entries), { fold: 1, hidden: 1 })
})

test('readPanels sorts by order and resolves thunk labels', () => {
  const slots = {
    entriesOfSlot: () => [
      { options: { id: 'b', order: 10, label: () => 'B' } },
      { options: { id: 'a', order: 0, label: 'A' } },
      { options: { id: 'c', order: 5 } },
    ],
  }
  assert.deepEqual(client.readPanels(slots), [
    { id: 'a', order: 0, label: 'A' },
    { id: 'c', order: 5, label: 'c' },
    { id: 'b', order: 10, label: 'B' },
  ])
})

// --------------------------------------------------------- augmenter tests --
function makeSidebar(rowWidths, slotKey = 'sidebar.panellist') {
  const scope = new El('div')
  scope.setAttribute('data-slot', slotKey)
  const nav = new El('nav')
  nav.className = '_2H3hWW_panelList'
  scope.appendChild(nav)
  document.body.appendChild(scope)
  rowWidths.forEach((width) => {
    const row = new El('button')
    row.className = '_2H3hWW_panelRow'
    row.appendChild(new El('span'))
    if (width > 1) row.appendChild(new El('span'))
    nav.appendChild(row)
  })
  return { scope, nav, rows: [...nav.children] }
}

function makeStores(entries, config) {
  const stores = []
  const store = (initial) => {
    let value = initial
    const listeners = new Set()
    const api = {
      getSnapshot: () => value,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      set(next) { value = next; for (const fn of [...listeners]) fn() },
      update(fn) { api.set(fn(value)) },
      notify() { for (const fn of [...listeners]) fn() },
    }
    stores.push(api)
    return api
  }
  return {
    configStore: store(client.normalizeConfig(config)),
    panelsStore: store(entries),
    stores,
  }
}

const ENTRIES = [
  { id: 'plugins', order: 0, label: '插件' },
  { id: 'schedules', order: 10, label: '自动化任务' },
  { id: 'ssh', order: 20, label: 'SSH' },
  { id: 'board', order: 30, label: '任务看板' },
]

test('augmenter tags rows by entry id and hides folded ones', () => {
  const { nav, rows } = makeSidebar([2, 2, 2, 2])
  const { configStore, panelsStore } = makeStores(ENTRIES, {})
  const augmenter = client.createAugmenter({ configStore, panelsStore, t: () => (k) => k })
  augmenter.start()
  flushFrames()

  assert.equal(nav.getAttribute('data-dsh-sf-nav'), '1')
  assert.deepEqual(rows.map((row) => row.getAttribute('data-dsh-sf-row')), ['plugins', 'schedules', 'ssh', 'board'])
  assert.equal(rows[0].getAttribute('data-dsh-sf-hidden'), null)
  assert.equal(rows[1].getAttribute('data-dsh-sf-hidden'), null)
  assert.equal(rows[2].getAttribute('data-dsh-sf-hidden'), '1')
  assert.equal(rows[3].getAttribute('data-dsh-sf-hidden'), '1')

  const host = nav.querySelector('[data-dsh-sf-host]')
  assert.ok(host, 'fold toggle host must be appended to the panel nav')
  assert.equal(host.getAttribute('data-dsh-sf-rail'), '0')
  assert.equal(lastToggleRender.element.props.className, 'dsf-toggle')

  augmenter.dispose()
  nav.remove()
})

test('row pairing prefers the aria-label and degrades to position', () => {
  const entries = [
    { id: 'a', order: 0, label: '插件' },
    { id: 'b', order: 1, label: '自动化任务' },
    { id: 'c', order: 2, label: 'SSH' },
  ]
  const button = (label) => {
    const node = new El('button')
    if (label !== undefined) node.setAttribute('aria-label', label)
    return node
  }

  // Order-independent: rows are matched by their label, not their position.
  const shuffled = client.matchRows([button('SSH'), button('插件'), button('自动化任务')], entries)
  assert.deepEqual(shuffled.map((pair) => pair.entry.id), ['c', 'a', 'b'])

  // A row without a label takes the entry at its own position.
  const mixed = client.matchRows([button('插件'), button(), button('SSH')], entries)
  assert.deepEqual(mixed.map((pair) => pair.entry.id), ['a', 'b', 'c'])

  // Extra rows have no entry and are left untagged by the caller.
  const extra = client.matchRows([button('插件'), button('自动化任务'), button('SSH'), button('新面板')], entries)
  assert.deepEqual(extra.map((pair) => (pair.entry === undefined ? null : pair.entry.id)), ['a', 'b', 'c', null])
})

test('settings lists every live panel, not a fixed set, and bulk-folds them', () => {
  const extra = [...ENTRIES, { id: 'dshmarket', order: 90, label: '插件市场' }]
  const { configStore, panelsStore } = makeStores(extra, { modes: { ssh: 'show' } })
  const t = () => (key) => key
  const tree = client.SettingsSection({ configStore, panelsStore, t })

  // The list is derived from the live slot entries: adding an entry to the
  // store adds a row, so any future plugin panel is selectable.
  assert.equal(collect(tree, 'dsf-item').length, extra.length)
  panelsStore.set([...extra, { id: 'codex', order: 91, label: 'Codex' }])
  assert.equal(collect(client.SettingsSection({ configStore, panelsStore, t }), 'dsf-item').length, extra.length + 1)

  const [foldAll, showAll] = collect(tree, 'dsf-bulk-btn')
  foldAll.props.onClick()
  for (const entry of extra) assert.equal(configStore.getSnapshot().modes[entry.id], 'fold')
  showAll.props.onClick()
  for (const entry of extra) assert.equal(configStore.getSnapshot().modes[entry.id], 'show')
})

test('unfolding, disabling and per-entry overrides re-hide correctly', () => {
  const { nav, rows } = makeSidebar([2, 2, 2, 2])
  const { configStore, panelsStore } = makeStores(ENTRIES, {})
  const augmenter = client.createAugmenter({ configStore, panelsStore, t: () => (k) => k })
  augmenter.start()
  flushFrames()

  configStore.update((config) => ({ ...config, collapsed: false }))
  flushFrames()
  assert.deepEqual(rows.map((row) => row.getAttribute('data-dsh-sf-hidden')), [null, null, null, null])

  configStore.update((config) => ({ ...config, collapsed: true, modes: { ssh: 'show' } }))
  flushFrames()
  assert.equal(rows[2].getAttribute('data-dsh-sf-hidden'), null)
  assert.equal(rows[3].getAttribute('data-dsh-sf-hidden'), '1')

  configStore.update((config) => ({ ...config, enabled: false }))
  flushFrames()
  assert.deepEqual(rows.map((row) => row.getAttribute('data-dsh-sf-hidden')), [null, null, null, null])
  assert.equal(nav.querySelector('[data-dsh-sf-host]'), null, 'toggle disappears when folding is off')

  augmenter.dispose()
  nav.remove()
})

test('rail mode (single-child rows) is detected and the toggle host stays last', () => {
  const { nav } = makeSidebar([1, 1, 1, 1])
  const { configStore, panelsStore } = makeStores(ENTRIES, {})
  const augmenter = client.createAugmenter({ configStore, panelsStore, t: () => (k) => k })
  augmenter.start()
  flushFrames()

  const host = nav.querySelector('[data-dsh-sf-host]')
  assert.equal(host.getAttribute('data-dsh-sf-rail'), '1')
  assert.equal(nav.children[nav.children.length - 1], host)

  augmenter.dispose()
  nav.remove()
})

test('legacy shells without a panellist slot key still resolve the nav', () => {
  const { nav } = makeSidebar([2, 2, 2, 2], 'sidebar')
  const { configStore, panelsStore } = makeStores(ENTRIES, {})
  const augmenter = client.createAugmenter({ configStore, panelsStore, t: () => (k) => k })
  augmenter.start()
  flushFrames()

  assert.equal(nav.getAttribute('data-dsh-sf-nav'), '1')
  assert.equal(nav.querySelector('[data-dsh-sf-host]') !== null, true)

  augmenter.dispose()
  nav.remove()
})

test('a sidebar remount re-tags the fresh nav', () => {
  const first = makeSidebar([2, 2, 2, 2])
  const { configStore, panelsStore } = makeStores(ENTRIES, {})
  const augmenter = client.createAugmenter({ configStore, panelsStore, t: () => (k) => k })
  augmenter.start()
  flushFrames()
  assert.equal(first.nav.getAttribute('data-dsh-sf-nav'), '1')

  const second = makeSidebar([2, 2, 2, 2])
  first.scope.remove()
  flushFrames()
  timers.filter((timer) => !timer.cleared).forEach((timer) => timer.fn())
  flushFrames()

  assert.equal(second.nav.getAttribute('data-dsh-sf-nav'), '1')
  assert.equal(second.rows[2].getAttribute('data-dsh-sf-hidden'), '1')

  augmenter.dispose()
  second.scope.remove()
})

test('rows without a matching entry are cleaned up', () => {
  const { nav, rows } = makeSidebar([2, 2, 2, 2])
  const { configStore, panelsStore } = makeStores(ENTRIES, {})
  const augmenter = client.createAugmenter({ configStore, panelsStore, t: () => (k) => k })
  augmenter.start()
  flushFrames()

  panelsStore.set(ENTRIES.slice(0, 2))
  flushFrames()
  assert.equal(rows[2].getAttribute('data-dsh-sf-row'), null)
  assert.equal(rows[2].getAttribute('data-dsh-sf-hidden'), null)
  assert.equal(nav.querySelector('[data-dsh-sf-host]'), null)

  augmenter.dispose()
  nav.remove()
})

// ------------------------------------------------------------ integration --
function makeCtx(entries) {
  const registered = []
  const subscriptions = []
  const dicts = new Map()
  const ctx = {
    effect(fn) { return fn() },
    locale: {
      register(ns, value) { dicts.set(ns, value); return () => dicts.delete(ns) },
      bind(ns) {
        return (key, params) => {
          const table = (dicts.get(ns) ?? {}).zh ?? {}
          const raw = table[key] ?? key
          return params === undefined
            ? raw
            : raw.replace(/\{(\w+)\}/g, (_, name) => String(params[name] ?? ''))
        }
      },
      subscribe(fn) { subscriptions.push(fn); return () => {} },
    },
    slots: {
      entriesOfSlot: () => entries.map((entry) => ({ options: entry })),
      subscribe(slot, fn) { subscriptions.push(fn); return () => {} },
      inject(slot, callback) { const value = callback(); registered.push({ slot, value }); return () => {} },
      register(options) { return { options, dispose() {} } },
    },
  }
  return { ctx, registered, subscriptions, dicts }
}

test('apply() mounts styles, seats and the DOM augmenter', () => {
  const { nav, rows } = makeSidebar([2, 2, 2, 2])
  const { ctx, registered } = makeCtx(ENTRIES)
  assert.equal(typeof client.apply, 'function')
  assert.deepEqual(client.inject, ['slots', 'locale'])

  client.apply(ctx)
  flushFrames()

  const slots = registered.map((item) => item.slot)
  assert.ok(slots.includes('settings.section'), 'settings page must be registered')
  assert.ok(slots.includes('sidebar.footer.action'), 'foot fold control must be registered')
  assert.ok(document.getElementById('dsh-sidebar-fold/styles'), 'CSS must be injected')
  assert.equal(rows[2].getAttribute('data-dsh-sf-hidden'), '1')

  nav.remove()
})

test('every row can be forced visible, leaving only a bare list', () => {
  const { nav, rows } = makeSidebar([2, 2, 2, 2])
  const { configStore, panelsStore } = makeStores(ENTRIES, { modes: { ssh: 'show', board: 'show' } })
  const augmenter = client.createAugmenter({ configStore, panelsStore, t: () => (k) => k })
  augmenter.start()
  flushFrames()

  assert.deepEqual(rows.map((row) => row.getAttribute('data-dsh-sf-hidden')), [null, null, null, null])
  assert.equal(nav.querySelector('[data-dsh-sf-host]'), null)

  augmenter.dispose()
  nav.remove()
})
