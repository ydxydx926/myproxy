// VLESS Proxy for Cloudflare Workers
// 基于 https://github.com/zizifn/edgetunnel/blob/main/src/worker-vless.js
// 修改：添加环境变量支持，简化日志。

const userID = '19671020-0926-0104-0918-196710200926';  // 默认 UUID，优先使用 env.UUID
let proxyIP = '162.159.192.1';   // 默认 proxyIP，优先使用 env.PROXYIP

// UUID 验证函数
function isValidUUID(uuid) {
  const regex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return regex.test(uuid);
}

// 延迟函数
function delay2(t) {
  return new Promise(resolve => setTimeout(resolve, t));
}

// 关闭 WebSocket 安全函数
async function safeCloseWS(ws) {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(1000, 'close');
      await delay2(100);
    }
  } catch (e) {
    console.error('safeCloseWS error:', e);
  }
}

// 处理 TCP 出站连接
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log) {
  async function connectAndWrite(address, port) {
    const tcpSocket = connect({ hostname: address, port: port });
    remoteSocket.value = tcpSocket;
    log(`connected to ${address}:${port}`);
    const writer = tcpSocket.writable.getWriter();
    await writer.write(rawClientData);
    writer.releaseLock();
    return tcpSocket;
  }

  const earlyDataHeader = new Uint8Array([0]);
  if (webSocket.readyState === WebSocket.OPEN) {
    webSocket.send(vlessResponseHeader);
    webSocket.send(earlyDataHeader);
  }

  let tcpSocket;
  try {
    tcpSocket = await connectAndWrite(addressRemote, portRemote);
  } catch (e) {
    log(`tcpSocket connectAndWrite error: ${e}`);
    if (webSocket.readyState === WebSocket.OPEN) {
      webSocket.send(new Uint8Array([1]));
      webSocket.close(1011, 'tcpSocket connectAndWrite error');
    }
    return;
  }

  const reader = tcpSocket.readable.getReader();
  const writer = webSocket.readyState === WebSocket.OPEN ? webSocket : null;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (writer && webSocket.readyState === WebSocket.OPEN) {
        writer.send(value);
      } else {
        log('webSocket is not ready');
        break;
      }
    }
  } catch (e) {
    log(`tcpSocket reader error: ${e}`);
  } finally {
    reader.releaseLock();
    await safeCloseWS(webSocket);
    try {
      tcpSocket.close();
    } catch (e) {
      log('tcpSocket close error:', e);
    }
  }

  log(`tcpSocket connection end`);
}

// VLESS 响应头部生成
function vlessResponseHeader(isHead) {
  const arr = new Uint8Array(20);
  const view = new DataView(arr.buffer);
  view.setUint8(0, 0);
  view.setUint8(1, isHead ? 0 : 1);
  view.setUint16(2, 0, true);
  view.setUint16(4, 0, true);
  view.setUint16(6, 0, true);
  view.setUint16(8, 0, true);
  view.setUint16(10, 0, true);
  view.setUint16(12, 0, true);
  view.setUint32(14, Date.now() / 1000 | 0, true);
  return arr;
}

// 处理 TCP 入站
async function handleTCPInBound(remoteSocket, webSocket, addressRemote, portRemote, log) {
  const vlessResponseHeaderBytes = vlessResponseHeader(true);
  log(`handleTCPInBound: ${addressRemote}:${portRemote}`);

  const writer = remoteSocket.value.writable.getWriter();
  let remoteSocketClosed = false;
  let webSocketClosed = false;

  const onWsMessage = ({ data }) => {
    if (remoteSocketClosed || webSocketClosed) return;
    if (remoteSocket.value.readyState === 'closed') {
      remoteSocketClosed = true;
      safeCloseWS(webSocket);
      return;
    }
    writer.write(data).catch((e) => {
      log('writer.write error:', e);
      remoteSocketClosed = true;
      safeCloseWS(webSocket);
    });
  };
  const onWsClose = () => {
    webSocketClosed = true;
    remoteSocket.value.close();
  };
  const onWsError = () => {
    webSocketClosed = true;
    remoteSocket.value.close();
  };
  webSocket.addEventListener('message', onWsMessage);
  webSocket.addEventListener('close', onWsClose);
  webSocket.addEventListener('error', onWsError);

  await handleTCPOutBound(remoteSocket, addressRemote, portRemote, new Uint8Array(), webSocket, vlessResponseHeaderBytes, log);
}

