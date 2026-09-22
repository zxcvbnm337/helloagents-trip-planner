/**
 * 请求层：对外只暴露 request / get / post，内部按 config.TRANSPORT 选择真实通道。
 *
 * 三种通道对调用方完全透明，返回值契约一致（resolve 后端响应的 data，reject Error）：
 *   direct          → wx.request
 *   cloud-function  → wx.cloud.callFunction('proxyTrip')
 *   cloud-container → wx.cloud.callContainer
 *
 * 注意：不使用可选链（?.）与空值合并（??），以兼容较低基础库版本。
 */

var config = require('../config/index')

var BASE_URL = config.BASE_URL
var REQUEST_TIMEOUT = config.REQUEST_TIMEOUT

function isObject(value) {
  return value !== null && typeof value === 'object'
}

/**
 * 把 HTTP 非 2xx 的响应体压成一句人话
 * 兼容 FastAPI 的 {detail} 与本项目的 {message}
 */
function describeHttpError(status, payload) {
  var detail = 'HTTP ' + status
  if (isObject(payload)) {
    detail = payload.detail || payload.message || detail
  }
  return detail
}

/**
 * 把又长又脏的原始 errMsg 压成一小段能读的话。
 *
 * 必要性：wx.cloud.callFunction 的 errMsg 实测长这样（一整屏）——
 *   "cloud.callFunction:fail Error: errCode: -501000 | errMsg: FunctionName
 *    parameter could not be found. 更多错误信息请访问：https://docs.cloudbase.net/
 *    error-code/basic/FUNCTION_NOT_FOUND (callId: 1789984121285-0.31...) (trace: ...)"
 * 直接塞进 wx.showModal 会变成满屏乱码，用户根本读不到重点。
 *
 * 策略（保守清洗，不改变语义）：
 *   1. 抽出 errCode —— 这是唯一值得保留的结构化信息；
 *   2. 去掉文档链接、(callId: ...)、(trace: ...) 这些对用户无意义的尾巴；
 *   3. 折叠空白、限长 80 字。
 */
function summarizeRaw(text) {
  var t = String(text || '')

  // 错误码有两种写法，都要认：
  //   · 云函数 / 云开发：`errCode: -501000`
  //   · 云托管 callContainer：`code: 102002`（实测格式，注意**不是** errCode）
  // 只认 errCode 的话，云托管的错误码会被整段丢掉，用户看不到任何可检索的线索。
  var code = ''
  var matched = t.match(/(?:errCode|code)\s*[:：]\s*(-?\d+)/)
  if (matched) {
    code = matched[1]
  }

  t = t.replace(/https?:\/\/\S+/g, ' ')
  t = t.replace(/\(callId:[^)]*\)/g, ' ')
  t = t.replace(/\(trace:[^)]*\)/g, ' ')
  t = t.replace(/更多错误信息请访问[:：]?/g, ' ')
  // errCode 已经单独抽出来放在前面了，正文里再出现就是冗余
  t = t.replace(/(?:errCode|code)\s*[:：]\s*-?\d+/gi, ' ')
  t = t.replace(/errMsg:\s*/gi, ' ')
  // 两种 API 的前缀都要剥，且 `Error:` 必须**可选**：
  //   · 云函数：`cloud.callFunction:fail Error: errCode: -501000`
  //   · 云托管：`cloud.callContainer:fail 102002 . cloud.callContainer:fail system error.`
  //     —— 云托管这条**没有** `Error:` token，写成必选就一个都匹配不上，
  //        前缀会被原样弹给用户（2026-09-22 实测暴露，回归用例已锁住）。
  t = t.replace(/cloud\.call(?:Function|Container):fail(?:\s*Error:?)?/gi, ' ')
  t = t.replace(/\brequest:fail\b/gi, ' ')
  t = t.replace(/\babort\b/gi, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  // 清掉残留的孤立标点（"… , )" 这种）
  t = t.replace(/^[\s:：,，|（）()\-—]+/, '')
  t = t.replace(/[\s:：,，|（）()\-—]+$/, '')

  // 云托管的 errMsg 实测是**两层拼接**的，形如
  //   `cloud.callContainer:fail 102002 . cloud.callContainer:fail system error. code: 102002`
  // 剥掉前缀后，错误码会以裸 token 残留在最前面，与下面拼的「（102002）」重复。
  // 只处理**开头**这一处，避免误删正文里恰好等于该数字的内容。
  if (code && t.indexOf(code) === 0) {
    t = t.replace(new RegExp('^' + code + '[\\s.。·,，—-]*'), '')
  }

  if (t.length > 80) {
    t = t.slice(0, 80) + '…'
  }

  if (code) {
    return '（' + code + '）' + (t || '无更多信息')
  }
  return t || '未知错误'
}

