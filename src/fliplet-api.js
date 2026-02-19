const BASE = 'https://api.fliplet.com';
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 500;

// Cap large payloads so we don't blow up Claude's context window.
// Entries beyond this limit get summarised with a count + sample.
const MAX_ENTRIES = 50;

class FlipletAPI {
  constructor(token) {
    if (!token) throw new Error('FLIPLET_API_TOKEN is missing');
    this.token = token;
  }

  async get(path) {
    let lastErr = new Error(`Failed after ${MAX_RETRIES} attempts: ${path}`);
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: { 'Auth-token': this.token },
        });
        if (res.status === 429) {
          lastErr = new Error(`429 Rate Limited on ${path}`);
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`${res.status} ${res.statusText} — ${body.slice(0, 200)}`);
        }
        return res.json();
      } catch (err) {
        lastErr = err;
        if (attempt < MAX_RETRIES - 1) await sleep(RETRY_BASE_MS * 2 ** attempt);
      }
    }
    throw lastErr;
  }

  getApp(id) {
    return this.get(`/v1/apps/${id}`);
  }

  listDataSources(appId) {
    return this.get(`/v1/data-sources?appId=${appId}`);
  }

  getDataSource(id) {
    return this.get(`/v1/data-sources/${id}`);
  }

  async getDataSourceEntries(id) {
    const data = await this.get(`/v1/data-sources/${id}/data`);
    return truncateEntries(data);
  }

  listMediaFolders(appId) {
    return this.get(`/v1/media/folders?appId=${appId}`);
  }

  getFolderFiles(folderId) {
    return this.get(`/v1/media/folders/${folderId}/files`);
  }

  getFile(id) {
    return this.get(`/v1/media/files/${id}`);
  }
}

// Prevent multi-thousand-row data dumps from consuming all of Claude's context.
// Returns a trimmed version with metadata about what was cut.
function truncateEntries(data) {
  const entries = data?.entries || data?.rows || (Array.isArray(data) ? data : null);
  if (!entries || entries.length <= MAX_ENTRIES) return data;

  const sample = entries.slice(0, MAX_ENTRIES);
  return {
    _truncated: true,
    _totalCount: entries.length,
    _shownCount: MAX_ENTRIES,
    _note: `Showing first ${MAX_ENTRIES} of ${entries.length} entries. Ask the user if they need more.`,
    entries: sample,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = FlipletAPI;
