/**
 * 行程云端存储（微信云开发数据库）
 *
 * 目的：补上「换设备就看不到自己生成的行程」这个缺口。
 * 本地缓存（utils/storage.js）继续保留 —— 它负责即时渲染与离线可读，
 * 云数据库负责跨设备可见。两者是互补关系，不是替代关系。
 *
 * 设计要点
 * ─────────────────────────────────────────────────────────
 * 1. **只用客户端 SDK**（wx.cloud.database()），不写云函数。
 *    集合权限设为「仅创建者可读写」后，每人只能看见自己的记录，
 *    隔离由权限系统保证，不需要自己在代码里做用户判断。
 *
 * 2. **失败必须降级，不能影响主流程**。集合没建、权限没配、云没开通……
 *    任何一种情况都只打一条日志然后当作"没有云端"，小程序照常用本地缓存。
 *    所以所有 API 一律 resolve 成 `{ok:false, reason}`，绝不 reject，
 *    调用方不需要 try/catch。
 *
 * 3. **只提供按 id 删除**（doc(id).remove()），不用 where().remove()。
 *    前者是客户端 SDK 明确支持且权限模型最清晰的形式；后者在客户端
 *    的批量删除行为容易踩权限与条数限制。
 *
 * 注意：不使用可选链（?.）与空值合并（??），以兼容较低基础库版本。
 */

var config = require('../config/index')

var COLLECTION = 'trips'

// 单条记录体积上限（云数据库单条记录约 512KB，这里留足余量）
var MAX_DOC_BYTES = 400 * 1024

// 云端最多保留多少条历史（超出按时间从旧到新删除，避免无限增长）
var KEEP_LATEST = 20

// 每种失败原因只提示一次，避免每次进页面都刷屏
var hinted = {}

function hintOnce(key, message) {
  // 同时记到 globalData：提示只打一次，但状态要随时可查
  // （排障时可在控制台看 getApp().globalData.cloudStoreIssue）
  try {
    var app = getApp()
    if (app && app.globalData) {
      app.globalData.cloudStoreIssue = message
    }
  } catch (e) { }

  if (hinted[key]) {
    return
  }
  hinted[key] = true
  console.warn('[cloudStore] ' + message)
}

/**
 * 云数据库是否可用（配置开关 + 基础库能力）
 */
function isEnabled() {
  if (!config.USE_CLOUD_DB) {
    return false
  }
  if (!wx.cloud || !wx.cloud.database) {
    return false
  }
  return true
}

function database() {
  return wx.cloud.database()
}

