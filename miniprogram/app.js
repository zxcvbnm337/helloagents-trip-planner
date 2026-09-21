// app.js
var config = require('./config/index')

App({
  globalData: {
    // 云开发环境 ID（微信云开发 / CloudBase）—— 云数据库走这个环境。
    // 取值来自 config/index.js 的 CLOUD_ENV，环境 ID 只维护在 config 一处。
    // ⚠️ 云托管（cloud-container）用的是**另一个**环境 ID，
    //    即 config.CLOUD_CONTAINER_ENV —— 两者来自不同控制台，不要混用。
    env: config.CLOUD_ENV,

    // 上一次成功生成的行程（内存级缓存，页面卸载后仍在，重启小程序后失效）
    lastPlan: null,

    // 云数据库最近一次的失败原因（没有失败则为空串）。
    // utils/cloudStore.js 的提示只打一次，这里保留一份随时可查的状态，
    // 排障时在控制台执行 getApp().globalData.cloudStoreIssue 即可。
    cloudStoreIssue: ''
  },

  onLaunch: function () {
    console.log('[旅行助手] 小程序启动，传输方式:', config.TRANSPORT)
    this.initCloud()
  },

  /**
   * 初始化云开发能力。
   *
   * 说明：
   * - 必须在小程序启动时调用一次，之后页面里才能直接用 wx.cloud.* 。
   * - 环境未开通 / env ID 不匹配时 wx.cloud.init 会抛错，
   *   这里吞掉异常并只打日志，避免云能力问题阻断整个小程序启动。
   */
  initCloud: function () {
    if (!wx.cloud) {
      console.error('[旅行助手] 当前基础库不支持云能力，请使用 2.2.3 及以上版本')
      return
    }

    try {
      wx.cloud.init({
        env: this.globalData.env,
        traceUser: true
      })
      console.log('[旅行助手] 云开发环境已初始化:', this.globalData.env)
    } catch (error) {
      console.error('[旅行助手] 云开发初始化失败，请确认环境已开通且 env ID 正确:', error)
    }
  },

  onError: function (message) {
    console.error('[旅行助手] 未捕获异常:', message)
  },

  onUnhandledRejection: function (res) {
    console.error('[旅行助手] 未处理的 Promise 拒绝:', res && res.reason)
  }
})
