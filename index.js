const http = require('http');
const https = require('https');

const CONFIG = {
  FEISHU_APP_ID: process.env.FEISHU_APP_ID,
  FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  SORFTIME_KEY: process.env.SORFTIME_KEY || 'cxkzv1irntrqbwj6c1i1c3dannb5zz09',
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

async function createFeishuDoc(title, content, senderOpenId) {
  console.log('[调用n8n] 开始创建飞书文档, title:', title.substring(0, 50));
  const res = await httpsPost(
    'frankiepan501.zeabur.app',
    '/webhook/create-feishu-doc',
    { 'Content-Type': 'application/json' },
    { title, content, sender_open_id: senderOpenId || '' },
    120000
  );
  console.log('[n8n响应]', JSON.stringify(res).substring(0, 300));
  if (res && res.success && res.doc_url) return res.doc_url;
  throw new Error('n8n创建文档失败: ' + JSON.stringify(res).substring(0, 200));
}


function detectIntent(text) {
  const deepKeywords = ['深度分析', '完整分析', '系统分析', '全面分析', '深入分析'];
  const docKeywords = ['飞书文档', '生成文档', '创建文档', '文档报告', '写成文档'];
  return {
    isDeep: deepKeywords.some(k => text.includes(k)),
    isDoc: docKeywords.some(k => text.includes(k))
  };
}

async function callClaudeOnce(userMessage, systemPrompt) {
  const res = await httpsPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': CONFIG.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'mcp-client-2025-04-04'
  }, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    mcp_servers: [{ type: 'url', url: `https://mcp.sorftime.com?key=${CONFIG.SORFTIME_KEY}`, name: 'sorftime-mcp' }]
  }, 600000);

  console.log('[Claude响应]', new Date().toISOString(), 'type:', res.type);
  if (res.type === 'error') throw new Error(res.error?.message || JSON.stringify(res));

  let text = '';
  if (res.content && Array.isArray(res.content)) {
    for (const block of res.content) { if (block.type === 'text') text += block.text; }
  }
  if (!text) throw new Error('Claude返回空内容，stop_reason: ' + res.stop_reason);
  return text;
}

async function callClaude(userMessage, systemPrompt, chatId) {
  const maxRetries = 3;
  for (let i = 1; i <= maxRetries; i++) {
    try {
      console.log(`[调用Claude] 第${i}次尝试:`, new Date().toISOString());
      return await callClaudeOnce(userMessage, systemPrompt);
    } catch(e) {
      const isMcpError = e.message.includes('timed out') || e.message.includes('unavailable') || e.message.includes('unresponsive');
      console.error(`[第${i}次失败]`, e.message);
      if (i < maxRetries && isMcpError) {
        const token = await getFeishuToken();
        await sendFeishuMessage(token, chatId, `⏳ MCP连接不稳定，正在重试（第${i}次/共${maxRetries}次）...`);
        await new Promise(r => setTimeout(r, 3000));
      } else {
        throw e;
      }
    }
  }
}

const NORMAL_SYSTEM = `你是专业的亚马逊选品顾问，精通Sorftime选品方法论。
请根据用户问题灵活使用Sorftime MCP工具查询真实数据后回答。
回答简洁专业，重点突出，使用中文。`;

const DEEP_SYSTEM = `你是亚马逊选品顾问，使用Sorftime MCP工具做深度分析。

步骤：
1. category_search_from_product_name 找3个潜力细分类目（月销>5000，亚马逊占比<30%，Top3集中度<50%）
2. category_report 获取每个类目Top产品和对标竞品数据
3. ali1688_similar_product 查询主要竞品的1688采购价，计算毛利率

输出完整Markdown报告，包含：
# [产品] 亚马逊[站点]深度选品报告
## 一、市场机会总览（3个类目对比）
## 二、竞争格局分析（头部品牌/集中度/切入机会）
## 三、对标竞品分析（ASIN/月销量/价格/评论数）
## 四、1688采购与利润测算（采购成本/FBA费/毛利率）
## 五、差异化打造建议
## 六、综合推荐与行动计划

所有数据标注来源于Sorftime MCP实时数据。`;

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
  const senderOpenId = event.sender?.sender_id?.open_id ?? body.event?.sender?.sender_id?.open_id ?? null;
  const { isDeep, isDoc } = detectIntent(text);
  console.log(`[处理] isDeep=${isDeep} isDoc=${isDoc} text=${text}`);

  try {
    const token = await getFeishuToken();

    // 发送等待提示
    const hint = isDoc
      ? `🚀 开始深度分析，将自动完成：\n① 筛选潜力细分类目\n② 分析对标竞品\n③ 查询1688采购成本\n④ 利润测算\n⑤ 生成完整报告\n⑥ 创建飞书文档\n\n⏱ 预计需要3-5分钟...`
      : isDeep ? `🔍 正在深度分析，请稍候3-5分钟...` : `🔍 正在查询数据，请稍候...`;
    await sendFeishuMessage(token, chatId, hint);

    // 异步调用n8n完成分析+发消息（n8n负责后续所有流程）
    callN8nAnalysis(text, chatId, senderOpenId, isDeep, isDoc)
      .then(() => console.log('[n8n分析完成]'))
      .catch(e => {
        console.error('[n8n分析失败]', e.message);
        getFeishuToken().then(t => sendFeishuMessage(t, chatId, `⚠️ 分析失败：${e.message}`)).catch(()=>{});
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
  if (req.method === 'GET') { res.writeHead(200); res.end('飞书Sorftime选品机器人 v2.0'); return; }
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

server.listen(CONFIG.PORT, () => console.log(`🚀 飞书选品机器人 v2.0 启动，端口: ${CONFIG.PORT}`));
