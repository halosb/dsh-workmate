/**
 * dsh-workmate — browser half (settings page).
 *
 * 设置页分区「工作搭档」：任务通知 + 私有知识库。配置经插件自己的
 * host 端点持久化（GET/POST /wf/settings → config.json），并在页面
 * 可见性变化时向 /wf/visibility 心跳，支持「仅后台通知」。
 *
 * @author 芝麻 (halosb) <i@halosb.com>
 * License: MIT
 */
window.__ModuleLoader__.load({
  id: 'dsh-workmate',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var react = require('react')

    // ── 默认值（与 index.js 的 DEFAULT_CONFIG 保持一致） ───────────────────
    var DEFAULTS = {
      notifyEnabled: true,
      notifyMinDurationMs: 60000, // 毫秒；设置页以「秒」展示
      notifySystem: true,
      notifyWebhook: '',
      notifyOnError: true,
      notifyBackgroundOnly: true,
      soundEnabled: true,
      kbDir: '',
      kbExtensions: 'txt,md,json,yaml,yml,js,ts,jsx,tsx',
      kbChunkSize: 1000,
      kbOverlap: 100,
    }

    // ── Section UI stylesheet（与 DSH 设置页同一设计语言） ──────────────────
    var SECTION_CSS = [
      '.dsh-wm-section{display:flex;flex-direction:column;gap:4px;max-width:720px;color:var(--dsw-alias-label-primary);}',
      '.dsh-wm-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);}',
      '.dsh-wm-intro{margin:0 0 4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.dsh-wm-row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:1px solid var(--dsw-alias-border-l2);}',
      '.dsh-wm-row:last-child{border-bottom:none;}',
      '.dsh-wm-rowLabel{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;padding-right:24px;}',
      '.dsh-wm-rowTitle{font-size:14px;line-height:22px;font-weight:400;color:var(--dsw-alias-label-primary);}',
      '.dsh-wm-caption{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
      '.dsh-wm-groupTitle{font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary);padding:20px 0 0;}',
      '.dsh-wm-control{flex:none;display:flex;align-items:center;gap:10px;}',
      '.dsh-wm-input{box-sizing:border-box;width:100%;height:32px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;font:inherit;font-size:14px;line-height:22px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}',
      '.dsh-wm-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}',
      '.dsh-wm-input::placeholder{color:var(--dsw-alias-label-dimmed);}',
      '.dsh-wm-inputField{width:100%;max-width:320px;}',
      '.dsh-wm-inputNum{width:110px;}',
      '.dsh-wm-button{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:18px;background:transparent;cursor:pointer;font:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);}',
      '.dsh-wm-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}',
      '.dsh-wm-button:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active);}',
      '.dsh-wm-buttonPrimary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);}',
      '.dsh-wm-buttonPrimary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover);}',
      '.dsh-wm-button:disabled{cursor:not-allowed;opacity:0.4;}',
      '.dsh-wm-check{width:16px;height:16px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer;}',
      '.dsh-wm-checkText{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);cursor:pointer;}',
      '.dsh-wm-stats{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}',
    ].join('\n')

    /** Tiny observable store. */
    function createStore(initial) {
      var value = initial
      var listeners = []
      return {
        get: function () { return value },
        set: function (next) {
          value = next
          for (var i = 0; i < listeners.length; i++) listeners[i]()
        },
        subscribe: function (listener) {
          listeners.push(listener)
          return function () {
            var at = listeners.indexOf(listener)
            if (at !== -1) listeners.splice(at, 1)
          }
        },
      }
    }

    exports.inject = ['slots']

    exports.apply = function (ctx) {
      var store = createStore(Object.assign({}, DEFAULTS))

      fetch('/wf/settings').then(function (r) { return r.json() }).then(function (cfg) {
        store.set(Object.assign({}, DEFAULTS, cfg && typeof cfg === 'object' ? cfg : {}))
      }).catch(function () {})

      function persist(cfg) {
        fetch('/wf/settings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(cfg),
        }).catch(function () {})
      }

      // 可见性心跳：支持「仅后台通知」。
      function heartbeat() {
        fetch('/wf/visibility', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visible: document.visibilityState !== 'hidden' }),
        }).catch(function () {})
      }
      ctx.effect(function () {
        heartbeat()
        document.addEventListener('visibilitychange', heartbeat)
        return function () { document.removeEventListener('visibilitychange', heartbeat) }
      }, 'dsh-workmate: visibility heartbeat')

      ctx.effect(function () {
        var styleEl = document.createElement('style')
        styleEl.setAttribute('data-plugin-css', 'dsh-workmate-ui')
        styleEl.textContent = SECTION_CSS
        document.head.appendChild(styleEl)
        return function () { styleEl.remove() }
      }, 'dsh-workmate: section ui styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'workmate',
          order: 35,
          label: function () { return '工作搭档' },
          inject: function () { return { store: store, persist: persist } },
        }, WorkmateSection)
      })
    }

    // ── settings page UI ─────────────────────────────────────────────────────

    function el(type, props) {
      var args = [type, props]
      for (var i = 2; i < arguments.length; i++) args.push(arguments[i])
      return react.createElement.apply(null, args)
    }

    function Row(props) {
      return el('div', { className: 'dsh-wm-row' },
        el('div', { className: 'dsh-wm-rowLabel' },
          el('div', { className: 'dsh-wm-rowTitle' }, props.title),
          props.caption !== undefined ? el('div', { className: 'dsh-wm-caption' }, props.caption) : null,
        ),
        el('div', { className: 'dsh-wm-control' }, props.children),
      )
    }

    function CheckRow(props) {
      return el('label', { className: 'dsh-wm-checkText', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
        el('input', {
          type: 'checkbox', className: 'dsh-wm-check', checked: props.checked === true,
          onChange: function (e) { props.onChange(e.target.checked) },
        }),
        props.label,
      )
    }

    function WorkmateSection(props) {
      var store = props.store
      var persist = props.persist
      var tick = react.useState(0)
      var stats = react.useState(null)
      react.useEffect(function () {
        return store.subscribe(function () { tick[1](function (n) { return n + 1 }) })
      }, [])
      // 进入设置页时拉取当前索引状态，避免服务端已索引却显示"未索引"。
      react.useEffect(function () {
        fetch('/wf/kb/status').then(function (r) { return r.json() }).then(function (json) {
          if (json !== null && json.configured === true) stats[1](json.stats)
        }).catch(function () {})
      }, [])
      var s = store.get()

      function setField(field, value) {
        var next = Object.assign({}, s)
        next[field] = value
        store.set(next)
        persist(next)
      }

      function reindex() {
        stats[1]('索引中…')
        fetch('/wf/kb/reindex', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }).then(function (r) { return r.json() }).then(function (json) {
          if (json !== null && json.ok === true) stats[1](json.stats)
          else stats[1]({ message: json && json.message ? json.message : '索引失败' })
        }).catch(function () { stats[1]({ message: '索引失败' }) })
      }

      function resetAll() {
        store.set(Object.assign({}, DEFAULTS))
        persist(Object.assign({}, DEFAULTS))
      }

      var statText = '未索引'
      if (typeof stats[0] === 'string') statText = stats[0]
      else if (stats[0] !== null && typeof stats[0] === 'object') {
        if (stats[0].message) statText = stats[0].message
        else statText = '文件 ' + stats[0].fileCount + ' · 块 ' + stats[0].chunkCount + ' · 词 ' + stats[0].wordCount
      }

      return el('div', { className: 'dsh-wm-section' },
        el('h2', { className: 'dsh-wm-title' }, '工作搭档'),
        el('p', { className: 'dsh-wm-intro' }, '长任务完成通知 + 私有知识库，改动即时生效并持久保存。'),

        el('div', { className: 'dsh-wm-groupTitle' }, '任务通知'),
        Row({
          title: '启用任务通知',
          caption: '长任务（超过阈值）结束/失败时提醒。',
          children: CheckRow({ checked: s.notifyEnabled, onChange: function (v) { setField('notifyEnabled', v) }, label: '启用' }),
        }),
        Row({
          title: '时长阈值（秒）',
          caption: 'Agent 持续运行超过该时长后结束才算“长任务”，短任务不打扰。',
          children: el('input', {
            type: 'number', className: 'dsh-wm-input dsh-wm-inputNum', min: '0', step: '5',
            value: String(Math.round((s.notifyMinDurationMs || 0) / 1000)),
            onChange: function (e) { setField('notifyMinDurationMs', Math.max(0, Number(e.target.value)) * 1000) },
          }),
        }),
        Row({
          title: '系统通知',
          caption: 'Windows 原生 Toast。',
          children: CheckRow({ checked: s.notifySystem, onChange: function (v) { setField('notifySystem', v) }, label: '启用' }),
        }),
        Row({
          title: 'Webhook 推送',
          caption: '任务结束时 POST JSON 到该地址（企业微信/Telegram/自建服务）；留空 = 不推送。',
          children: el('input', {
            type: 'text', className: 'dsh-wm-input dsh-wm-inputField',
            value: s.notifyWebhook, placeholder: 'https://…',
            onChange: function (e) { setField('notifyWebhook', e.target.value) },
          }),
        }),
        Row({
          title: '失败也通知',
          caption: 'Agent 报错时同样提醒。',
          children: CheckRow({ checked: s.notifyOnError, onChange: function (v) { setField('notifyOnError', v) }, label: '启用' }),
        }),
        Row({
          title: '仅后台通知',
          caption: '浏览器标签页可见时不打扰，切到后台才提醒。',
          children: CheckRow({ checked: s.notifyBackgroundOnly, onChange: function (v) { setField('notifyBackgroundOnly', v) }, label: '启用' }),
        }),
        Row({
          title: '音效反馈',
          caption: '每次任务完成“叮”、失败低音、审批出现提醒音；不受阈值与前后台限制（需系统音量）。',
          children: CheckRow({ checked: s.soundEnabled, onChange: function (v) { setField('soundEnabled', v) }, label: '启用' }),
        }),

        el('div', { className: 'dsh-wm-groupTitle' }, '私有知识库'),
        Row({
          title: '索引目录',
          caption: '本地文档目录的绝对路径；提问时模型会调用 kb_search 检索。',
          children: el('input', {
            type: 'text', className: 'dsh-wm-input dsh-wm-inputField',
            value: s.kbDir, placeholder: 'D:\\docs',
            onChange: function (e) { setField('kbDir', e.target.value) },
          }),
        }),
        Row({
          title: '支持格式',
          caption: '逗号分隔的扩展名白名单。',
          children: el('input', {
            type: 'text', className: 'dsh-wm-input dsh-wm-inputField',
            value: s.kbExtensions,
            onChange: function (e) { setField('kbExtensions', e.target.value) },
          }),
        }),
        Row({
          title: '分块大小 / 重叠',
          caption: '文档切块长度与重叠字符数，检索粒度。',
          children: el('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
            el('input', {
              type: 'number', className: 'dsh-wm-input dsh-wm-inputNum', min: '100', step: '100',
              value: String(s.kbChunkSize),
              onChange: function (e) { setField('kbChunkSize', Math.max(100, Number(e.target.value))) },
            }),
            el('span', { className: 'dsh-wm-caption' }, '重叠'),
            el('input', {
              type: 'number', className: 'dsh-wm-input dsh-wm-inputNum', min: '0', step: '50',
              value: String(s.kbOverlap),
              onChange: function (e) { setField('kbOverlap', Math.max(0, Number(e.target.value))) },
            }),
          ),
        }),
        Row({
          title: '重新索引',
          caption: '文档变更后手动重建索引（自动保留网页捕获）；重启时也会自动索引。',
          children: el('div', { className: 'dsh-wm-control', style: { alignItems: 'center' } },
            el('button', { type: 'button', className: 'dsh-wm-button', onClick: reindex }, '重新索引'),
            el('span', { className: 'dsh-wm-stats' }, statText),
          ),
        }),

        el('div', { className: 'dsh-wm-row' },
          el('div', { className: 'dsh-wm-rowLabel' },
            el('div', { className: 'dsh-wm-rowTitle' }, '恢复默认'),
            el('div', { className: 'dsh-wm-caption' }, '全部配置回到出厂值。'),
          ),
          el('div', { className: 'dsh-wm-control' },
            el('button', { type: 'button', className: 'dsh-wm-button dsh-wm-buttonPrimary', onClick: resetAll }, '恢复默认'),
          ),
        ),
      )
    }

    exports.WorkmateSection = WorkmateSection
    return module.exports
  },
})
