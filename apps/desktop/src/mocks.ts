import type { Node, Scaffold, AdvisorRequest, AdvisorResponse, UndoEntry, Plan } from './types';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function leaf(name: string, path: string, size: number, files: number, scaffold_id: string | null = null): Node {
  return {
    name,
    path,
    is_dir: true,
    size,
    file_count: files,
    children: [],
    scaffold_id,
    top_extensions: [],
  };
}

const MOCK_TREE: Node = {
  name: 'C:',
  path: 'C:\\',
  is_dir: true,
  size: 187.1 * GB,
  file_count: 805_990,
  scaffold_id: null,
  top_extensions: [
    { ext: '.dll', bytes: 48.6 * GB, count: 56_729 },
    { ext: '(none)', bytes: 37.5 * GB, count: 165_172 },
    { ext: '.exe', bytes: 16.6 * GB, count: 6_644 },
    { ext: '.db', bytes: 6.4 * GB, count: 1_473 },
  ],
  children: [
    {
      name: 'Users', path: 'C:\\Users', is_dir: true, size: 90 * GB, file_count: 480_730,
      scaffold_id: null, top_extensions: [],
      children: [
        {
          name: 'demo-user', path: 'C:\\Users\\demo-user', is_dir: true, size: 90.3 * GB, file_count: 478_120,
          scaffold_id: null, top_extensions: [],
          children: [
            {
              name: 'AppData', path: 'C:\\Users\\demo-user\\AppData', is_dir: true, size: 71.1 * GB, file_count: 410_220,
              scaffold_id: null, top_extensions: [],
              children: [
                {
                  name: 'Local', path: 'C:\\Users\\demo-user\\AppData\\Local', is_dir: true, size: 51 * GB, file_count: 280_110,
                  scaffold_id: null, top_extensions: [],
                  children: [
                    leaf('Microsoft', 'C:\\Users\\demo-user\\AppData\\Local\\Microsoft', 14.8 * GB, 88_400, null),
                    {
                      name: 'Microsoft', path: 'C:\\Users\\demo-user\\AppData\\Local\\Microsoft\\Edge', is_dir: true,
                      size: 12.8 * GB, file_count: 41_320, scaffold_id: 'edge',
                      top_extensions: [{ ext: '(none)', bytes: 6 * GB, count: 12_000 }],
                      children: [
                        leaf('User Data', 'C:\\Users\\demo-user\\AppData\\Local\\Microsoft\\Edge\\User Data', 12.5 * GB, 40_900, 'edge'),
                      ],
                    },
                    {
                      name: 'Google', path: 'C:\\Users\\demo-user\\AppData\\Local\\Google', is_dir: true,
                      size: 6.4 * GB, file_count: 22_100, scaffold_id: 'chrome',
                      top_extensions: [], children: [
                        leaf('Chrome', 'C:\\Users\\demo-user\\AppData\\Local\\Google\\Chrome', 6.4 * GB, 22_100, 'chrome'),
                      ],
                    },
                    leaf('npm-cache', 'C:\\Users\\demo-user\\AppData\\Local\\npm-cache', 1.8 * GB, 8_400, 'npm'),
                    leaf('pnpm', 'C:\\Users\\demo-user\\AppData\\Local\\pnpm', 4.2 * GB, 15_200, 'pnpm'),
                    leaf('pip', 'C:\\Users\\demo-user\\AppData\\Local\\pip', 2.1 * GB, 5_300, 'pip'),
                    leaf('JetBrains', 'C:\\Users\\demo-user\\AppData\\Local\\JetBrains', 3.6 * GB, 88_900, 'jetbrains'),
                    leaf('Docker', 'C:\\Users\\demo-user\\AppData\\Local\\Docker', 5.2 * GB, 1_200, 'docker'),
                  ],
                },
                {
                  name: 'Roaming', path: 'C:\\Users\\demo-user\\AppData\\Roaming', is_dir: true, size: 17.7 * GB, file_count: 95_400,
                  scaffold_id: null, top_extensions: [], children: [
                    leaf('Tencent', 'C:\\Users\\demo-user\\AppData\\Roaming\\Tencent', 2.3 * GB, 4_100, null),
                  ],
                },
                leaf('LocalLow', 'C:\\Users\\demo-user\\AppData\\LocalLow', 2.1 * GB, 12_900, null),
              ],
            },
            {
              name: 'Documents', path: 'C:\\Users\\demo-user\\Documents', is_dir: true, size: 12.1 * GB, file_count: 18_400,
              scaffold_id: null, top_extensions: [],
              children: [
                {
                  name: 'WeChat Files', path: 'C:\\Users\\demo-user\\Documents\\WeChat Files', is_dir: true,
                  size: 11.4 * GB, file_count: 17_220, scaffold_id: 'wechat-pc',
                  top_extensions: [
                    { ext: '.dat', bytes: 6.8 * GB, count: 12_400 },
                    { ext: '.jpg', bytes: 2.1 * GB, count: 3_100 },
                    { ext: '.mp4', bytes: 1.6 * GB, count: 420 },
                  ],
                  children: [
                    leaf('wxid_gmsp9xjx12', 'C:\\Users\\demo-user\\Documents\\WeChat Files\\wxid_gmsp9xjx12', 10.7 * GB, 16_800, 'wechat-pc'),
                  ],
                },
              ],
            },
            leaf('.cargo', 'C:\\Users\\demo-user\\.cargo', 0.8 * GB, 12_400, 'cargo'),
            leaf('.cache/huggingface', 'C:\\Users\\demo-user\\.cache\\huggingface', 4.6 * GB, 320, 'huggingface'),
          ],
        },
      ],
    },
    {
      name: 'Windows', path: 'C:\\Windows', is_dir: true, size: 36.2 * GB, file_count: 169_900,
      scaffold_id: null, top_extensions: [],
      children: [
        leaf('System32', 'C:\\Windows\\System32', 8.2 * GB, 32_400),
        leaf('WinSxS', 'C:\\Windows\\WinSxS', 7.7 * GB, 48_200),
      ],
    },
    {
      name: 'Program Files', path: 'C:\\Program Files', is_dir: true, size: 24.5 * GB, file_count: 94_900,
      scaffold_id: null, top_extensions: [], children: [
        leaf('WindowsApps', 'C:\\Program Files\\WindowsApps', 9.5 * GB, 31_200),
        leaf('Steam', 'C:\\Program Files\\Steam', 4.8 * GB, 21_000, 'steam'),
      ],
    },
    leaf('Program Files (x86)', 'C:\\Program Files (x86)', 17.4 * GB, 22_000),
    leaf('ProgramData', 'C:\\ProgramData', 9.7 * GB, 31_160),
    leaf('Recovery', 'C:\\Recovery', 3.7 * GB, 48),
    leaf('Eastmoney', 'C:\\Eastmoney', 1.1 * GB, 4_280),
    leaf('System Volume Information', 'C:\\System Volume Information', 0.96 * GB, 27),
    leaf('Microsoft VS Code', 'C:\\Microsoft VS Code', 0.43 * GB, 2_410),
  ],
};

