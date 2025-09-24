//
/*可以用浏览器插件SwitchyOmega设置代理
Protocol：选择 HTTP（因为 Workers 使用 HTTP/HTTPS）。
Server：输入你的 Workers 域名，例如 your-worker.workers.dev（不要包含 https://）。
Port：留空或填 443（Cloudflare Workers 默认使用 HTTPS 端口）。
Bypass List：可以添加不需要代理的域名（如 *.local），默认可留空。
*/
//修改 Workers 代码，让它直接从请求的路径中提取目标 URL，而无需手动拼接 ?url=。

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  // 从路径中提取目标 URL（例如 /https://example.com）
  let targetUrl = url.pathname.slice(1); // 去掉开头的 /
  
  if (!targetUrl) {
    return new Response('Please provide a target URL in the path', { status: 400 });
  }
  
  // 确保目标 URL 有协议头
  if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
    targetUrl = 'https://' + targetUrl;
  }
  
  if (!targetUrl.startsWith('https://')) {
    return new Response('Only HTTPS URLs allowed', { status: 403 });
  }

  const newRequest = new Request(targetUrl, {
    method: request.method,
    headers: {
      ...request.headers,
      'User-Agent': request.headers.get('User-Agent') || 'Cloudflare-Proxy',
    },
    body: request.body,
  });

  try {
    const response = await fetch(newRequest);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: { ...Object.fromEntries(response.headers), ...corsHeaders },
    });
  } catch (error) {
    return new Response(`Proxy error: ${error.message}`, { status: 500 });
  }
}