/**
 * 把 wx.request 的底层错误翻译成人能看懂、能照着做的提示
 */
function describeError(err) {
  var raw = (err && err.errMsg) || ''
  var text = String(raw)

  if (text.indexOf('domain list') > -1 || text.indexOf('合法域名') > -1) {
    return '请求域名未在合法域名列表中：开发者工具可在「详情 → 本地设置」勾选“不校验合法域名”；' +
      '真机需把 BASE_URL 换成已备案的 https 域名并在小程序后台登记 request 合法域名，' +
      '或把 TRANSPORT 改成 cloud-container（云托管，免备案域名，推荐）/ cloud-function（云函数中转）'
  }
  if (text.indexOf('timeout') > -1 || text.indexOf('超时') > -1) {
    return '生成超时：多智能体规划耗时较长，请重试，或减少旅行天数后再次生成'
  }
  if (text.indexOf('fail') > -1 && text.indexOf('refused') > -1) {
    return '连接后端失败：请确认 FastAPI 服务已启动（默认 http://localhost:8000），且端口未被占用'
  }
  // 兜底：不要再把一整串原始 errMsg 甩给用户
  return summarizeRaw(text)
}

/**
 * cloud-function 通道的失败翻译
 *
 * 实测样本（云函数未部署时）：
 *   errMsg = "cloud.callFunction:fail Error: errCode: -501000 | errMsg:
 *            FunctionName parameter could not be found ... (callId: ...) (trace: ...)"
 * 注意：文案是 "could not be found"，**不包含**连续的 "not found" 子串，
 * 只匹配 'not found' 会漏掉这个最常见的情况（这个坑就是实测踩出来的）。
 */
function describeCloudError(err) {
  var raw = (err && err.errMsg) || (err && err.message) || ''
  var text = String(raw)

  if (text.indexOf('-501000') > -1 || text.indexOf('-404011') > -1 ||
    text.indexOf('FUNCTION_NOT_FOUND') > -1 ||
    text.indexOf('could not be found') > -1 || text.indexOf('not found') > -1) {
    return '云函数不存在或未部署：请在开发者工具里右键 cloudfunctions/proxyTrip →「上传并部署：云端安装依赖」，并确认云函数名与 config/index.js 的 CLOUD_PROXY_NAME 一致'
  }
  if (text.indexOf('-601002') > -1 || text.indexOf('env not exists') > -1 ||
    text.indexOf('invalid env') > -1) {
    return '云开发环境不可用：请确认该 AppID 下已开通 config/index.js 中 CLOUD_ENV 指定的环境'
  }
  if (text.indexOf('timeout') > -1 || text.indexOf('-504003') > -1) {
    return '云函数执行超时：云函数默认超时仅 3 秒，请到云开发控制台把 proxyTrip 的超时时间调到 60 秒'
  }
  // 兜底：只保留 errCode + 一小段摘要，完整原文留给 console
  return '云函数调用失败：' + summarizeRaw(text)
}

/* ------------------------------------------------------------------
 * 通道 1：直连
 * ------------------------------------------------------------------ */

function viaRequest(url, method, data, timeout) {
  return new Promise(function (resolve, reject) {
    wx.request({
      url: BASE_URL + url,
      method: method,
      data: data,
      header: {
        'content-type': 'application/json'
      },
      timeout: timeout,
      success: function (res) {
        var status = res.statusCode
        if (status >= 200 && status < 300) {
          resolve(res.data)
          return
        }
        reject(new Error(describeHttpError(status, res.data)))
      },
      fail: function (err) {
        var friendly = describeError(err)
        // 原始 errMsg 只在这里能拿到（页面层收到的已经是翻译后的 Error），
        // 所以排障日志必须打在这一层，用字符串拼好避免序列化成 {}。
        console.error('[request][direct] 请求失败 | errMsg: ' + ((err && err.errMsg) || '(无)') +
          ' | 翻译后: ' + friendly)
        reject(new Error(friendly))
      }
    })
  })
}

/* ------------------------------------------------------------------
 * 通道 2：云函数中转
 * ------------------------------------------------------------------ */

