const http = require('http');
const https = require('https');

const CONFIG = {
  FEISHU_APP_ID: process.env.FEISHU_APP_ID,
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  SORFTIME_KEY: process.env.SORFTIME_KEY || 'e3f3af52ac2e4e2fa4d4c280426076b1',
  PORT: process.env.PORT || 3000
};

const processedMessages = new Set();

function httpsPost(hostname, path, headers, body, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = https.request({
      hostname, path, method: 'POST', port: 443,
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

async function callClaude(userMessage) {
  console.log('[调用Claude+MCP] 开始，时间:', new Date().toISOString());
  
  const res = await httpsPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': CONFIG.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'mcp-client-2025-04-04'
  }, {
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: '你是专业的亚马逊选品顾问，精通Sorftime选品方法论。在有利润的前提下，用最短时间、最低风险，帮助用户发现高潜力市场机会，验证竞争环境，测算投入产出，并打造差异化产品。请使用Sorftime MCP工具进行真实数据分析，输出结构化的选品报告。',
    messages: [{ role: 'user', content: userMessage }],
    mcp_servers: [{ type: 'url', url: `https://mcp.sellersprite.com/mcp?secret-key=${CONFIG.SORFTIME_KEY}`, name: 'sorftime-mcp' }]
  }, 600000); // 10分钟超时

  console.log('[Claude响应] 时间:', new Date().toISOString(), '类型:', res.type);
  
  // 检查是否有错误
  if (res.type === 'error') {
    throw new Error(res.error?.message || JSON.stringify(res));
  }

  let text = '';
  if (res.content && Array.isArray(res.content)) {
    for (const block of res.content) { if (block.type === 'text') text += block.text; }
  }
  
  if (!text) {
    console.log('[Claude完整响应]', JSON.stringify(res).substring(0, 500));
    throw new Error('Claude返回空内容，stop_reason: ' + res.stop_reason);
  }
  
  return text;
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
  console.log(`[处理] chatId=${chatId}, text=${text}`);

  try {
    const token = await getFeishuToken();
    await sendFeishuMessage(token, chatId, `🔍 正在调用Sorftime数据分析，请稍候（约2-3分钟）...`);

    let reply = await callClaude(text);
    if (reply.length > 4000) reply = reply.substring(0, 3900) + '...\n（内容较长已截断）';

    const token2 = await getFeishuToken();
    await sendFeishuMessage(token2, chatId, reply);
    console.log('[回复成功]');
  } catch(e) {
    console.error('[处理失败]', e.message);
    try {
      const t = await getFeishuToken();
      await sendFeishuMessage(t, chatId, '抱歉，处理请求时出现错误：' + e.message);
    } catch(e2) {}
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET') { res.writeHead(200); res.end('飞书Sorftime选品机器人运行中'); return; }

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
      console.error('[解析错误]', e.message);
      res.writeHead(200); res.end(JSON.stringify({ code: 0 }));
    }
  });
});

server.listen(CONFIG.PORT, () => console.log(`🚀 机器人已启动，端口: ${CONFIG.PORT}`));


