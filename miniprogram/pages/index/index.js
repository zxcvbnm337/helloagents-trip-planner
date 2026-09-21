var request = require('../../utils/request')
var format = require('../../utils/format')
var storage = require('../../utils/storage')
var cloudStore = require('../../utils/cloudStore')
var AI_LABEL = require('../../config/index').AI_LABEL

var MAX_DAYS = 30
var MAX_RANGE_DAYS = 365

var TRANSPORTATION_OPTIONS = ['公共交通', '自驾', '步行', '混合']
var ACCOMMODATION_OPTIONS = ['经济型酒店', '舒适型酒店', '豪华酒店', '民宿']
var PREFERENCE_OPTIONS = ['历史文化', '自然风光', '美食', '购物', '艺术', '休闲']

// 请求期间展示的模拟进度节点（真实进度后端不返回，这里只做体验优化）
var PROGRESS_STEPS = [
  { limit: 20, text: '正在搜索景点…' },
  { limit: 45, text: '正在查询天气…' },
  { limit: 65, text: '正在推荐酒店…' },
  { limit: 92, text: '正在生成行程计划…' }
]

function progressTextOf(value) {
  for (var i = 0; i < PROGRESS_STEPS.length; i++) {
    if (value <= PROGRESS_STEPS[i].limit) {
      return PROGRESS_STEPS[i].text
    }
  }
  return PROGRESS_STEPS[PROGRESS_STEPS.length - 1].text
}

function buildPreferenceList(selected) {
  var chosen = selected || []
  var list = []
  for (var i = 0; i < PREFERENCE_OPTIONS.length; i++) {
    list.push({
      label: PREFERENCE_OPTIONS[i],
      checked: chosen.indexOf(PREFERENCE_OPTIONS[i]) > -1
    })
  }
  return list
}

