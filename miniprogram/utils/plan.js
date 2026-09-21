/**
 * 把后端返回的 TripPlan 转换成「视图模型」。
 *
 * 为什么需要这一层：WXML 里不能调用 JS 函数，所有格式化、兜底、排序
 * 必须在 JS 侧预先算好，模板只负责展示。
 */

var format = require('./format')
var AI_LABEL = require('../config/index').AI_LABEL

var MEAL_LABELS = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  snack: '加餐'
}

var MEAL_ORDER = {
  breakfast: 0,
  lunch: 1,
  dinner: 2,
  snack: 3
}

/**
 * 宽松数字解析：兼容 18、"18℃"、"60元" 这类脏数据。
 * 解析不出来返回 NaN，由调用方决定兜底策略。
 *
 * 后端的 WeatherInfo 虽然有 validator 清洗温度单位，但那一层只作用于
 * 被 Pydantic 校验过的字段；这里再做一层防御，避免小程序直接显示空值。
 */
function parseNumber(value) {
  if (value === null || value === undefined || value === '') {
    return NaN
  }
  if (typeof value === 'number') {
    return value
  }
  var cleaned = String(value).replace(/[^0-9.\-]/g, '')
  if (cleaned === '' || cleaned === '-' || cleaned === '.') {
    return NaN
  }
  return Number(cleaned)
}

function normalizeLocation(location) {
  if (!location) {
    return null
  }
  var longitude = Number(location.longitude)
  var latitude = Number(location.latitude)
  if (isNaN(longitude) || isNaN(latitude)) {
    return null
  }
  // (0, 0) 基本可以判定为无效坐标（几内亚湾），直接丢弃避免地图跑到非洲
  if (longitude === 0 && latitude === 0) {
    return null
  }
  return {
    longitude: longitude,
    latitude: latitude
  }
}

function normalizeAttraction(item, dayIndex, order) {
  var spot = item || {}
  var ticket = parseNumber(spot.ticket_price)
  return {
    key: 'a' + dayIndex + '_' + order,
    name: format.displayText(spot.name, '未命名景点'),
    address: format.displayText(spot.address, ''),
    description: format.displayText(spot.description, ''),
    category: format.displayText(spot.category, '景点'),
    durationText: format.formatDuration(spot.visit_duration),
    ticketText: !isNaN(ticket) && ticket > 0 ? '门票 ' + format.formatMoney(ticket) : '免费',
    location: normalizeLocation(spot.location)
  }
}

function normalizeMeals(list, dayIndex) {
  var source = list || []
  var meals = []
  var i

  for (i = 0; i < source.length; i++) {
    var meal = source[i] || {}
    var type = meal.type ? String(meal.type) : 'snack'
    var cost = parseNumber(meal.estimated_cost)
    meals.push({
      key: 'm' + dayIndex + '_' + i,
      order: typeof MEAL_ORDER[type] === 'number' ? MEAL_ORDER[type] : 9,
      label: MEAL_LABELS[type] || '用餐',
      name: format.displayText(meal.name, '待安排'),
      description: format.displayText(meal.description, ''),
      costText: !isNaN(cost) && cost > 0 ? format.formatMoney(cost) : ''
    })
  }

  // 早 / 午 / 晚 / 加餐 排序，保证展示顺序稳定
  meals.sort(function (a, b) {
    if (a.order !== b.order) {
      return a.order - b.order
    }
    return a.key < b.key ? -1 : 1
  })

  return meals
}

function normalizeHotel(hotel) {
  if (!hotel || !hotel.name) {
    return null
  }

  var metas = []
  if (hotel.price_range) {
    metas.push(String(hotel.price_range))
  }
  if (hotel.rating) {
    metas.push('评分 ' + hotel.rating)
  }
  if (hotel.distance) {
    metas.push(String(hotel.distance))
  }
  if (hotel.type) {
    metas.push(String(hotel.type))
  }

  var cost = parseNumber(hotel.estimated_cost)

  return {
    name: String(hotel.name),
    address: format.displayText(hotel.address, ''),
    metaText: metas.join(' · '),
    costText: !isNaN(cost) && cost > 0 ? format.formatMoney(cost) + ' / 晚' : '',
    location: normalizeLocation(hotel.location)
  }
}

function normalizeWeather(item) {
  var weather = item || {}
  var dayTemp = parseNumber(weather.day_temp)
  var nightTemp = parseNumber(weather.night_temp)

  var windParts = []
  if (weather.wind_direction) {
    windParts.push(String(weather.wind_direction))
  }
  if (weather.wind_power) {
    windParts.push(String(weather.wind_power))
  }

  return {
    date: weather.date || '',
    dateLabel: format.friendlyDate(weather.date),
    dayWeather: format.displayText(weather.day_weather, '—'),
    nightWeather: format.displayText(weather.night_weather, '—'),
    dayTempText: isNaN(dayTemp) ? '—' : dayTemp + '°',
    nightTempText: isNaN(nightTemp) ? '—' : nightTemp + '°',
    windText: windParts.join(' ')
  }
}

function normalizeBudget(budget) {
  if (!budget) {
    return null
  }

  var rows = [
    { label: '景点门票', amount: parseNumber(budget.total_attractions) || 0 },
    { label: '酒店住宿', amount: parseNumber(budget.total_hotels) || 0 },
    { label: '餐饮', amount: parseNumber(budget.total_meals) || 0 },
    { label: '交通', amount: parseNumber(budget.total_transportation) || 0 }
  ]

  var total = parseNumber(budget.total)
  var computed = 0
  var items = []

  for (var i = 0; i < rows.length; i++) {
    computed += rows[i].amount
    items.push({
      label: rows[i].label,
      valueText: format.formatMoney(rows[i].amount)
    })
  }

  if (isNaN(total) || total <= 0) {
    total = computed
  }

  return {
    items: items,
    total: total,
    totalText: format.formatMoney(total)
  }
}

