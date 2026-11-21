#!/usr/bin/env node
/**
 * 一键更新（抓取 + 构建 + 推送）
 *
 *   node scripts/update.mjs
 *
 * Token 读取顺序：
 *   1. 环境变量 GITHUB_TOKEN
 *   2. 同目录下的 token.txt（一行一个 token，已在 .gitignore 里排除）
 *
 * 为什么不用 GitHub Actions：官方接口 webapi.sporttery.cn 对海外 IP 返回
 * HTTP 567（CDN/WAF 拦截），Actions 的 runner 在美国，抓不到数据。
 * 所以更新必须在国内网络环境执行。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OWNER = 'xiaomayi1899';
const REPO = 'football-lab';

function token() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const p = resolve(ROOT, 'token.txt');
  if (existsSync(p)) return readFileSync(p, 'utf8').trim();
  return null;
}

async function gh(path, method = 'GET', body) {
  const res = await fetch('https://api.github.com' + path, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer ' + token(),
      'Content-Type': 'application/json',
      'User-Agent': 'football-lab'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error('GitHub ' + res.status + ': ' + (await res.text()).slice(0, 200));
  return res.json();
}

async function pushData() {
  const files = ['data/app.json', 'data/results.json', 'data/odds.json', 'data/validation.json', 'data/detail-500.json', 'data/djyy.json'];
  const ref = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/main`);
  const base = await gh(`/repos/${OWNER}/${REPO}/git/commits/${ref.object.sha}`);
  const tree = [];
  for (const f of files) {
    const content = readFileSync(resolve(ROOT, f));
    const blob = await gh(`/repos/${OWNER}/${REPO}/git/blobs`, 'POST', {
      content: content.toString('base64'),
      encoding: 'base64'
    });
    tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
    console.log('  上传', f, Math.round(content.length / 1024) + 'KB');
  }
  const newTree = await gh(`/repos/${OWNER}/${REPO}/git/trees`, 'POST', {
    base_tree: base.tree.sha,
    tree
  });
  const commit = await gh(`/repos/${OWNER}/${REPO}/git/commits`, 'POST', {
    message: 'chore(data): update ' + new Date().toISOString().slice(0, 16),
    tree: newTree.sha,
    parents: [ref.object.sha]
  });
  await gh(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, 'PATCH', { sha: commit.sha, force: true });
  console.log('已推送', commit.sha.slice(0, 8));
}

console.log('=== 1/3 抓取官方数据 ===');
execFileSync(process.execPath, [resolve(__dirname, 'fetch.mjs'), '--days=45'], { stdio: 'inherit', cwd: ROOT });

console.log('\n=== 2/3 生成前端数据 ===');
execFileSync(process.execPath, [resolve(__dirname, 'build.mjs')], { stdio: 'inherit', cwd: ROOT });

console.log('\n=== 3/3 推送到 GitHub ===');
if (!token()) {
  console.log('未找到 token（环境变量 GITHUB_TOKEN 或 token.txt），跳过推送。数据已在本地更新。');
} else {
  await pushData();
  console.log('完成。网站在 1–2 分钟后刷新到最新数据。');
}
