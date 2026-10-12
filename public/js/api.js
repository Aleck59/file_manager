// Обёртка над fetch для API бэкенда: JSON, понятные ошибки, редирект на вход при 401.
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Сервер недоступен. Проверьте подключение к интернету.', 0);
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    window.location.replace('/login');
    throw new ApiError('Сессия истекла', 401);
  }
  if (!res.ok) throw new ApiError(data.error || `Ошибка сервера (${res.status})`, res.status);
  return data;
}

export const api = {
  listFiles: (cursor) => request('GET', `/api/files${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`),
  startUpload: (file) => request('POST', '/api/uploads', { name: file.name, size: file.size, type: file.type }),
  partUrls: (key, uploadId, partNumbers) => request('POST', '/api/uploads/parts', { key, uploadId, partNumbers }),
  completeUpload: (key, uploadId) => request('POST', '/api/uploads/complete', { key, uploadId }),
  abortUpload: (key, uploadId) => request('POST', '/api/uploads/abort', { key, uploadId }),
  downloadLink: (key, ttl) => request('POST', '/api/files/link', { key, ttl }),
  deleteFile: (key) => request('DELETE', `/api/files?key=${encodeURIComponent(key)}`),
  logout: () => request('POST', '/api/auth/logout'),
};