/**
 * 主入口：原始 TripPlan -> 视图模型
 */
function normalizePlan(raw) {
  if (!raw) {
    return null
  }

  // 1) 先把天气归一化，并按日期建立索引，方便逐日匹配
  var rawWeather = raw.weather_info || []
  var weatherList = []
  var weatherByDate = {}
  var i

  for (i = 0; i < rawWeather.length; i++) {
    var normalizedWeather = normalizeWeather(rawWeather[i])
    weatherList.push(normalizedWeather)
    if (normalizedWeather.date) {
      weatherByDate[normalizedWeather.date] = normalizedWeather
    }
  }

  weatherList.sort(function (a, b) {
    if (a.date === b.date) {
      return 0
    }
    return a.date < b.date ? -1 : 1
  })

  // 2) 逐日行程
  var rawDays = raw.days || []
  var days = []
  var attractionCount = 0

  for (i = 0; i < rawDays.length; i++) {
    var day = rawDays[i] || {}
    var dayIndex = typeof day.day_index === 'number' ? day.day_index : i

    var rawAttractions = day.attractions || []
    var attractions = []
    for (var j = 0; j < rawAttractions.length; j++) {
      attractions.push(normalizeAttraction(rawAttractions[j], dayIndex, j))
    }
    attractionCount += attractions.length

    days.push({
      key: 'd' + dayIndex + '_' + i,
      index: dayIndex,
      dayNumber: i + 1,
      date: day.date || '',
      dateLabel: format.friendlyDate(day.date),
      description: format.displayText(day.description, ''),
      transportation: format.displayText(day.transportation, '未指定'),
      accommodation: format.displayText(day.accommodation, '未指定'),
      attractions: attractions,
      hasAttractions: attractions.length > 0,
      meals: normalizeMeals(day.meals, dayIndex),
      hotel: normalizeHotel(day.hotel),
      weather: day.date && weatherByDate[day.date] ? weatherByDate[day.date] : null
    })
  }

  // 3) 日期区间：后端没给就用首尾两天的日期兜底
  var startDate = raw.start_date || (days.length ? days[0].date : '')
  var endDate = raw.end_date || (days.length ? days[days.length - 1].date : '')
  var dateRangeText = '日期待定'
  if (startDate && endDate) {
    dateRangeText = startDate + ' 至 ' + endDate
  } else if (startDate) {
    dateRangeText = startDate
  }

  return {
    city: format.displayText(raw.city, '目的地'),
    startDate: startDate,
    endDate: endDate,
    dateRangeText: dateRangeText,
    travelDays: days.length,
    attractionCount: attractionCount,
    days: days,
    weatherList: weatherList,
    hasWeather: weatherList.length > 0,
    budget: normalizeBudget(raw.budget),
    overallSuggestions: format.displayText(raw.overall_suggestions, '')
  }
}

/**
 * 生成便于复制/粘贴的纯文本行程，用于「复制行程」按钮
 *
 * ⚠️ 末尾必须带上 AI 生成标识：这段文本会被粘贴到微信 / 备忘录 / 文档里，
 * 也就是「内容离开了小程序」。标识跟着内容走，否则收到这段文字的人
 * 无从知道它出自 AI。
 */
function buildPlainText(plan) {
  if (!plan) {
    return ''
  }

  var lines = []
  var i
  var j

  lines.push(plan.city + ' · ' + plan.travelDays + ' 日行程')
  lines.push(plan.dateRangeText)
  if (plan.budget) {
    lines.push('预估总花费：' + plan.budget.totalText)
  }
  lines.push('')

  for (i = 0; i < plan.days.length; i++) {
    var day = plan.days[i]
    lines.push('【第 ' + day.dayNumber + ' 天】' + day.dateLabel)
    if (day.description) {
      lines.push(day.description)
    }

    if (day.hasAttractions) {
      lines.push('景点：')
      for (j = 0; j < day.attractions.length; j++) {
        var spot = day.attractions[j]
        var extra = []
        if (spot.durationText) {
          extra.push('游览 ' + spot.durationText)
        }
        if (spot.ticketText) {
          extra.push(spot.ticketText)
        }
        lines.push('  ' + (j + 1) + '. ' + spot.name + (extra.length ? '（' + extra.join('，') + '）' : ''))
      }
    }

    if (day.hotel) {
      lines.push('住宿：' + day.hotel.name)
    }

    if (day.meals.length) {
      var mealTexts = []
      for (j = 0; j < day.meals.length; j++) {
        mealTexts.push(day.meals[j].label + ' ' + day.meals[j].name)
      }
      lines.push('餐饮：' + mealTexts.join('；'))
    }

    lines.push('')
  }

  if (plan.overallSuggestions) {
    lines.push('总体建议：')
    lines.push(plan.overallSuggestions)
  }

  // AI 生成标识 —— 必须留在末尾（见函数头注释）
  lines.push('')
  lines.push('—— ' + AI_LABEL.badge + ' ——')
  lines.push(AI_LABEL.disclaimer)

  return lines.join('\n')
}

module.exports = {
  normalizePlan: normalizePlan,
  buildPlainText: buildPlainText,
  normalizeLocation: normalizeLocation,
  parseNumber: parseNumber
}
