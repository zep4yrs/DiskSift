// NEVER_TOUCH 段边界匹配回归用例（v26.1.2 高危修复 ④）。
// 直接 import TS 源（triage.ts 仅 erasable 语法 + import type，Node 24 原生
// strip-types 可执行）。跑法：pnpm -C apps/desktop test
import test from 'node:test';
import assert from 'node:assert/strict';
import { isNeverTouch, collectDirs } from '../src/triage.ts';

test('根级路径（无尾分隔符）命中——旧片段表 +/Windows/ 类尾分隔符匹配不到的形态', () => {
  assert.equal(isNeverTouch('C:\\Windows'), true);
  assert.equal(isNeverTouch('C:\\ProgramData'), true);
  assert.equal(isNeverTouch('C:\\Program Files'), true);
  assert.equal(isNeverTouch('C:\\Recovery'), true); // v26.1.2 补入清单
  assert.equal(isNeverTouch('C:\\Windows.old'), true); // v26.1.2 补入清单
  assert.equal(isNeverTouch('C:\\$Recycle.Bin'), true);
});

test('子路径与大小写/分隔符变体照常命中', () => {
  assert.equal(isNeverTouch('C:\\Windows\\Temp'), true);
  assert.equal(isNeverTouch('C:\\Users\\90740\\Documents'), true);
  assert.equal(isNeverTouch('C:\\Users\\90740\\Documents\\WeChat Files'), true);
  assert.equal(isNeverTouch('c:/users/u/documents/archive'), true); // 小写 + 正斜杠
  assert.equal(isNeverTouch('C:\\System Volume Information\\track'), true);
  assert.equal(isNeverTouch('C:\\Program Files (x86)\\X'), true);
});

test('段边界：前缀相像但整段不同不误命中（旧 /Program Files 子串误伤形态）', () => {
  assert.equal(isNeverTouch('C:\\WindowsExcl'), false);
  assert.equal(isNeverTouch('C:\\ProgramDataExcl'), false);
  assert.equal(isNeverTouch('C:\\Program Files Excl'), false);
  assert.equal(isNeverTouch('C:\\tools\\windows-cleaner\\cache'), false);
  assert.equal(isNeverTouch('C:\\cache\\reboot-helper'), false);
  assert.equal(isNeverTouch('D:\\DocumentsOld\\stuff'), false);
  assert.equal(isNeverTouch('D:\\mypics'), false); // 段 != pictures
});

test('普通用户缓存目录不命中（巡查可清面不收缩）', () => {
  assert.equal(isNeverTouch('C:\\Users\\90740\\AppData\\Local\\pip\\cache'), false);
  assert.equal(isNeverTouch('D:\\dev\\node_modules'), false);
});

// ── v26.1.2 下钻收集（triage-reach）────────────────────────────────────────

function dir(path, size, children = []) {
  const name = path.split(/[\\/]/).pop();
  return { name, path, is_dir: true, size, file_count: 0, children, top_extensions: [] };
}

test('阈值命中不再截断子树：C:\\Users 90GB 挡树的回归用例', () => {
  const pip = dir('C:\\Users\\u\\AppData\\Local\\pip', 200);
  const appdata = dir('C:\\Users\\u\\AppData', 400, [pip]);
  const users = dir('C:\\Users', 900, [appdata]);
  const root = dir('C:\\', 1000, [users, dir('C:\\Windows', 800)]);

  const out = collectDirs(root, 100);
  const paths = out.map((d) => d.node.path);
  // 深度 0 根不收；≥阈值 目录全部入列（父 + 子），不再 return 截断
  assert.deepEqual(paths.sort(), [
    'C:\\Users',
    'C:\\Users\\u\\AppData',
    'C:\\Users\\u\\AppData\\Local\\pip',
    'C:\\Windows',
  ]);
  // containedIn = 最近一个同样入列的祖先
  const byPath = new Map(out.map((d) => [d.node.path, d]));
  assert.equal(byPath.get('C:\\Users').containedIn, null);
  assert.equal(byPath.get('C:\\Users\\u\\AppData').containedIn, 'C:\\Users');
  assert.equal(byPath.get('C:\\Users\\u\\AppData\\Local\\pip').containedIn, 'C:\\Users\\u\\AppData');
  assert.equal(byPath.get('C:\\Windows').containedIn, null);
});

test('低于阈值的中间目录不断链（containedIn 取最近入列祖先）', () => {
  // users(900) > small(50) < 阈值 > pip(200)：small 不入列，pip 的
  // containedIn 越过 small 指向 users
  const pip = dir('C:\\Users\\u\\small\\pip', 200);
  const small = dir('C:\\Users\\u\\small', 50, [pip]);
  const users = dir('C:\\Users', 900, [small]);
  const root = dir('C:\\', 1000, [users]);

  const out = collectDirs(root, 100);
  assert.deepEqual(out.map((d) => d.node.path), ['C:\\Users', 'C:\\Users\\u\\small\\pip']);
  assert.equal(out[1].containedIn, 'C:\\Users');
});

test('深度上限统一 5：第 6 层不再收集', () => {
  let n = dir('C:\\L1', 900);
  for (const p of ['C:\\L1\\L2', 'C:\\L1\\L2\\L3', 'C:\\L1\\L2\\L3\\L4', 'C:\\L1\\L2\\L3\\L4\\L5', 'C:\\L1\\L2\\L3\\L4\\L5\\L6']) {
    n = dir(p, 900, [n]);
  }
  // 构造后 n = L6（外层），子链 L6→L5→L4→L3→L2→L1。root 下 L6=depth1，
  // 深度上限 5 → L1（depth 6）不入列，L2..L6 入列。
  const root = dir('C:\\', 1000, [n]);
  const paths = collectDirs(root, 100).map((d) => d.node.path);
  assert.equal(paths.includes('C:\\L1'), false);
  assert.equal(paths.includes('C:\\L1\\L2\\L3\\L4\\L5'), true);
  assert.equal(paths.includes('C:\\L1\\L2\\L3\\L4\\L5\\L6'), true);
});
