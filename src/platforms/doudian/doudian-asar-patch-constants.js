const ORIGINAL_INSTALL_DIR = 'D:\\抖店工作台\\1.1.7-login.1';
const TEST_INSTALL_DIR = 'D:\\抖店工作台_bridge_test\\1.1.7-login.1';

const PROTECTED_INSTALL_DIR_PATTERN = /D:[\\/]抖店工作台[\\/]1\.1\.7-login\.1/i;
/** @deprecated 使用 TEST_INSTALL_DIR */
const RECOMMENDED_TEST_DIR = TEST_INSTALL_DIR;

const PATCH_MARKER = '__DOUDIAN_BRIDGE_PATCH__';
const PRELOAD_TEST_FLAG = '__DOUDIAN_PRELOAD_PATCH_TEST__';
const BRIDGE_PATCH_FLAG = '__DOUDIAN_BRIDGE_PATCH__';

const PATCH_TARGET_FILES = [
  'electron\\webview_preload_index.js',
  'electron\\webview_preload_vendor.js',
  'electron\\rust_im_worker_index.js',
];

const PATCH_OPTIONAL_FILES = new Set(['electron\\rust_im_worker_index.js']);

const PATCH_TARGET_FILE = PATCH_TARGET_FILES[0];
const WORKSPACE_URL_PATTERN = 'im.jinritemai.com/pc_seller_desk_v2/main/workspace';
const HOMEPAGE_URL_PATTERN = 'fxg.jinritemai.com/ffa/mshop/homepage';
const IM_WORKSPACE_URL = `https://${WORKSPACE_URL_PATTERN}`;

const KEY_FILES_AFTER_COPY = [
  'doudian.exe',
  'resources\\app.asar',
  'tt_electron_config.json',
  'shell_config.json',
];

const OPTIONAL_KEY_FILES = ['resources\\app.asar.unpacked'];

const KILL_PROCESS_NAMES = [
  'doudian.exe',
  'app_shell_updater.exe',
  'tt_crash_reporter.exe',
  '抖店工作台.exe',
  '抖店工作台_doctor.exe',
];

const KILL_PROCESS_WARN_ONLY = ['parfait_crash_handler.exe'];

module.exports = {
  ORIGINAL_INSTALL_DIR,
  TEST_INSTALL_DIR,
  PROTECTED_INSTALL_DIR_PATTERN,
  RECOMMENDED_TEST_DIR,
  PATCH_MARKER,
  PRELOAD_TEST_FLAG,
  BRIDGE_PATCH_FLAG,
  PATCH_TARGET_FILES,
  PATCH_OPTIONAL_FILES,
  PATCH_TARGET_FILE,
  WORKSPACE_URL_PATTERN,
  HOMEPAGE_URL_PATTERN,
  IM_WORKSPACE_URL,
  KEY_FILES_AFTER_COPY,
  OPTIONAL_KEY_FILES,
  KILL_PROCESS_NAMES,
  KILL_PROCESS_WARN_ONLY,
};