// 处理 WebSocket
async function handleWebSocket(clientWebSocket, serverWebSocket, request, env, log) {
  let vlessBuffer = new Uint8Array(0);
  let remoteSocket = { value: null };
  let addressRemote = '';
  let portRemote = 0;
  let hasReceived = false;

  serverWebSocket.accept();

  const onWsMessage = async ({ data }) => {
    if (!hasReceived) {
      hasReceived = true;
      vlessBuffer = new Uint8Array(data);
      try {
        const { hasError, address, port, isUdp, rawClientData, vlessResponse } = await processVlessHeader(vlessBuffer, request, env, log);
        if (hasError) {
          log('hasError');
          await safeCloseWS(serverWebSocket);
          return;
        }
        addressRemote = address;
        portRemote = port;
        if (isUdp) {
          // UDP 处理（DNS over UDP 示例，简化）
          log('UDP request, handling as DNS');
          // 这里可集成 DoH，如使用 serverless-dns
          serverWebSocket.send(vlessResponse);
        } else {
          // TCP 处理
          await handleTCPInBound(remoteSocket, serverWebSocket, addressRemote, portRemote, log);
        }
      } catch (e) {
        log('processVlessHeader error:', e);
        await safeCloseWS(serverWebSocket);
      }
    } else {
      // 后续数据转发
      if (remoteSocket.value && remoteSocket.value.readyState === 'open') {
        const writer = remoteSocket.value.writable.getWriter();
        writer.write(data).catch(e => log('forward error:', e));
      }
    }
  };

  serverWebSocket.addEventListener('message', onWsMessage);
}

// VLESS 头部解析
async function processVlessHeader(vlessBuffer, request, env, log) {
  const version = vlessBuffer[0];
  if (version !== 0) throw new Error('Not vless');

  const userID = env.UUID || userID;
  if (!isValidUUID(userID)) throw new Error('Invalid UUID');

  if (vlessBuffer.slice(1, 37).toString() !== userID.replace(/-/g, '')) {
    throw new Error('Invalid userID');
  }

  const metadataBuffer = vlessBuffer.slice(37);
  const metadataView = new DataView(metadataBuffer.buffer);

  let metadataIndex = 0;
  const cmd = metadataView.getUint8(metadataIndex++);
  const port = metadataView.getUint16(metadataIndex, true); metadataIndex += 2;

  let addressLength = 0;
  let address = '';
  const atyp = metadataView.getUint8(metadataIndex++);
  switch (atyp) {
    case 1: // IPv4
      address = `${metadataView.getUint8(metadataIndex + i) >> 0}.${metadataView.getUint8(metadataIndex + i + 1) >> 0}.${metadataView.getUint8(metadataIndex + i + 2) >> 0}.${metadataView.getUint8(metadataIndex + i + 3) >> 0}`;
      metadataIndex += 4;
      break;
    case 2: // Domain
      addressLength = metadataView.getUint16(metadataIndex, true);
      metadataIndex += 2;
      const tempBytes = new Uint8Array(metadataBuffer.slice(metadataIndex, metadataIndex + addressLength));
      address = new TextDecoder().decode(tempBytes);
      metadataIndex += addressLength;
      break;
    case 3: // IPv6 (简化，省略)
      break;
    default:
      throw new Error('Invalid atyp');
  }

  // 使用 proxyIP 如果地址是 Cloudflare 相关
  if (address.startsWith('cf.')) {
    address = env.PROXYIP || proxyIP;
  }

  const rawClientData = vlessBuffer.slice(metadataIndex);
  const isUdp = cmd === 2; // UDP 命令

  log(`address: ${address}, port: ${port}, isUdp: ${isUdp}`);

  const vlessResponse = vlessResponseHeader(false);
  return { hasError: false, address, port, isUdp, rawClientData, vlessResponse };
}

export default {
  async fetch(request, env, ctx) {
    const log = (...args) => console.log('[vless]', ...args); // 简化日志

    const userID = env.UUID || userID;
    const proxyIP = env.PROXYIP || proxyIP;

    if (!isValidUUID(userID)) {
      return new Response('Invalid UUID config', { status: 500 });
    }

    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      const url = new URL(request.url);
      if (url.pathname === '/bestip/' + userID) {
        // 订阅生成（Clash/VLESS 链接）
        const subscribe = `vless://${userID}@${url.host}:443?encryption=none&security=tls&type=ws&host=${url.host}&path=/?ed=2048#VLESS-Worker`;
        return new Response(subscribe, { headers: { 'Content-Type': 'text/plain' } });
      }
      return new Response('Not WebSocket', { status: 400 });
    }

    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    handleWebSocket(client, server, request, env, log).catch(e => {
      log('handleWebSocket error:', e);
      safeCloseWS(server);
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  },
};
