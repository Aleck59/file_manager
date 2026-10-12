// Обёртка над fetch для API бэкенда: JSON, понятные ошибки, редирект на вход при 401.
export class ApiError extends Error {
  constructor(message, status, data = {}) {
    super(message);
    this.status = status;
    this.code = data.code;
    this.data = data;
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
  if (!res.ok) throw new ApiError(data.error || `Ошибка сервера (${res.status})`, res.status, data);
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
  // Папки сортируются здесь, «по-русски» и с учётом чисел (на сервере — без ICU ради памяти).
  listFolder: (folder, cursor) => request('GET', `/api/files${q({ folder, cursor })}`).then((res) => {
    res.folders.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    return res;
  }),
  createFolder: (parent, name) => request('POST', '/api/folders', { parent, name }),
  deleteFolder: (path) => request('POST', '/api/folders/delete', { path }),

  startUpload: (file, folder, subfolders) => request('POST', '/api/uploads', { name: file.name, size: file.size, type: file.type, folder, subfolders }),
  partUrls: (key, uploadId, partNumbers) => request('POST', '/api/uploads/parts', { key, uploadId, partNumbers }),
  completeUpload: (key, uploadId) => request('POST', '/api/uploads/complete', { key, uploadId }),
  abortUpload: (key, uploadId) => request('POST', '/api/uploads/abort', { key, uploadId }),

  downloadLink: (key, ttl) => request('POST', '/api/files/link', { key, ttl }),
  preview: (key) => request('POST', '/api/files/preview', { key }),
  thumbs: (keys) => request('POST', '/api/files/thumbs', { keys }),
  deleteFile: (key) => request('DELETE', `/api/files${q({ key })}`),
  moveFile: (key, { folder, name } = {}) => request('POST', '/api/files/move', { key, folder, name }),

  listUsers: () => request('GET', '/api/users'),
  createUser: (user) => request('POST', '/api/users', user),
  updateUser: (username, changes) => request('PATCH', `/api/users/${encodeURIComponent(username)}`, changes),
  deleteUser: (username) => request('DELETE', `/api/users/${encodeURIComponent(username)}`),

  getSettings: () => request('GET', '/api/settings'),
  saveSettings: (values, opts = {}) => request('PUT', '/api/settings', { values, ...opts }),
  resetSettings: (keys, opts = {}) => request('POST', '/api/settings/reset', { keys, ...opts }),
  checkStorage: (storage, id) => request('POST', '/api/settings/storages/check', { storage, id }),
  addStorage: (storage, opts = {}) => request('POST', '/api/settings/storages', { storage, ...opts }),
  updateStorage: (id, storage, opts = {}) => request('PUT', `/api/settings/storages/${encodeURIComponent(id)}`, { storage, ...opts }),
  removeStorage: (id) => request('DELETE', `/api/settings/storages/${encodeURIComponent(id)}`),
  reorderStorages: (ids) => request('PUT', '/api/settings/storages-order', { ids }),
  setPlacement: (placement) => request('PUT', '/api/settings/placement', { placement }),
  applyCors: (id) => request('POST', `/api/settings/storages/${encodeURIComponent(id)}/cors`),
  diagnoseStorage: (id) => request('POST', `/api/settings/storages/${encodeURIComponent(id)}/diagnose`),
  cleanupDiagnose: (id, key) => request('POST', `/api/settings/storages/${encodeURIComponent(id)}/diagnose/cleanup`, { key }),
  resetSessions: () => request('POST', '/api/settings/sessions/reset'),
  restart: () => request('POST', '/api/settings/restart'),
};
