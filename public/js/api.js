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
  twoFactorSetup: () => request('POST', '/api/auth/2fa/setup'),
  twoFactorEnable: (code) => request('POST', '/api/auth/2fa/enable', { code }),
  twoFactorDisable: (password) => request('POST', '/api/auth/2fa/disable', { password }),
  twoFactorRecovery: (password) => request('POST', '/api/auth/2fa/recovery', { password }),
  resetTwoFactor: (username) => request('POST', `/api/users/${encodeURIComponent(username)}/2fa/reset`),
  acl: (folder) => request('GET', `/api/admin/acl${q({ folder })}`),
  setAcl: (folder, rule) => request('PUT', '/api/admin/acl', { folder, rule }),
  personal: () => request('GET', '/api/personal'),
  folderById: (id) => request('GET', `/api/folders/id/${encodeURIComponent(id)}`),
  backups: () => request('GET', '/api/admin/backup'),
  createBackup: (data) => request('POST', '/api/admin/backup', data),
  deleteBackup: (id) => request('DELETE', `/api/admin/backup/${encodeURIComponent(id)}`),
  runBackup: (id) => request('POST', `/api/admin/backup/${encodeURIComponent(id)}/run`),
  restoreBackup: (id) => request('POST', `/api/admin/backup/${encodeURIComponent(id)}/restore`),
  logout: () => request('POST', '/api/auth/logout'),
  changePassword: (currentPassword, newPassword) => request('POST', '/api/auth/password', { currentPassword, newPassword }),
  sessions: () => request('GET', '/api/auth/sessions'),
  revokeSession: (id) => request('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`),
  revokeOtherSessions: () => request('POST', '/api/auth/sessions/revoke-others'),
  tokens: () => request('GET', '/api/auth/tokens'),
  createToken: (name, readOnly) => request('POST', '/api/auth/tokens', { name, readOnly }),
  revokeToken: (id) => request('DELETE', `/api/auth/tokens/${encodeURIComponent(id)}`),

  stats: () => request('GET', '/api/stats'),
  // Папки сортируются здесь, «по-русски» и с учётом чисел (на сервере — без ICU ради памяти).
  listFolder: (folder, cursor) => request('GET', `/api/files${q({ folder, cursor })}`).then((res) => {
    res.folders.sort((a, b) => a.name.localeCompare(b.name, 'ru', { numeric: true }));
    return res;
  }),
  createFolder: (parent, name) => request('POST', '/api/folders', { parent, name }),
  deleteFolder: (path) => request('POST', '/api/folders/delete', { path }),
  archive: (what) => request('POST', '/api/files/archive', what),

  startUpload: (file, folder, subfolders) => request('POST', '/api/uploads', { name: file.name, size: file.size, type: file.type, folder, subfolders }),
  partUrls: (key, uploadId, partNumbers) => request('POST', '/api/uploads/parts', { key, uploadId, partNumbers }),
  completeUpload: (key, uploadId) => request('POST', '/api/uploads/complete', { key, uploadId }),
  importUrl: (url, folder) => request('POST', '/api/uploads/url', { url, folder }),
  jobStatus: (id) => request('GET', `/api/jobs/${encodeURIComponent(id)}`),
  jobCancel: (id) => request('POST', `/api/jobs/${encodeURIComponent(id)}/cancel`),
  transfer: (key, storage) => request('POST', '/api/files/transfer', { key, storage }),
  abortUpload: (key, uploadId) => request('POST', '/api/uploads/abort', { key, uploadId }),
  resumeUpload: (key, uploadId) => request('POST', '/api/uploads/resume', { key, uploadId }),

  downloadLink: (key, ttl) => request('POST', '/api/files/link', { key, ttl }),
  preview: (key) => request('POST', '/api/files/preview', { key }),
  thumbs: (keys) => request('POST', '/api/files/thumbs', { keys }),
  deleteFile: (key) => request('DELETE', `/api/files${q({ key })}`),
  deleteFiles: (keys) => request('POST', '/api/files/delete', { keys }),
  zipList: (key) => request('POST', '/api/files/zip', { key }),
  office: (key) => request('POST', '/api/files/office', { key }),
  setLabel: (data) => request('PUT', '/api/labels', data),
  search: (params) => request('GET', `/api/search${q(params)}`),
  moveFolder: (path, data) => request('POST', '/api/folders/move', { path, ...data }),
  trash: () => request('GET', '/api/trash'),
  restoreTrash: (id, key) => request('POST', '/api/trash/restore', { id, key }),
  purgeTrash: (id, key) => request('POST', '/api/trash/delete', { id, key }),
  emptyTrash: () => request('POST', '/api/trash/empty'),
  moveFile: (key, { folder, name } = {}) => request('POST', '/api/files/move', { key, folder, name }),
  copyFile: (key, { folder, name } = {}) => request('POST', '/api/files/copy', { key, folder, name }),

  listUsers: () => request('GET', '/api/users'),
  createUser: (user) => request('POST', '/api/users', user),
  updateUser: (username, changes) => request('PATCH', `/api/users/${encodeURIComponent(username)}`, changes),
  deleteUser: (username) => request('DELETE', `/api/users/${encodeURIComponent(username)}`),

  audit: (filter) => request('GET', `/api/admin/audit${q(filter)}`),
  shares: (all) => request('GET', `/api/shares${all ? '?all=1' : ''}`),
  createShare: (data) => request('POST', '/api/shares', data),
  revokeShare: (id) => request('POST', `/api/shares/${encodeURIComponent(id)}/revoke`),
  deleteShare: (id) => request('DELETE', `/api/shares/${encodeURIComponent(id)}`),
  updateShare: (id, data) => request('PATCH', `/api/shares/${encodeURIComponent(id)}`, data),
  getSettings: () => request('GET', '/api/settings'),
  branding: () => request('GET', '/api/branding'),
  uploadLogo: (data) => request('PUT', '/api/settings/logo', { data }),
  removeLogo: () => request('DELETE', '/api/settings/logo'),
  importSettings: (data) => request('POST', '/api/settings/import', { data }),
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
