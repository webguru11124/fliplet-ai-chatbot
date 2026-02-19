// Tool definitions use a compact builder so adding a new tool is one line of config,
// not 20 lines of schema boilerplate.

const def = (name, description, properties = {}, required = []) => ({
  name,
  description,
  input_schema: { type: 'object', properties, required },
});

const num = (desc) => ({ type: 'number', description: desc });

function buildTools(appId) {
  return [
    def(
      'get_app_info',
      `Fetch app metadata (name, settings, pages, icon, etc.) for app ${appId}.`,
      { app_id: num(`App ID. Defaults to ${appId}.`) }
    ),
    def(
      'list_data_sources',
      `List every data source attached to app ${appId}: names, IDs, row counts.`,
      { app_id: num(`App ID. Defaults to ${appId}.`) }
    ),
    def(
      'get_data_source',
      'Get full details of one data source — columns, hooks, access rules.',
      { data_source_id: num('Data source ID.') },
      ['data_source_id']
    ),
    def(
      'get_data_source_entries',
      'Fetch rows from a data source. Large results are auto-truncated to 50 rows.',
      { data_source_id: num('Data source ID.') },
      ['data_source_id']
    ),
    def(
      'list_media_folders',
      `List media/file folders for app ${appId}.`,
      { app_id: num(`App ID. Defaults to ${appId}.`) }
    ),
    def(
      'get_folder_files',
      'List every file inside a media folder.',
      { folder_id: num('Folder ID.') },
      ['folder_id']
    ),
    def(
      'get_file_info',
      'Get metadata for a single file — URL, size, type, created date.',
      { file_id: num('File ID.') },
      ['file_id']
    ),
  ];
}

// Route a tool call to the right FlipletAPI method.
// Returns raw API response (JSON-serialisable).
async function executeTool(name, input, api, defaultAppId) {
  const id = (key) => input[key];
  const appId = input.app_id || defaultAppId;

  const routes = {
    get_app_info: () => api.getApp(appId),
    list_data_sources: () => api.listDataSources(appId),
    get_data_source: () => api.getDataSource(id('data_source_id')),
    get_data_source_entries: () => api.getDataSourceEntries(id('data_source_id')),
    list_media_folders: () => api.listMediaFolders(appId),
    get_folder_files: () => api.getFolderFiles(id('folder_id')),
    get_file_info: () => api.getFile(id('file_id')),
  };

  const handler = routes[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  return handler();
}

module.exports = { buildTools, executeTool };
