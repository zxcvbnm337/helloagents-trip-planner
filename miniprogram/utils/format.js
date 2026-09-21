/**
 * 格式化工具
 * 注意：不使用可选链（?.）与空值合并（??）。
 */

var WEEK_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
var MS_PER_DAY = 24 * 60 * 60 * 1000

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

/** Date -> 'YYYY-MM-DD' */
function formatDate(date) {
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
}

/** 'YYYY-MM-DD' -> Date（不合法返回 null） */
function parseDate(text) {
  if (!text) {
    return null
  }
  var parts = String(text).split('-')
  if (parts.length !== 3) {
    return null
  }
  var year = parseInt(parts[0], 10)
  var month = parseInt(parts[1], 10)
  var day = parseInt(parts[2], 10)
  if (isNaN(year) || isNaN(month) || isNaN(day)) {
    return null
  }
  return new Date(year, month - 1, day)
}

function addDays(date, count) {
  var next = new Date(date.getTime())
  next.setDate(next.getDate() + count)
  return next
}

/** 含首尾的天数：2025-06-01 ~ 2025-06-03 -> 3 */
function diffDays(startText, endText) {
  var start = parseDate(startText)
  var end = parseDate(endText)
  if (!start || !end) {
    return 0
  }
  return Math.round((end.getTime() - start.getTime()) / MS_PER_DAY) + 1
}

/** '2025-06-01' -> '6月1日 周日' */
function friendlyDate(text) {
  var date = parseDate(text)
  if (!date) {
    return text || ''
  }
  return (date.getMonth() + 1) + '月' + date.getDate() + '日 ' + WEEK_LABELS[date.getDay()]
}

/** 分钟 -> '2 小时 30 分' */
function formatDuration(minutes) {
  var value = Number(minutes) || 0
  if (value <= 0) {
    return ''
  }
  if (value < 60) {
    return value + ' 分钟'
  }
  var hours = Math.floor(value / 60)
  var rest = value % 60
  if (rest === 0) {
    return hours + ' 小时'
  }
  return hours + ' 小时 ' + rest + ' 分'
}

/** 数字 -> '¥1,234'，自带千分位 */
function formatMoney(value) {
  var number = Number(value)
  if (isNaN(number)) {
    return '¥0'
  }
  var negative = number < 0
  var digits = String(Math.abs(Math.round(number)))
  var result = ''
  var count = 0
  for (var i = digits.length - 1; i >= 0; i--) {
    result = digits.charAt(i) + result
    count++
    if (count % 3 === 0 && i > 0) {
      result = ',' + result
    }
  }
  return (negative ? '-¥' : '¥') + result
}

/** 取值并兜底，避免界面上出现 undefined / null */
function displayText(value, fallback) {
  var safeFallback = typeof fallback === 'string' ? fallback : '—'
  if (value === null || value === undefined) {
    return safeFallback
  }
  var text = String(value).trim()
  return text === '' ? safeFallback : text
}

module.exports = {
  WEEK_LABELS: WEEK_LABELS,
  pad2: pad2,
  formatDate: formatDate,
  parseDate: parseDate,
  addDays: addDays,
  diffDays: diffDays,
  friendlyDate: friendlyDate,
  formatDuration: formatDuration,
  formatMoney: formatMoney,
  displayText: displayText
}
