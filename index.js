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

// 创建飞书文档并写入内容
async function createFeishuDoc(token, title, content) {
  // 第一步：创建空文档
  const createRes = await httpsPost('open.feishu.cn', '/open-apis/docx/v1/documents', 
    { Authorization: `Bearer ${token}` },
    { title }
  );
  console.log('[创建文档]', JSON.stringify(createRes).substring(0, 200));
  
  const docId = createRes.data?.document?.document_id;
  if (!docId) throw new Error('创建文档失败: ' + JSON.stringify(createRes));

  // 第二步：将 markdown 内容转换为飞书文档块
  const blocks = markdownToBlocks(content);
  
  // 第三步：批量写入内容块
  await httpsPost('open.feishu.cn', `/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children/batch_update`,
    { Authorization: `Bearer ${token}` },
    { requests: blocks }
  );

  return `https://docs.feishu.cn/docs/${docId}`;
}

// 简单的 markdown 转飞书文档块
function markdownToBlocks(markdown) {
  const lines = markdown.split('\n');
  const requests = [];
  
  for (const line of lines) {
    if (!line.trim()) continue;
    
    let block;
    if (line.startsWith('# ')) {
      block = { block_type: 2, heading1: { elements: [{ type: 0, text_run: { content: line.replace(/^# /, ''), text_element_style: {} } }] } };
    } else if (line.startsWith('## ')) {
      block = { block_type: 3, heading2: { elements: [{ type: 0, text_run: { content: line.replace(/^## /, ''), text_element_style: {} } }] } };
    } else if (line.startsWith('### ')) {
      block = { block_type: 4, heading3: { elements: [{ type: 0, text_run: { content: line.replace(/^### /, ''), text_element_style: {} } }] } };
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      block = { block_type: 12, bullet: { elements: [{ type: 0, text_run: { content: line.replace(/^[-*] /, ''), text_element_style: {} } }] } };
    } else if (/^\d+\. /.test(line)) {
      block = { block_type: 13, ordered: { elements: [{ type: 0, text_run: { content: line.replace(/^\d+\. /, ''), text_element_style: {} } }] } };
    } else {
      // 处理粗体 **text**
      const content = line.replace(/\*\*(.*?)\*\*/g, '$1');
      block = { block_type: 1, text: { elements: [{ type: 0, text_run: { content, text_element_style: {} } }] } };
    }
    
    requests.push({ index: requests.length + 1, block });
  }
  
  return requests;
}

// 判断是否需要生成飞书文档
function needsDoc(text) {
  const keywords = ['飞书文档', '生成文档', '创建文档', '文档报告', '保存文档', '写成文档', '整理成文档'];
  return keywords.some(k => text.includes(k));
}

async function callClaude(userMessage, withDoc = false) {
  console.log('[调用Claude+MCP] 开始，时间:', new Date().toISOString());
  
  const systemPrompt = withDoc
    ? '你是专业的亚马逊选品顾问，精通Sorftime选品方法论。请使用Sorftime MCP工具进行真实数据分析，输出完整结构化的选品报告。报告用Markdown格式，包含：一、市场规模概览，二、竞争格局分析，三、机会产品筛选，四、财务测算，五、差异化建议，六、行动计划。'
    : '你是专业的亚马逊选品顾问，精通Sorftime选品方法论。在有利润的前提下，用最短时间、最低风险，帮助用户发现高潜力市场机会，验证竞争环境，测算投入产出，并打造差异化产品。请使用Sorftime MCP工具进行真实数据分析，输出结构化的选品报告。';

  const res = await httpsPost('api.anthropic.com', '/v1/messages', {
    'x-api-key': CONFIG.ANTHROPIC_API_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'mcp-client-2025-04-04'
  }, {
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    mcp_servers: [{ type: 'url', url: `https://mcp.sorftime.com?key=${CONFIG.SORFTIME_KEY}`, name: 'sorftime-mcp' }]
  }, 600000);

  console.log('[Claude响应] 时间:', new Date().toISOString(), '类型:', res.type);
  if (res.type === 'error') throw new Error(res.error?.message || JSON.stringify(res));

  let text = '';
  if (res.content && Array.isArray(res.content)) {
    for (const block of res.content) { if (block.type === 'text') text += block.text; }
  }
  if (!text) throw new Error('Claude返回空内容');
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
  const wantDoc = needsDoc(text);
  console.log(`[处理] chatId=${chatId}, wantDoc=${wantDoc}, text=${text}`);

  try {
    const token = await getFeishuToken();
    
    if (wantDoc) {
      await sendFeishuMessage(token, chatId, `📄 正在生成完整选品报告并创建飞书文档，请稍候（约2-3分钟）...`);
    } else {
      await sendFeishuMessage(token, chatId, `🔍 正在调用Sorftime数据分析，请稍候（约60秒）...`);
    }

    let reply = await callClaude(text, wantDoc);

    const token2 = await getFeishuToken();

    if (wantDoc) {
      // 提取标题
      const titleMatch = reply.match(/^#\s+(.+)$/m);
      const docTitle = titleMatch ? titleMatch[1].replace(/[🔴🟡🟢📊💡🎯]/g, '').trim() : '选品分析报告';
      
      try {
        const docUrl = await createFeishuDoc(token2, docTitle, reply);
        await sendFeishuMessage(token2, chatId, `✅ 飞书文档已生成！\n\n📄 **${docTitle}**\n🔗 ${docUrl}\n\n点击链接查看完整报告。`);
      } catch(docErr) {
        console.error('[创建文档失败]', docErr.message);
        // 文档创建失败则直接发文字
        if (reply.length > 4000) reply = reply.substring(0, 3900) + '...\n（内容较长已截断，建议重新发送含"飞书文档"关键词）';
        await sendFeishuMessage(token2, chatId, reply);
      }
    } else {
      if (reply.length > 4000) reply = reply.substring(0, 3900) + '...\n（内容较长，发送「生成飞书文档」可获取完整报告）';
      await sendFeishuMessage(token2, chatId, reply);
    }

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


