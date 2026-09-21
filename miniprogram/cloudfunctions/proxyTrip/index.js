/**
 * proxyTrip —— 后端请求中转云函数
 *
 * 存在意义：wx.request 在「体验版 / 正式版」只允许请求已在小程序后台登记的
 * HTTPS 域名。云函数出网不受该白名单限制，因此把请求先交给云函数、
 * 再由云函数转发给自建 FastAPI，就能绕开「request 合法域名」这道门槛。
 *
 * ⚠️ 三条硬约束（都踩过或有明确依据，别忽略）：
 *
 * 1) 云函数跑在腾讯云的机器上，BACKEND_URL 必须**公网可访问**。
 *    写 http://localhost:8000 或 127.0.0.1 一定失败 —— 那台服务器上没有你的后端。
 *    本地后端想被访问到，得先做内网穿透（ngrok / frp / cpolar 等）或正式部署。
 *
 * 2) 云函数默认超时 3 秒，本项目的多智能体规划实测 17~25 秒。
 *    必须把超时调到 60 秒（见同目录 config.json，或在云开发控制台改）。
 *    注意 60s 是本链路的硬天花板，比 wx.request 的 115s 更低。
 *
 * 3) 不要把 BACKEND_URL 写死在代码里 —— 云函数代码在控制台可见，
 *    写死等于把后端地址公开。请用环境变量注入（见下方 readBackend）。
 *
 * 安全：只放行 /api/ 前缀的路径，避免这个函数被当成任意目标的开放代理（SSRF）。
 *
 * 附：云数据库集合 trips 的由来
 *   小程序端 wx.cloud.database() 不能建集合，只能由服务端 SDK 建。当初借本函数
 *   临时加过一个 action=initCollection 分支建了 trips，建完即已删除 —— 现在这个函数
 *   只做转发，不再接受任何非转发指令（否则等于给所有用户开了个「随便建集合」的口子）。
 *   若换了云环境需要重建集合：在「云开发控制台 → 数据库 → 新建集合」输入 trips 即可，
 *   权限选「仅创建者可读写」。
 */

const cloud = require('wx-server-sdk')
const http = require('http')
const https = require('https')
const urlLib = require('url')

// 用当前环境初始化。DYNAMIC_CURRENT_ENV 表示「云函数被部署到哪个环境就用哪个」，
// 避免把环境 ID 写死在云函数里；个别 SDK 版本若未导出该常量，则退回默认环境。
const cloudInitOptions = {}
if (cloud.DYNAMIC_CURRENT_ENV) {
  cloudInitOptions.env = cloud.DYNAMIC_CURRENT_ENV
}
cloud.init(cloudInitOptions)

// 允许转发的路径前缀白名单
const ALLOWED_PREFIXES = ['/api/']

// 转发到后端时的等待上限（留一点余量给网络与序列化）
const UPSTREAM_TIMEOUT = 55000

// 兜底后端地址。留空表示「只认环境变量」。
const FALLBACK_BACKEND_URL = ''

/**
 * 解析后端地址：优先环境变量，其次兜底常量。
 * 推荐在「云开发控制台 → 云函数 → proxyTrip → 配置 → 环境变量」里配 BACKEND_URL，
 * 这样换环境不用改代码、也不会把地址写进仓库。
 */
function readBackend () {
  const fromEnv = process.env.BACKEND_URL
  if (fromEnv && String(fromEnv).trim()) {
    return String(fromEnv).trim().replace(/\/+$/, '')
  }
  return FALLBACK_BACKEND_URL
}

function isAllowedPath (path) {
  if (!path || path.charAt(0) !== '/') {
    return false
  }
  for (let i = 0; i < ALLOWED_PREFIXES.length; i++) {
    if (path.indexOf(ALLOWED_PREFIXES[i]) === 0) {
      return true
    }
  }
  return false
}

function fail (statusCode, message) {
  return {
    ok: false,
    statusCode: statusCode || 0,
    error: message
  }
}

/**
 * 真正干活的一层：用 Node 原生 http/https 发一次请求，把响应体原样收回来。
 */
function forward (targetUrl, method, bodyText, incomingHeaders) {
  return new Promise(function (resolve, reject) {
    let parsed
    try {
      parsed = new urlLib.URL(targetUrl)
    } catch (e) {
      reject(new Error('BACKEND_URL 不是合法 URL：' + targetUrl))
      return
    }

    const isHttps = parsed.protocol === 'https:'
    const transport = isHttps ? https : http
    const payload = bodyText ? Buffer.from(bodyText, 'utf8') : null

    const headers = {
      'content-type': 'application/json',
      accept: 'application/json'
    }
    if (payload) {
      headers['content-length'] = payload.length
    }
    // 便于后端串联日志（可选）
    if (incomingHeaders && incomingHeaders['x-request-id']) {
      headers['x-request-id'] = incomingHeaders['x-request-id']
    }

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + (parsed.search || ''),
        method: method,
        headers: headers,
        timeout: UPSTREAM_TIMEOUT
      },
      function (res) {
        const chunks = []
        res.on('data', function (chunk) {
          chunks.push(chunk)
        })
        res.on('end', function () {
          resolve({
            statusCode: res.statusCode,
            text: Buffer.concat(chunks).toString('utf8')
          })
        })
      }
    )

    req.on('timeout', function () {
      req.destroy(new Error('请求后端超时（> ' + Math.round(UPSTREAM_TIMEOUT / 1000) + 's）'))
    })
    req.on('error', function (err) {
      reject(err)
    })

    if (payload) {
      req.write(payload)
    }
    req.end()
  })
}

/**
 * 入口。
 * 客户端调用方式：
 *   wx.cloud.callFunction({ name: 'proxyTrip', data: { path, method, data } })
 */
exports.main = async function (event) {
  const evt = event || {}

  const backend = readBackend()

  if (!backend) {
    return fail(0, '云函数未配置后端地址：请在云开发控制台给 proxyTrip 添加环境变量 BACKEND_URL（必须是公网可访问的地址）')
  }

  const path = evt.path
  const method = String(evt.method || 'POST').toUpperCase()

  if (!isAllowedPath(path)) {
    return fail(0, '拒绝转发：path 必须是以 ' + ALLOWED_PREFIXES.join(' / ') + ' 开头的相对路径，当前为 ' + String(path))
  }

  let bodyText = ''
  if (method !== 'GET' && evt.data !== undefined && evt.data !== null) {
    try {
      bodyText = JSON.stringify(evt.data)
    } catch (e) {
      return fail(0, '请求体无法序列化为 JSON：' + e.message)
    }
  }

  const targetUrl = backend + path

  try {
    const res = await forward(targetUrl, method, bodyText, evt.headers)
    let parsedBody = res.text

    // 后端返回 JSON 时顺手解析，省得客户端再解析一次
    try {
      parsedBody = JSON.parse(res.text)
    } catch (e) {
      // 非 JSON 原样透传（例如 FastAPI 的纯文本错误页）
    }

    return {
      ok: true,
      statusCode: res.statusCode,
      data: parsedBody
    }
  } catch (err) {
    console.error('[proxyTrip] 转发失败 target=' + targetUrl, err)
    return fail(0, '云函数转发后端失败：' + (err && err.message ? err.message : String(err)) + '（请确认 BACKEND_URL 公网可达）')
  }
}
