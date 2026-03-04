const http = require('http');
const https = require('https');

const CONFIG = {
  FEISHU_APP_ID: process.env.FEISHU_APP_ID,
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
  PORT: process.env.PORT || 3000
};

const processedMessages = new Set();

function httpRequest(useHttps, hostname, path, headers, body, timeoutMs = 30000, port) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const lib = useHttps ? https : http;
    const defaultPort = useHttps ? 443 : 80;
    const req = lib.request({
      hostname, path, method: 'POST', port: port || defaultPort,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      timeout: timeoutMs
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`Request timeout after ${timeoutMs}ms`)); });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// 便捷函数
const httpsPost = (hostname, path, headers, body, timeoutMs) => httpRequest(true, hostname, path, headers, body, timeoutMs);

async function getFeishuToken() {
  const res = await httpsPost('open.feishu.cn', '/open-apis/auth/v3/tenant_access_token/internal', {}, {
    app_id: CONFIG.FEISHU_APP_ID, app_secret: CONFIG.FEISHU_APP_SECRET
  });
  return res.tenant_access_token;
}

async function sendFeishuMessage(token, chatId, text) {
  return await httpsPost('open.feishu.cn', '/open-apis/im/v1/messages?receive_id_type=chat_id',
    { Authorization: `Bearer ${token}` },
    { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) }
  );
}

// 调用n8n工作流做分析（n8n内部用Sorftime MCP + DeepSeek，完成后直接发飞书消息）
async function callN8nAnalysis(text, chatId, senderOpenId, isDeep, isDoc) {
  console.log('[调用n8n分析]', new Date().toISOString(), 'text:', text.substring(0, 50));
  const res = await httpRequest(
    false,
    'n8n-hual.zeabur.internal',
    '/webhook/feishu-sorftime-bot',
    { 'Content-Type': 'application/json' },
    { text, chatId, senderOpenId: senderOpenId || '', isDeep, isDoc },
    600000,
    5678
  );
  console.log('[n8n分析响应]', JSON.stringify(res).substring(0, 200));
  return res;
}

function detectIntent(text) {
  const deepKeywords = ['深度分析', '完整分析', '系统分析', '全面分析', '深入分析'];
  const docKeywords = ['飞书文档', '生成文档', '创建文档', '文档报告', '写成文档'];
  return {
    isDeep: deepKeywords.some(k => text.includes(k)),
    isDoc: docKeywords.some(k => text.includes(k))
  };
}

async function handleMessage(data) {
  const body = data.body ?? data;
  const event = body.event ?? body;
  const message = event.message ?? body.message;

  if (!message || message.message_type !== 'text') return;

  const messageId = message.message_id;
  if (processedMessages.has(messageId)) { console.log('[跳过重复]', messageId); return; }
  processedMessages.add(messageId);
  if (processedMessages.size > 1000) processedMessages.delete(processedMessages.values().next().value);

  let text = '';
  try {
    const c = JSON.parse(message.content ?? '{}');
    text = (c.text ?? '').replace(/@[^\s]*/g, '').trim();
  } catch(e) {
    text = (message.content ?? '').replace(/@[^\s]*/g, '').trim();
  }
  if (!text) return;

  const chatId = message.chat_id;
  const senderOpenId = event.sender?.sender_id?.open_id ?? null;
  const { isDeep, isDoc } = detectIntent(text);
  console.log('[处理] isDeep=' + isDeep + ' isDoc=' + isDoc + ' text=' + text);

  try {
    const token = await getFeishuToken();

    const hint = isDoc
      ? '🚀 开始深度分析，将自动完成：\n① 筛选潜力细分类目\n② 分析对标竞品\n③ 查询1688采购成本\n④ 利润测算\n⑤ 生成完整报告\n⑥ 创建飞书文档\n\n⏱ 预计需要3-5分钟...'
      : isDeep ? '🔍 正在深度分析，请稍候3-5分钟...'
      : '🔍 正在查询数据，请稍候...';
    await sendFeishuMessage(token, chatId, hint);

    callN8nAnalysis(text, chatId, senderOpenId, isDeep, isDoc)
      .then(() => console.log('[n8n分析完成]'))
      .catch(e => {
        console.error('[n8n分析失败]', e.message);
        getFeishuToken()
          .then(t => sendFeishuMessage(t, chatId, '⚠️ 分析失败：' + e.message))
          .catch(() => {});
      });

    console.log('[已转交n8n处理]');
  } catch(e) {
    console.error('[处理失败]', e.message);
    try {
      const t = await getFeishuToken();
      await sendFeishuMessage(t, chatId, '⚠️ 处理请求时出现错误：' + e.message);
    } catch(e2) {}
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('飞书Sorftime选品机器人 v3.0'); return; }
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      if (data.type === 'url_verification' || data.challenge) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ challenge: data.challenge }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
      handleMessage(data).catch(e => console.error('[异步错误]', e.message));
    } catch(e) {
      res.writeHead(200); res.end(JSON.stringify({ code: 0 }));
    }
  });
});

server.listen(CONFIG.PORT, () => console.log('🚀 飞书选品机器人 v3.0 启动，端口: ' + CONFIG.PORT));
