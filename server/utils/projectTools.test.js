const test = require('node:test');
const assert = require('node:assert/strict');

const {
  getWechatLaunchCandidates,
  getWechatLaunchSpec,
  resolveWechatLaunchSpec,
  resolveWechatCliPath,
  normalizeWechatDevtoolsConfig,
  normalizeProjectTagsByPath,
  isMiniProgramTagged,
  getWechatCliCandidates,
} = require('./projectTools');

test('normalizeWechatDevtoolsConfig trims configured platform paths', () => {
  const result = normalizeWechatDevtoolsConfig({
    windowsPath: '  C:\\Program Files\\WeChat\\cli.bat  ',
    macosPath: '  /Applications/wechatwebdevtools.app  ',
  });

  assert.deepEqual(result, {
    windowsPath: 'C:\\Program Files\\WeChat\\cli.bat',
    macosPath: '/Applications/wechatwebdevtools.app',
  });
});

test('normalizeProjectTagsByPath keeps only object entries and boolean flags', () => {
  const result = normalizeProjectTagsByPath({
    'D:\\demo\\a': { isMiniProgram: true },
    'D:\\demo\\b': { isMiniProgram: false },
    'D:\\demo\\c': null,
    'D:\\demo\\d': 'mini',
  });

  assert.deepEqual(result, {
    'D:\\demo\\a': { isMiniProgram: true },
    'D:\\demo\\b': { isMiniProgram: false },
  });
});

test('isMiniProgramTagged returns true only for explicitly tagged projects', () => {
  const projectTags = {
    'D:\\demo\\mini': { isMiniProgram: true },
    'D:\\demo\\web': { isMiniProgram: false },
  };

  assert.equal(isMiniProgramTagged(projectTags, 'D:\\demo\\mini'), true);
  assert.equal(isMiniProgramTagged(projectTags, 'D:\\demo\\web'), false);
  assert.equal(isMiniProgramTagged(projectTags, 'D:\\demo\\missing'), false);
});

test('getWechatCliCandidates derives cli.bat from a Windows install directory', () => {
  const candidates = getWechatCliCandidates('C:\\Program Files\\WeChatDevTools', 'win32');

  assert.deepEqual(candidates, [
    'C:\\Program Files\\WeChatDevTools\\cli.bat',
  ]);
});

test('getWechatCliCandidates prefers cli.bat sibling when given a Windows exe path', () => {
  const candidates = getWechatCliCandidates(
    'C:\\Program Files\\WeChatDevTools\\微信开发者工具.exe',
    'win32'
  );

  assert.deepEqual(candidates, [
    'C:\\Program Files\\WeChatDevTools\\cli.bat',
    'C:\\Program Files\\WeChatDevTools\\微信开发者工具.exe',
  ]);
});

test('getWechatCliCandidates supports app bundle and legacy cli locations on macOS', () => {
  const candidates = getWechatCliCandidates(
    '/Applications/wechatwebdevtools.app',
    'darwin'
  );

  assert.deepEqual(candidates, [
    '/Applications/wechatwebdevtools.app/Contents/MacOS/cli',
    '/Applications/wechatwebdevtools.app/Contents/Resources/app.nw/bin/cli',
  ]);
});

test('getWechatLaunchCandidates prefers launching the Windows app directly from an install directory', () => {
  const candidates = getWechatLaunchCandidates('C:\\Program Files\\WeChatDevTools', 'win32');

  assert.deepEqual(candidates, [
    'C:\\Program Files\\WeChatDevTools\\微信开发者工具.exe',
    'C:\\Program Files\\WeChatDevTools\\cli.bat',
  ]);
});

test('getWechatLaunchSpec uses open for macOS app bundles', () => {
  const spec = getWechatLaunchSpec('/Applications/wechatwebdevtools.app', 'darwin');

  assert.deepEqual(spec, {
    command: 'open',
    args: ['/Applications/wechatwebdevtools.app'],
  });
});

test('getWechatLaunchSpec wraps Windows bat launch in hidden cmd invocation', () => {
  const spec = getWechatLaunchSpec('C:\\Program Files\\WeChatDevTools\\cli.bat', 'win32');

  assert.deepEqual(spec, {
    command: 'cmd.exe',
    args: ['/d', '/s', '/c', '"C:\\Program Files\\WeChatDevTools\\cli.bat"'],
  });
});

test('resolveWechatLaunchSpec picks an existing Windows exe target', () => {
  const result = resolveWechatLaunchSpec(
    { windowsPath: 'C:\\Program Files\\WeChatDevTools' },
    'win32',
    (candidate) => candidate.endsWith('微信开发者工具.exe')
  );

  assert.equal(result.success, true);
  assert.deepEqual(result.launchSpec, {
    command: 'C:\\Program Files\\WeChatDevTools\\微信开发者工具.exe',
    args: [],
  });
});

test('resolveWechatLaunchSpec reports missing configured tool path clearly', () => {
  const result = resolveWechatLaunchSpec({}, 'win32');

  assert.deepEqual(result, {
    success: false,
    error: '请先在设置中配置 Windows 微信开发者工具路径',
    launchSpec: null,
    configuredPath: '',
    candidates: [],
  });
});
