/**
 * 离线自测：校验「后端 TripPlan -> 视图模型」这一层的转换是否正确。
 *
 * 该层是小程序里最容易出错的地方（WXML 不能调函数，所有格式化都得在 JS 侧算好），
 * 而它本身不依赖任何 wx.* API，因此可以脱离模拟器直接用 Node 跑。
 *
 * 用法（在 miniprogram 目录下）：
 *   node tools/check-plan-transform.js
 */

var planUtil = require('../utils/plan')
var format = require('../utils/format')

var failures = []

function check(name, actual, expected) {
  if (actual === expected) {
    console.log('  PASS  ' + name)
    return
  }
  console.log('  FAIL  ' + name)
  console.log('        期望: ' + JSON.stringify(expected))
  console.log('        实际: ' + JSON.stringify(actual))
  failures.push(name)
}

// ---------- format ----------
console.log('\n[format]')
check('diffDays 含首尾计天', format.diffDays('2025-06-01', '2025-06-03'), 3)
check('diffDays 同一天为 1', format.diffDays('2025-06-01', '2025-06-01'), 1)
check('friendlyDate', format.friendlyDate('2025-06-01'), '6月1日 周日')
check('formatDuration 分钟', format.formatDuration(45), '45 分钟')
check('formatDuration 整点', format.formatDuration(120), '2 小时')
check('formatDuration 时 + 分', format.formatDuration(150), '2 小时 30 分')
check('formatMoney 千分位', format.formatMoney(12800), '¥12,800')
check('displayText 空串兜底', format.displayText('   ', '—'), '—')

console.log('\n[parseNumber 宽松解析]')
check('带摄氏度单位', planUtil.parseNumber('18℃'), 18)
check('带元单位', planUtil.parseNumber('60元'), 60)
check('数字原样返回', planUtil.parseNumber(30), 30)
check('空串 -> NaN', isNaN(planUtil.parseNumber('')), true)

// ---------- 模拟后端返回 ----------
var raw = {
  city: '北京',
  start_date: '2025-06-01',
  end_date: '2025-06-02',
  days: [
    {
      date: '2025-06-01',
      day_index: 0,
      description: '抵达北京，游览中轴线',
      transportation: '公共交通',
      accommodation: '经济型酒店',
      hotel: {
        name: '前门如家',
        address: '北京市东城区前门大街 1 号',
        location: { longitude: 116.397, latitude: 39.899 },
        price_range: '300-400元',
        rating: '4.5',
        distance: '距天安门 1 公里',
        type: '经济型酒店',
        estimated_cost: 350
      },
      attractions: [
        {
          name: '天安门广场',
          address: '北京市东城区东长安街',
          location: { longitude: 116.397428, latitude: 39.90923 },
          visit_duration: 90,
          description: '世界上最大的城市广场之一',
          category: '历史文化',
          ticket_price: 0
        },
        {
          name: '故宫博物院',
          address: '北京市东城区景山前街 4 号',
          // 故意给一个无效坐标，验证会被丢弃
          location: { longitude: 0, latitude: 0 },
          visit_duration: 180,
          description: '明清两代皇家宫殿',
          category: '历史文化',
          ticket_price: 60
        }
      ],
      meals: [
        { type: 'dinner', name: '烤鸭', description: '四季民福', estimated_cost: 180 },
        { type: 'breakfast', name: '豆汁焦圈', description: '老北京早点', estimated_cost: 25 }
      ]
    },
    {
      date: '2025-06-02',
      day_index: 1,
      description: '长城一日游',
      transportation: '自驾',
      accommodation: '经济型酒店',
      attractions: [
        {
          name: '八达岭长城',
          address: '北京市延庆区',
          location: { longitude: 116.024, latitude: 40.362 },
          visit_duration: 240,
          description: '明长城精华段',
          category: '自然风光',
          ticket_price: 40
        }
      ],
      meals: []
    }
  ],
  weather_info: [
    {
      date: '2025-06-02',
      day_weather: '多云',
      night_weather: '晴',
      day_temp: '28°C',
      night_temp: '18℃',
      wind_direction: '南风',
      wind_power: '1-3级'
    },
    {
      date: '2025-06-01',
      day_weather: '晴',
      night_weather: '多云',
      day_temp: 30,
      night_temp: 20,
      wind_direction: '北风',
      wind_power: '3-4级'
    }
  ],
  overall_suggestions: '建议提前预约故宫门票。',
  budget: {
    total_attractions: 100,
    total_hotels: 700,
    total_meals: 205,
    total_transportation: 100,
    total: 1105
  }
}

var plan = planUtil.normalizePlan(raw)

console.log('\n[normalizePlan]')
check('城市', plan.city, '北京')
check('天数', plan.travelDays, 2)
check('景点总数（含无坐标项）', plan.attractionCount, 3)
check('日期区间', plan.dateRangeText, '2025-06-01 至 2025-06-02')

console.log('\n[坐标清洗]')
check('无效 (0,0) 坐标被丢弃', plan.days[0].attractions[1].location, null)
check('有效坐标保留纬度', plan.days[0].attractions[0].location.latitude, 39.90923)

console.log('\n[景点]')
check('免费景点文案', plan.days[0].attractions[0].ticketText, '免费')
check('收费景点文案', plan.days[0].attractions[1].ticketText, '门票 ¥60')
check('游览时长文案', plan.days[0].attractions[1].durationText, '3 小时')

console.log('\n[餐饮排序]')
check('早餐排到晚餐前', plan.days[0].meals[0].label, '早餐')
check('晚餐排最后', plan.days[0].meals[1].label, '晚餐')
check('无餐饮的日子为空数组', plan.days[1].meals.length, 0)

console.log('\n[酒店]')
check('酒店被识别', plan.days[0].hotel.name, '前门如家')
check('酒店附加信息', plan.days[0].hotel.metaText, '300-400元 · 评分 4.5 · 距天安门 1 公里 · 经济型酒店')
check('酒店单价文案', plan.days[0].hotel.costText, '¥350 / 晚')
check('没推荐酒店时为 null', plan.days[1].hotel, null)

console.log('\n[天气]')
check('天气按日期升序', plan.weatherList[0].date, '2025-06-01')
check('温度字符串被清洗', plan.weatherList[0].dayTempText, '30°')
check('温度带单位也能清洗', plan.weatherList[1].nightTempText, '18°')
check('逐日天气已挂载到对应天', plan.days[0].weather.dayWeather, '晴')
check('第二天天气已挂载', plan.days[1].weather.dayWeather, '多云')

console.log('\n[预算]')
check('预算合计', plan.budget.totalText, '¥1,105')
check('预算分项数量', plan.budget.items.length, 4)

console.log('\n[buildPlainText]')
var text = planUtil.buildPlainText(plan)
check('纯文本非空', text.length > 0, true)
check('纯文本包含第 1 天', text.indexOf('【第 1 天】') > -1, true)
check('纯文本包含门票信息', text.indexOf('门票 ¥60') > -1, true)

// ---------- 边界 ----------
console.log('\n[边界情况]')
check('null 输入返回 null', planUtil.normalizePlan(null), null)
check('空对象不抛异常', planUtil.normalizePlan({}) !== null, true)
check('空计划天数为 0', planUtil.normalizePlan({}).travelDays, 0)
check('无日期时区间兜底', planUtil.normalizePlan({ days: [] }).dateRangeText, '日期待定')

console.log('\n----------------------------------------')
if (failures.length) {
  console.log('结果：' + failures.length + ' 项未通过 -> ' + failures.join(', '))
  process.exitCode = 1
} else {
  console.log('结果：全部通过')
}
