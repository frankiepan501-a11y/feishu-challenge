const http = require('http');

const N8N_WEBHOOK = 'https://frankiepan501.zeabur.app/webhook/feishu-sorftime';
const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(200);
    res.end('OK');
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      console.log('[收到飞书请求]', JSON.stringify(data).substring(0, 200));

      if (data.type === 'url_verification' || data.challenge) {
        console.log('[Challenge验证] 返回:', data.challenge);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ challenge: data.challenge }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));

      const https = require('https');
      const payload = JSON.stringify(data);
      const url = new URL(N8N_WEBHOOK);
      const n8nReq = https.request({
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
      }, (n8nRes) => console.log('[转发n8n]', n8nRes.statusCode));
      n8nReq.on('error', (e) => console.error('[转发失败]', e.message));
      n8nReq.write(payload);
      n8nReq.end();

    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ code: 0 }));
    }
  });
});

server.listen(PORT, () => console.log(`服务已启动，端口: ${PORT}`));