function shorten(text, limit) {
  var t = String(text || '')
  // 文档链接对用户没用，先去干净
  t = t.replace(/https?:\/\/\S+/g, ' ')
  t = t.replace(/更多错误信息请访问[:：]?/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  var max = limit || 80
  if (t.length > max) {
    return t.slice(0, max) + '…'
  }
  return t
}

/**
 * 把云数据库的报错翻译成可照做的提示
 *
 * 实测样本（集合未建时）：
 *   "[ResourceNotFound] Db or Table not exist: trips. Please check your request,
 *    but if the problem cannot be solved, contact us.
 *    更多错误信息请访问：https://docs.cloudbase.net/error-code/basic/DATABASE_COLLECTION_NOT_EXIST"
 *
 * ⚠️ 注意它**既没有** `-502005` **也没有** `collection not exists` 字样 ——
 * 只按错误码或字面量匹配会漏掉这个最常见的情况（这个坑就是实测踩出来的）。
 */
function describeDbError(err) {
  var raw = (err && err.errMsg) || (err && err.message) || ''
  var text = String(raw)

  if (text.indexOf('-502005') > -1 ||
    text.indexOf('ResourceNotFound') > -1 ||
    text.indexOf('Db or Table not exist') > -1 ||
    text.indexOf('DATABASE_COLLECTION_NOT_EXIST') > -1 ||
    text.indexOf('collection not exists') > -1) {
    return '集合 ' + COLLECTION + ' 不存在：请在「云开发控制台 → 数据库」新建集合「' +
      COLLECTION + '」，权限选「仅创建者可读写」'
  }
  if (text.indexOf('-502003') > -1 || text.indexOf('permission denied') > -1 ||
    text.indexOf('PERMISSION_DENIED') > -1) {
    return '数据库权限不足：请把集合 ' + COLLECTION + ' 的权限设为「仅创建者可读写」'
  }
  if (text.indexOf('-601002') > -1 || text.indexOf('not initialized') > -1 ||
    text.indexOf('cloud init') > -1) {
    return '云能力未初始化：请确认 app.js 的 initCloud() 已执行且环境 ID 正确'
  }
  if (text.indexOf('exceed') > -1 && text.indexOf('size') > -1) {
    return '记录体积超出云数据库单条上限：行程过大时无法上云'
  }
  return '云数据库操作失败：' + shorten(text)
}

/**
 * 保存一行行程到云端。
 *
 * @param {Object} plan 后端返回的 TripPlan（原始对象，不要传视图模型）
 * @param {Object} [options] { savedAt } —— 显式指定时间戳。
 *        必须与写入本地缓存的 savedAt 保持一致，否则两边时间戳不同步，
 *        下次进入页面会被误判成"本地更新"而重复上传（实测踩过）。
 * @returns {Promise<{ok:boolean, id?:string, reason?:string}>}
 */
function savePlan(plan, options) {
  if (!plan) {
    return Promise.resolve({ ok: false, reason: '没有可保存的行程' })
  }
  if (!isEnabled()) {
    return Promise.resolve({ ok: false, reason: '未启用云数据库' })
  }

  var opt = options || {}

  var payload = ''
  try {
    payload = JSON.stringify(plan)
  } catch (e) {
    return Promise.resolve({ ok: false, reason: '行程无法序列化' })
  }
  if (payload.length > MAX_DOC_BYTES) {
    var tooBig = '行程体积约 ' + Math.round(payload.length / 1024) + 'KB，超过云数据库单条记录上限，未上云'
    hintOnce('toolarge', tooBig)
    return Promise.resolve({ ok: false, reason: tooBig })
  }

  return database().collection(COLLECTION).add({
    data: {
      city: plan.city || '',
      travelDays: plan.travel_days || plan.travelDays || 0,
      daysCount: (plan.days || []).length,
      // 用数字时间戳，便于 orderBy 排序，也便于与本地 meta.savedAt 直接比较
      savedAt: opt.savedAt || Date.now(),
      plan: plan
    }
  }).then(function (res) {
    // 写入成功后顺手清理超量历史（失败不影响本次结果）
    pruneOld().catch(function () { })
    return { ok: true, id: (res && res._id) || '' }
  }).catch(function (err) {
    var reason = describeDbError(err)
    hintOnce('add', reason)
    console.error('[cloudStore] 保存到云端失败:', reason)
    return { ok: false, reason: reason }
  })
}

/**
 * 取最近一条云端行程
 * @returns {Promise<{ok:boolean, record?:Object, reason?:string}>}
 */
function fetchLatest() {
  if (!isEnabled()) {
    return Promise.resolve({ ok: false, reason: '未启用云数据库' })
  }

  return database().collection(COLLECTION)
    .orderBy('savedAt', 'desc')
    .limit(1)
    .get()
    .then(function (res) {
      var list = (res && res.data) || []
      if (!list.length) {
        return { ok: true, record: null }
      }
      var doc = list[0]
      return {
        ok: true,
        record: {
          id: doc._id,
          savedAt: doc.savedAt || 0,
          city: doc.city || '',
          daysCount: doc.daysCount || 0,
          plan: doc.plan || null
        }
      }
    })
    .catch(function (err) {
      var reason = describeDbError(err)
      hintOnce('query', reason)
      console.error('[cloudStore] 读取云端行程失败:', reason)
      return { ok: false, reason: reason }
    })
}

/**
 * 按 id 删除一条云端行程
 */
function removeById(id) {
  if (!id) {
    return Promise.resolve({ ok: false, reason: '缺少记录 id' })
  }
  if (!isEnabled()) {
    return Promise.resolve({ ok: false, reason: '未启用云数据库' })
  }

  return database().collection(COLLECTION).doc(id).remove()
    .then(function () {
      return { ok: true }
    })
    .catch(function (err) {
      var reason = describeDbError(err)
      hintOnce('remove', reason)
      console.error('[cloudStore] 删除云端行程失败:', reason)
      return { ok: false, reason: reason }
    })
}

/**
 * 只保留最近 KEEP_LATEST 条，多出来的按 id 逐条删除。
 * 内部调用，失败静默（清理不了不影响用户）。
 */
function pruneOld() {
  if (!isEnabled()) {
    return Promise.resolve()
  }

  var db = database()
  return db.collection(COLLECTION)
    .orderBy('savedAt', 'desc')
    .skip(KEEP_LATEST)
    .limit(20)
    .field({ _id: true })
    .get()
    .then(function (res) {
      var list = (res && res.data) || []
      if (!list.length) {
        return null
      }
      var jobs = []
      for (var i = 0; i < list.length; i++) {
        jobs.push(db.collection(COLLECTION).doc(list[i]._id).remove().catch(function () { }))
      }
      return Promise.all(jobs)
    })
}

module.exports = {
  COLLECTION: COLLECTION,
  MAX_DOC_BYTES: MAX_DOC_BYTES,
  KEEP_LATEST: KEEP_LATEST,
  isEnabled: isEnabled,
  describeDbError: describeDbError,
  savePlan: savePlan,
  fetchLatest: fetchLatest,
  removeById: removeById
}