Page({
  data: {
    city: '',
    startDate: '',
    endDate: '',
    travelDays: 0,
    travelDaysText: '待选择',
    minDate: '',
    maxDate: '',

    transportationOptions: TRANSPORTATION_OPTIONS,
    transportationIndex: 0,
    accommodationOptions: ACCOMMODATION_OPTIONS,
    accommodationIndex: 0,
    preferenceList: buildPreferenceList([]),
    freeText: '',

    // AI 生成内容标识（文案来源见 config/index.js，勿在此硬编码）
    aiBadge: AI_LABEL.badge,
    aiNotice: AI_LABEL.notice,

    loading: false,
    progress: 0,
    progressText: '',

    hasHistory: false,
    historyText: '',
    // 这份行程是从哪来的：'cloud' = 已同步到云端（换设备也能看到），'local' = 仅本机
    historySource: ''
  },

  isUnloaded: false,
  timer: null,

  onLoad: function () {
    var today = new Date()
    this.setData({
      minDate: format.formatDate(today),
      maxDate: format.formatDate(format.addDays(today, MAX_RANGE_DAYS))
    })
  },

  onShow: function () {
    this.refreshHistory()
  },

  onUnload: function () {
    this.isUnloaded = true
    this.stopProgress()
  },

  onShareAppMessage: function () {
    return {
      title: '用 AI 规划一次说走就走的旅行',
      path: '/pages/index/index'
    }
  },

  /* ---------------- 上次行程 ---------------- */

  /**
   * 只负责把「本地缓存的这份行程」渲染到界面
   */
  applyHistory: function (meta, plan, source) {
    if (meta && plan) {
      this.setData({
        hasHistory: true,
        historyText: (meta.city || '上次行程') + ' · ' + (meta.dayCount || 0) + ' 天',
        historySource: source || 'local'
      })
    } else {
      this.setData({
        hasHistory: false,
        historyText: '',
        historySource: ''
      })
    }
  },

  /**
   * 刷新「上次生成的行程」。
   *
   * 顺序很关键：**先同步渲染本地缓存**，再异步问云端。
   * 这样云数据库没建 / 没网时界面也立刻可用，不会白屏等待。
   *
   * 云端的定位是"兜底与跨设备"，不是"唯一来源"：
   * 结果页永远读本地缓存，云端内容会被拉下来覆盖本地，而不是让页面去读云。
   */
  refreshHistory: function () {
    var self = this
    var meta = storage.loadMeta()
    var plan = storage.loadPlan()

    this.applyHistory(meta, plan, meta && meta.cloudId ? 'cloud' : 'local')

    if (!cloudStore.isEnabled()) {
      return
    }

    cloudStore.fetchLatest().then(function (res) {
      if (self.isUnloaded || !res.ok) {
        return
      }

      var localSavedAt = (meta && meta.savedAt) || 0
      var remote = res.record

      // 云端还没有记录 → 把本地这份补传上去
      // （覆盖"生成时集合还没建、后来才建好"的情况，否则第一份永远上不去）
      if (!remote) {
        if (plan) {
          self.pushToCloud(plan, localSavedAt)
        }
        return
      }

      // 时间戳相同 = 两边就是同一份，什么都不做
      // （少了这一步，每次进页面都会重复上传，见 cloudStore.savePlan 的注释）
      if (remote.savedAt === localSavedAt) {
        if (!meta || !meta.cloudId) {
          storage.savePlan(remote.plan, { cloudId: remote.id, savedAt: remote.savedAt })
          self.applyHistory(storage.loadMeta(), storage.loadPlan(), 'cloud')
        }
        return
      }

      // 云端更新（典型场景：换了设备）→ 拉下来写进本地缓存，结果页读的仍是本地
      if (remote.savedAt > localSavedAt) {
        storage.savePlan(remote.plan, { cloudId: remote.id, savedAt: remote.savedAt })
        self.applyHistory(storage.loadMeta(), storage.loadPlan(), 'cloud')
        console.log('[cloudStore] 已用云端行程更新本地缓存:', remote.city)
        return
      }

      // 本地更新（生成时云端不可用）→ 补传
      if (plan) {
        self.pushToCloud(plan, localSavedAt)
      }
    })
  },

  /**
   * 把一份行程写入云端，成功后就地记下 cloudId，
   * 这样「清除」时能顺带把云端那条也删掉，不留孤儿数据。
   */
  pushToCloud: function (plan, savedAt) {
    cloudStore.savePlan(plan, { savedAt: savedAt }).then(function (res) {
      if (!res.ok) {
        return
      }
      storage.savePlan(plan, { cloudId: res.id, savedAt: savedAt })
      console.log('[cloudStore] 行程已同步到云端:', res.id)
    })
  },

  goHistory: function () {
    wx.navigateTo({ url: '/pages/result/result' })
  },

  onClearHistory: function () {
    var self = this
    var meta = storage.loadMeta()
    var cloudId = (meta && meta.cloudId) || ''
    var cloudOn = cloudStore.isEnabled()

    wx.showModal({
      title: '清除行程记录',
      content: cloudOn
        ? '将删除本机保存的行程，并同步删除云端副本（删除后换设备也看不到了）。'
        : '将删除本机保存的行程，不影响已生成的内容。',
      success: function (res) {
        if (!res.confirm) {
          return
        }

        storage.clearPlan()
        self.applyHistory(null, null, '')

        if (!cloudOn) {
          wx.showToast({ title: '已清除', icon: 'none' })
          return
        }

        if (cloudId) {
          cloudStore.removeById(cloudId).then(function (r) {
            wx.showToast({
              title: r.ok ? '已清除（含云端）' : '本机已清除，云端删除失败',
              icon: 'none'
            })
          })
          return
        }

        // 本地没记 cloudId（例如之前只清过本地）→ 先问云端要 id 再删
        cloudStore.fetchLatest().then(function (r) {
          if (!r.ok || !r.record) {
            wx.showToast({ title: '已清除', icon: 'none' })
            return
          }
          cloudStore.removeById(r.record.id).then(function (rr) {
            wx.showToast({
              title: rr.ok ? '已清除（含云端）' : '本机已清除，云端删除失败',
              icon: 'none'
            })
          })
        })
      }
    })
  },

  /* ---------------- 表单交互 ---------------- */

  onCityInput: function (e) {
    this.setData({ city: e.detail.value })
  },

  onStartDateChange: function (e) {
    this.setData({ startDate: e.detail.value })
    this.syncDays()
  },

  onEndDateChange: function (e) {
    this.setData({ endDate: e.detail.value })
    this.syncDays()
  },

  syncDays: function () {
    var start = this.data.startDate
    var end = this.data.endDate

    if (!start || !end) {
      this.setData({ travelDays: 0, travelDaysText: '待选择' })
      return
    }

    var days = format.diffDays(start, end)

    if (days <= 0) {
      wx.showToast({ title: '结束日期不能早于开始日期', icon: 'none' })
      this.setData({ endDate: '', travelDays: 0, travelDaysText: '待选择' })
      return
    }

    if (days > MAX_DAYS) {
      wx.showToast({ title: '旅行天数不能超过 ' + MAX_DAYS + ' 天', icon: 'none' })
      this.setData({ endDate: '', travelDays: 0, travelDaysText: '待选择' })
      return
    }

    this.setData({
      travelDays: days,
      travelDaysText: days + ' 天'
    })
  },

  onTransportationChange: function (e) {
    this.setData({ transportationIndex: Number(e.detail.value) })
  },

  onAccommodationChange: function (e) {
    this.setData({ accommodationIndex: Number(e.detail.value) })
  },

  onTogglePreference: function (e) {
    var index = Number(e.currentTarget.dataset.index)
    var list = this.data.preferenceList.slice()

    if (!list[index]) {
      return
    }

    list[index] = {
      label: list[index].label,
      checked: !list[index].checked
    }

    this.setData({ preferenceList: list })
  },

  onFreeTextInput: function (e) {
    this.setData({ freeText: e.detail.value })
  },

  selectedPreferences: function () {
    var list = this.data.preferenceList
    var selected = []
    for (var i = 0; i < list.length; i++) {
      if (list[i].checked) {
        selected.push(list[i].label)
      }
    }
    return selected
  },

  /* ---------------- 提交 ---------------- */

  onSubmit: function () {
    if (this.data.loading) {
      return
    }

    var city = (this.data.city || '').trim()
    if (!city) {
      wx.showToast({ title: '请输入目的地城市', icon: 'none' })
      return
    }

    if (!this.data.startDate || !this.data.endDate) {
      wx.showToast({ title: '请选择开始与结束日期', icon: 'none' })
      return
    }

    var days = format.diffDays(this.data.startDate, this.data.endDate)
    if (days < 1 || days > MAX_DAYS) {
      wx.showToast({ title: '旅行天数需在 1 - ' + MAX_DAYS + ' 天之间', icon: 'none' })
      return
    }

    var payload = {
      city: city,
      start_date: this.data.startDate,
      end_date: this.data.endDate,
      travel_days: days,
      transportation: TRANSPORTATION_OPTIONS[this.data.transportationIndex],
      accommodation: ACCOMMODATION_OPTIONS[this.data.accommodationIndex],
      preferences: this.selectedPreferences(),
      free_text_input: (this.data.freeText || '').trim()
    }

    this.startProgress()
    this.requestPlan(payload)
  },

  requestPlan: function (payload) {
    var self = this

    request.post('/api/trip/plan', payload).then(function (res) {
      if (self.isUnloaded) {
        return
      }

      if (!res || !res.success || !res.data) {
        throw new Error((res && res.message) || '生成失败，请稍后重试')
      }

      // 本地与云端共用同一个 savedAt：两边时间戳一致，
      // refreshHistory 才能靠"相等即同一份"判断出无需重复上传。
      var savedAt = Date.now()
      storage.savePlan(res.data, { savedAt: savedAt })
      self.pushToCloud(res.data, savedAt)

      self.stopProgress()
      self.setData({ progress: 100, progressText: '生成完成' })

      setTimeout(function () {
        if (self.isUnloaded) {
          return
        }
        self.setData({ loading: false, progress: 0, progressText: '' })
        wx.navigateTo({ url: '/pages/result/result' })
      }, 400)
    }).catch(function (error) {
      if (self.isUnloaded) {
        return
      }

      // 这里拿到的已经是 request.js 翻译后的短句；原始 errMsg 由 request.js 自己打日志
      // （页面层拿不到原始错误）。用字符串拼接，避免 Error 对象过桥时被序列化成 {}。
      console.error('[旅行助手] 生成失败: ' +
        ((error && (error.stack || error.message)) || String(error)))

      self.stopProgress()
      self.setData({ loading: false, progress: 0, progressText: '' })

      wx.showModal({
        title: '生成失败',
        content: (error && error.message) || '未知错误，请稍后重试',
        showCancel: false,
        confirmText: '知道了'
      })
    })
  },

  /* ---------------- 进度 ---------------- */

  startProgress: function () {
    var self = this

    this.setData({
      loading: true,
      progress: 4,
      progressText: progressTextOf(4)
    })

    this.stopProgress()
    this.timer = setInterval(function () {
      if (self.isUnloaded) {
        return
      }
      var current = self.data.progress
      if (current >= 92) {
        return
      }
      var next = current + 4
      if (next > 92) {
        next = 92
      }
      self.setData({
        progress: next,
        progressText: progressTextOf(next)
      })
    }, 600)
  },

  stopProgress: function () {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }
})