export const SCAFFOLDS: Scaffold[] = [
  {
    id: 'wechat-pc', name: 'WeChat (PC)', risk: 'low',
    disclaimer: '只动 FileStorage 媒体缓存。聊天记录保留，但已删的图片视频在旧聊天里会显示缺失。',
    detect: ['**/WeChat Files/*/FileStorage'],
    match: { name_contains: ['WeChat Files'], must_have_child: ['FileStorage'] },
    scopes: [
      { id: 'image-cache', label: '图片缓存（FileStorage/Image）', glob: '**/Image/**', mode: 'recycle', prompt: { kind: 'days', default: 30, label: '删除多少天前的图片' } },
      { id: 'video-cache', label: '视频缓存（FileStorage/Video）', glob: '**/Video/**', mode: 'recycle', prompt: { kind: 'days', default: 7, label: '删除多少天前的视频' } },
      { id: 'file-cache',  label: '接收的文件（FileStorage/File）', glob: '**/File/**',  mode: 'recycle', prompt: { kind: 'days', default: 30, label: '删除多少天前的文件' } },
    ],
  },
  {
    id: 'edge', name: 'Microsoft Edge', risk: 'low',
    disclaimer: '只清浏览器缓存，书签、密码、历史记录保留。可能要重新登录某些网站。',
    detect: ['**/Microsoft/Edge/User Data'], match: {},
    scopes: [
      { id: 'http-cache', label: 'HTTP 缓存', glob: '**/Cache/**', mode: 'recycle' },
      { id: 'code-cache', label: 'JS 字节码缓存', glob: '**/Code Cache/**', mode: 'recycle' },
      { id: 'gpu-cache',  label: 'GPU 着色器缓存', glob: '**/GPUCache/**', mode: 'recycle' },
    ],
  },
  {
    id: 'chrome', name: 'Google Chrome', risk: 'low',
    disclaimer: '只清浏览器缓存。',
    detect: ['**/Google/Chrome/User Data'], match: {},
    scopes: [
      { id: 'http-cache', label: 'HTTP 缓存', glob: '**/Cache/**', mode: 'recycle' },
      { id: 'code-cache', label: 'JS 字节码缓存', glob: '**/Code Cache/**', mode: 'recycle' },
    ],
  },
  {
    id: 'npm', name: 'npm cache', risk: 'low',
    disclaimer: 'npm 下次安装会重新下载。',
    detect: ['**/npm-cache'], match: {},
    scopes: [{ id: 'all', label: '所有缓存包', glob: '**/*', mode: 'recycle' }],
  },
  {
    id: 'pnpm', name: 'pnpm store', risk: 'low',
    disclaimer: 'pnpm 下次安装会重新建仓。',
    detect: ['**/pnpm/store'], match: {},
    scopes: [{ id: 'store', label: 'CAS 存储', glob: '**/store/**', mode: 'recycle' }],
  },
  {
    id: 'pip', name: 'pip cache', risk: 'low',
    disclaimer: '等同于 pip cache purge。',
    detect: ['**/pip/cache'], match: {},
    scopes: [
      { id: 'http', label: 'HTTP 缓存', glob: '**/http/**', mode: 'recycle' },
      { id: 'wheels', label: '已构建的 wheel', glob: '**/wheels/**', mode: 'recycle' },
    ],
  },
  {
    id: 'jetbrains', name: 'JetBrains IDEs', risk: 'low',
    disclaimer: '清 caches/logs/system，配置保留。下次启动会重建索引。',
    detect: ['**/JetBrains'], match: {},
    scopes: [
      { id: 'caches', label: 'Caches', glob: '**/caches/**', mode: 'recycle' },
      { id: 'logs',   label: 'Logs',   glob: '**/log/**',    mode: 'recycle' },
    ],
  },
  {
    id: 'docker', name: 'Docker / Docker Desktop', risk: 'high',
    disclaimer: '建议先用 docker system prune，不要直接删 vhdx。',
    detect: ['**/Docker'], match: {},
    scopes: [{ id: 'buildx', label: 'buildx 缓存', glob: '**/buildx/**', mode: 'recycle' }],
  },
  {
    id: 'cargo', name: 'Cargo cache', risk: 'medium',
    disclaimer: '不动 ~/.cargo/bin。Cargo 下次构建会重下载。',
    detect: ['**/.cargo'], match: {},
    scopes: [
      { id: 'registry-cache', label: 'registry/cache', glob: '**/registry/cache/**', mode: 'recycle' },
      { id: 'registry-src',   label: 'registry/src',   glob: '**/registry/src/**',   mode: 'recycle' },
    ],
  },
  {
    id: 'huggingface', name: 'Hugging Face Hub cache', risk: 'medium',
    disclaimer: '是已下载的模型权重，删了重下可能很费流量。',
    detect: ['**/huggingface'], match: {},
    scopes: [{ id: 'hub', label: '模型/数据集缓存', glob: '**/hub/**', mode: 'recycle' }],
  },
  {
    id: 'steam', name: 'Steam', risk: 'medium',
    disclaimer: '只清下载/着色器/创意工坊临时文件，游戏和存档不动。',
    detect: ['**/Steam'], match: {},
    scopes: [
      { id: 'shadercache', label: 'Shader cache', glob: '**/shadercache/**', mode: 'recycle' },
      { id: 'downloading', label: '下载中临时', glob: '**/downloading/**', mode: 'recycle' },
    ],
  },
];

