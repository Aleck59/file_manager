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

const q = (params) => {
  const usp = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null));
  return usp.toString() ? `?${usp}` : '';
};

export const api = {
  me: () => request('GET', '/api/auth/me'),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword, newPassword) => request('POST', '/api/auth/password', { currentPassword, newPassword }),

  stats: () => request('GET', '/api/stats'),
  listFolder: (folder, cursor) => request('GET', `/api/files${q({ folder, cursor })}`),
  createFolder: (parent, name) => request('POST', '/api/folders', { parent, name }),
  deleteFolder: (path) => request('POST', '/api/folders/delete', { path }),

  startUpload: (file, folder) => request('POST', '/api/uploads', { name: file.name, size: file.size, type: file.type, folder }),
  partUrls: (key, uploadId, partNumbers) => request('POST', '/api/uploads/parts', { key, uploadId, partNumbers }),
  completeUpload: (key, uploadId) => request('POST', '/api/uploads/complete', { key, uploadId }),
  abortUpload: (key, uploadId) => request('POST', '/api/uploads/abort', { key, uploadId }),

  downloadLink: (key, ttl) => request('POST', '/api/files/link', { key, ttl }),
  preview: (key) => request('POST', '/api/files/preview', { key }),
  deleteFile: (key) => request('DELETE', `/api/files${q({ key })}`),

  listUsers: () => request('GET', '/api/users'),
  createUser: (user) => request('POST', '/api/users', user),
  updateUser: (username, changes) => request('PATCH', `/api/users/${encodeURIComponent(username)}`, changes),
  deleteUser: (username) => request('DELETE', `/api/users/${encodeURIComponent(username)}`),

  storageInfo: () => request('GET', '/api/settings/storage'),
  checkStorage: () => request('POST', '/api/settings/storage/check'),
};
