export const API = 'https://guandan.miai.moe';
export const validCode = code => /^[A-Z0-9]{6}$/.test(code);

export async function roomRequest(path, data) {
  const options = { signal: AbortSignal.timeout(15000) };
  if (data !== undefined) {
    Object.assign(options, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });
  }
  const response = await fetch(API + '/api/rooms' + path, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.detail?.message ?? ('房间请求失败（HTTP ' + response.status + '）'));
  return body;
}

export function connectRoom(code, token, { receive, status }) {
  let socket;
  let closed = false;
  let ready = false;
  let retry = 0;
  let heartbeat;
  let timer;

  function connect() {
    status('connecting');
    socket = new WebSocket(API.replace(/^http/, 'ws') + '/ws/rooms/' + code);
    let awaiting = false;
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ type: 'hello', player_token: token, protocol: 2 }));
      heartbeat = setInterval(() => {
        if (awaiting) {
          socket.close();
          return;
        }
        awaiting = true;
        socket.send(JSON.stringify({ type: 'ping' }));
      }, 15000);
    });
    socket.addEventListener('message', event => {
      if (closed) return;
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      awaiting = false;
      if (message.type === 'pong') return;
      if (message.type === 'error' && ['room_not_found', 'invalid_token', 'page_outdated'].includes(message.code)) {
        closed = true;
        socket.close();
        status('gone', message);
        return;
      }
      if (!ready && (message.type === 'room' || message.type === 'state')) {
        retry = 0;
        ready = true;
        status('open');
      }
      receive(message);
    });
    socket.addEventListener('close', () => {
      ready = false;
      clearInterval(heartbeat);
      if (closed) return;
      status('connecting');
      timer = setTimeout(connect, Math.min(8000, 500 * 2 ** retry++));
    });
  }

  connect();
  return {
    send(action) {
      if (!ready || socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify({ type: 'action', action }));
      return true;
    },
    close() {
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(timer);
      socket.close();
    }
  };
}

const storagePrefix = 'guandan-studio:';
export function readLocal(key, fallback = null) {
  try { return JSON.parse(localStorage.getItem(storagePrefix + key)) ?? fallback; }
  catch { return fallback; }
}

export function writeLocal(key, value) {
  try { localStorage.setItem(storagePrefix + key, JSON.stringify(value)); }
  catch { /* Keep the current session playable if storage is unavailable. */ }
}
