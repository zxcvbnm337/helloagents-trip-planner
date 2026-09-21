var planUtil = require('../../utils/plan')
var storage = require('../../utils/storage')

// 没有坐标数据时的兜底中心点（天安门），仅用于让 map 组件有个合法初值
var DEFAULT_LAT = 39.90923
var DEFAULT_LNG = 116.397428

var MARKER_ICON = '/assets/marker.png'

Page({
  data: {
    plan: null,

    // 地图相关
    activeDayIndex: 0,
    activeDayLabel: '',
    mapReady: false,
    mapHint: '',
    mapLat: DEFAULT_LAT,
    mapLng: DEFAULT_LNG,
    mapScale: 11,
    markers: [],
    polyline: [],
    includePoints: []
  },

  onLoad: function () {
    var raw = storage.loadPlan()

    if (!raw) {
      this.setData({ plan: null })
      return
    }

    var plan = planUtil.normalizePlan(raw)
    this.setData({ plan: plan })
    this.applyDay(plan, 0)
  },

  onShareAppMessage: function () {
    var plan = this.data.plan
    var city = plan && plan.city ? plan.city : '目的地'
    var days = plan && plan.travelDays ? plan.travelDays : ''
    return {
      title: city + ' ' + days + ' 日行程规划',
      path: '/pages/index/index'
    }
  },

  /* ---------------- 地图 ---------------- */

  onSelectDay: function (e) {
    var index = Number(e.currentTarget.dataset.index)
    if (isNaN(index)) {
      return
    }
    this.applyDay(this.data.plan, index)
  },

  /**
   * 按「第几天」重建地图上的标记与连线
   */
  applyDay: function (plan, order) {
    if (!plan || !plan.days || !plan.days.length) {
      this.setData({
        mapReady: false,
        mapHint: '',
        activeDayIndex: 0,
        activeDayLabel: '',
        markers: [],
        polyline: [],
        includePoints: []
      })
      return
    }

    var safeOrder = order
    if (safeOrder < 0) {
      safeOrder = 0
    }
    if (safeOrder > plan.days.length - 1) {
      safeOrder = plan.days.length - 1
    }

    var day = plan.days[safeOrder]
    var points = []
    var markers = []
    var i

    for (i = 0; i < day.attractions.length; i++) {
      var spot = day.attractions[i]
      if (!spot.location) {
        continue
      }

      markers.push({
        id: markers.length,
        latitude: spot.location.latitude,
        longitude: spot.location.longitude,
        iconPath: MARKER_ICON,
        width: 30,
        height: 30,
        anchor: { x: 0.5, y: 1 },
        callout: {
          content: spot.name,
          display: 'BYCLICK',
          color: '#1f2430',
          fontSize: 12,
          borderRadius: 8,
          borderWidth: 0,
          bgColor: '#ffffff',
          padding: 8,
          textAlign: 'center'
        }
      })

      points.push({
        latitude: spot.location.latitude,
        longitude: spot.location.longitude
      })
    }

    var next = {
      activeDayIndex: safeOrder,
      activeDayLabel: '第 ' + day.dayNumber + ' 天 · ' + day.dateLabel,
      mapReady: points.length > 0,
      markers: markers,
      polyline: points.length > 1
        ? [{ points: points, color: '#667eea', width: 4, arrowLine: true }]
        : [],
      includePoints: points.length > 1 ? points : []
    }

    if (points.length === 0) {
      next.mapHint = '这一天的景点没有可用经纬度，暂时无法在地图上标注'
    } else if (points.length === 1) {
      next.mapHint = '当天只有 1 个景点，已定位到该景点'
      next.mapLat = points[0].latitude
      next.mapLng = points[0].longitude
      next.mapScale = 13
    } else {
      next.mapHint = '点击标记可查看景点名称，连线为该日游览顺序'
      next.mapLat = points[0].latitude
      next.mapLng = points[0].longitude
      next.mapScale = 11
    }

    this.setData(next)
  },

  /* ---------------- 操作 ---------------- */

  onCopy: function () {
    var text = planUtil.buildPlainText(this.data.plan)

    if (!text) {
      wx.showToast({ title: '暂无可复制的内容', icon: 'none' })
      return
    }

    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '行程已复制', icon: 'success' })
      },
      fail: function () {
        wx.showToast({ title: '复制失败', icon: 'none' })
      }
    })
  },

  onRegenerate: function () {
    var pages = getCurrentPages()

    if (pages && pages.length > 1) {
      wx.navigateBack()
      return
    }

    wx.reLaunch({ url: '/pages/index/index' })
  }
})