function viaCloudFunction(url, method, data) {
  return new Promise(function (resolve, reject) {
    if (!wx.cloud || !wx.cloud.callFunction) {
      reject(new Error('当前基础库不支持云函数（需 2.2.3+），请升级基础库，或把 config/index.js 的 TRANSPORT 改回 direct'))
      return
    }

    wx.cloud.callFunction({
      name: config.CLOUD_PROXY_NAME,
      data: {
        path: url,
        method: method,
        data: data
      },
      success: function (res) {
        var payload = res && res.result

        // 云函数自身失败（未配环境变量后端地址、路径被拒、转发异常等）
        if (!payload || payload.ok !== true) {
          reject(new Error((payload && payload.error) || '云函数中转返回结构异常'))
          return
        }

        var status = payload.statusCode
        if (status >= 200 && status < 300) {
          resolve(payload.data)
          return
        }
        reject(new Error(describeHttpError(status, payload.data)))
      },
      fail: function (err) {
        var friendly = describeCloudError(err)
        console.error('[request][cloud-function] 调用失败 | errMsg: ' + ((err && err.errMsg) || '(无)') +
          ' | 翻译后: ' + friendly)
        reject(new Error(friendly))
      }
    })
  })
}

/* ------------------------------------------------------------------
 * 通道 3：云托管
 * ------------------------------------------------------------------ */

/**
 * 解析 callContainer 要用的环境 ID。
 *
 * config.env 是必填项，不能留空，所以这里必须有兜底。
 * 但兜底只能是「回退到云开发环境 ID」这种尽力而为 —— 微信云托管与微信云开发
 * 是两套独立体系（见 config/index.js 的注释），两者 ID 通常并不相同。
 * 回退时打一条 warn，避免用户对着 -601002 猜半天。
 */
function resolveContainerEnv() {
  if (config.CLOUD_CONTAINER_ENV) {
    return config.CLOUD_CONTAINER_ENV
  }
  console.warn('[request][cloud-container] 未配置 CLOUD_CONTAINER_ENV，' +
    '回退使用云开发环境 ID「' + config.CLOUD_ENV + '」。' +
    '若云托管服务不在该环境，请到微信云托管控制台复制环境 ID 填入 config/index.js')
  return config.CLOUD_ENV
}

function viaCloudContainer(url, method, data, timeout) {
  return new Promise(function (resolve, reject) {
    if (!wx.cloud || !wx.cloud.callContainer) {
      reject(new Error('当前基础库不支持云托管调用（需 2.20.0+），请升级基础库，或改用 TRANSPORT = \'cloud-function\' / \'direct\''))
      return
    }

    wx.cloud.callContainer({
      config: {
        env: resolveContainerEnv()
      },
      path: url,
      method: method,
      header: {
        'X-WX-SERVICE': config.CLOUD_CONTAINER_SERVICE,
        'content-type': 'application/json'
      },
      data: data,
      // 显式带上超时预算。callContainer 的参数与 wx.request 一致，
      // 不传就吃 wx.request 的默认值（60s）——而本链路实测 17~25s，
      // 再叠上云托管「缩容到 0」的冷启动（容器要从零拉起），60s 会不够。
      timeout: timeout,
      success: function (res) {
        var status = res.statusCode
        if (status >= 200 && status < 300) {
          resolve(res.data)
          return
        }
        reject(new Error(describeHttpError(status, res.data)))
      },
      fail: function (err) {
        var raw = (err && err.errMsg) || ''
        console.error('[request][cloud-container] 调用失败 | errMsg: ' + (raw || '(无)'))
        reject(new Error('云托管调用失败：' + summarizeRaw(raw) +
          '（请确认服务名 ' + config.CLOUD_CONTAINER_SERVICE + ' 已部署；' +
          '若超时，多半是缩容到 0 后的冷启动，重试一次即可）'))
      }
    })
  })
}

/* ------------------------------------------------------------------
 * 统一入口
 * ------------------------------------------------------------------ */

function request(options) {
  var opt = options || {}
  var url = opt.url
  var method = opt.method || 'GET'
  var data = opt.data || {}
  var timeout = opt.timeout || REQUEST_TIMEOUT

  // 打一行通道日志。三个通道的**外部表现差异很大**（域名校验、超时上限、
  // 是否需要后端公网可达），而它们由 config.TRANSPORT 一个开关决定 ——
  // 排查「到底走的哪条路」时没有这行会非常费解：例如 direct 在真机上必然报
  // 合法域名错，但本地开发一切正常，光看现象分不清是通道选错还是服务没起来。
  console.log('[request] 通道=' + config.TRANSPORT + ' ' + method + ' ' + url)

  if (config.TRANSPORT === 'cloud-function') {
    return viaCloudFunction(url, method, data)
  }
  if (config.TRANSPORT === 'cloud-container') {
    return viaCloudContainer(url, method, data, timeout)
  }
  return viaRequest(url, method, data, timeout)
}

function get(url, data, options) {
  var opt = options || {}
  opt.url = url
  opt.method = 'GET'
  opt.data = data
  return request(opt)
}

function post(url, data, options) {
  var opt = options || {}
  opt.url = url
  opt.method = 'POST'
  opt.data = data
  return request(opt)
}

module.exports = {
  request: request,
  get: get,
  post: post
}
