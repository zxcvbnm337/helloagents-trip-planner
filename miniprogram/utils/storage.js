/**
 * 行程本地缓存
 * 结果页数据量较大，不适合通过页面参数传递（URL 长度有限），
 * 因此生成成功后写入本地缓存，结果页读取渲染。
 *
 * 另外可选地记下这份行程在云数据库里的 id（cloudId），
 * 这样"清除"时能顺带把云端那条也删掉，不会留下孤儿数据。
 */

var PLAN_KEY = 'trip_plan'
var META_KEY = 'trip_plan_meta'

/**
 * @param {Object} plan     后端返回的 TripPlan
 * @param {Object} [options] { cloudId, savedAt } —— 来自云端的行程会带上这两项
 */
function savePlan(plan, options) {
  if (!plan) {
    return false
  }
  var opt = options || {}
  try {
    wx.setStorageSync(PLAN_KEY, plan)
    wx.setStorageSync(META_KEY, {
      city: plan.city || '',
      dayCount: (plan.days || []).length,
      savedAt: opt.savedAt || Date.now(),
      cloudId: opt.cloudId || ''
    })
    return true
  } catch (e) {
    console.error('[旅行助手] 保存行程失败:', e)
    return false
  }
}

function loadPlan() {
  try {
    var plan = wx.getStorageSync(PLAN_KEY)
    return plan || null
  } catch (e) {
    console.error('[旅行助手] 读取行程失败:', e)
    return null
  }
}

function loadMeta() {
  try {
    var meta = wx.getStorageSync(META_KEY)
    return meta || null
  } catch (e) {
    return null
  }
}

function clearPlan() {
  try {
    wx.removeStorageSync(PLAN_KEY)
    wx.removeStorageSync(META_KEY)
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  savePlan: savePlan,
  loadPlan: loadPlan,
  loadMeta: loadMeta,
  clearPlan: clearPlan
}