export async function scan(_path: string): Promise<Node> {
  await wait(800);
  return JSON.parse(JSON.stringify(MOCK_TREE));
}

export async function detectScaffold(path: string): Promise<string | null> {
  const p = path.toLowerCase();
  for (const s of SCAFFOLDS) {
    for (const d of s.detect) {
      const frag = d.replace(/\*\*?\//g, '').replace(/\\/g, '/').toLowerCase();
      if (p.replace(/\\/g, '/').includes(frag)) return s.id;
    }
  }
  return null;
}

export async function inspect(path: string, n: number): Promise<string[]> {
  await wait(150);
  const lower = path.toLowerCase();
  if (lower.includes('edge')) {
    return [
      `${path}\\Default\\Cache\\Cache_Data\\f_001234`,
      `${path}\\Default\\Cache\\Cache_Data\\f_005a2b`,
      `${path}\\Default\\Code Cache\\js\\index-DHc9.bin`,
      `${path}\\Default\\GPUCache\\data_3`,
      `${path}\\Default\\Service Worker\\CacheStorage\\...`,
    ].slice(0, n);
  }
  if (lower.includes('huggingface')) {
    return [
      `${path}\\hub\\models--meta-llama--Llama-3.1-8B-Instruct\\blobs\\...`,
      `${path}\\hub\\models--openai--clip-vit-base-patch32\\snapshots\\...`,
    ].slice(0, n);
  }
  return Array.from({ length: Math.min(n, 12) }, (_, i) => `${path}\\sample_${i + 1}.bin`);
}

export async function advise(req: AdvisorRequest): Promise<AdvisorResponse> {
  await wait(900);
  const p = req.path.toLowerCase();
  if (p.includes('windows\\winsxs')) {
    return { what: 'Windows 组件存储（WinSxS）', category: 'system', safe_to_delete: false, risk: 'high', action: 'keep', reasoning: '系统更新需要的硬链接库；不要直接删，用 dism 清理。', needs_inspection: false };
  }
  if (p.includes('windows')) {
    return { what: 'Windows 系统目录', category: 'system', safe_to_delete: false, risk: 'high', action: 'keep', reasoning: '系统核心，绝对不要删。', needs_inspection: false };
  }
  if (p.includes('program files')) {
    return { what: '已安装应用程序', category: 'app_cache', safe_to_delete: false, risk: 'high', action: 'keep', reasoning: '应该用控制面板卸载，不要直接删整个文件夹。', needs_inspection: false };
  }
  if (p.includes('recovery')) {
    return { what: 'Windows 恢复分区数据', category: 'system', safe_to_delete: false, risk: 'high', action: 'keep', reasoning: '出问题时用来重置系统的，留着。', needs_inspection: false };
  }
  if (p.includes('eastmoney')) {
    return { what: '东方财富 Choice 数据', category: 'app_cache', safe_to_delete: true, risk: 'medium', action: 'recycle', reasoning: '看起来是金融客户端的本地数据库；如果你不再用 Choice 终端可清，否则保留。', needs_inspection: true };
  }
  if (p.includes('localllow')) {
    return { what: '低权限 App 数据', category: 'app_cache', safe_to_delete: true, risk: 'low', action: 'recycle', reasoning: '通常是 Edge/IE 沙盒数据，可清。', needs_inspection: false };
  }
  return { what: '未识别的目录', category: 'unknown', safe_to_delete: false, risk: 'medium', action: 'keep', reasoning: '没有特征匹配；建议保留或手工查看。', needs_inspection: true };
}

export async function execute(plan: Plan, _dryRun: boolean): Promise<UndoEntry[]> {
  await wait(400);
  return plan.paths.map((src) => ({
    timestamp: new Date().toISOString(),
    action: plan.action,
    source: src,
    destination: plan.action === 'quarantine' ? `${src} → quarantine` : null,
    reason: plan.reason,
  }));
}

function wait(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }
