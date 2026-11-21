#!/usr/bin/env node
/**
 * 抓取 DJYY（djyylive.com）真实伤停与 xG
 *
 *   node scripts/fetch-djyy.mjs [--days=2]
 *
 * 来源：https://djyylive.com（第三方，Cloudflare 托管，国内可直连）
 *   /api/leagues/fixtures   赛程 + xG + 比分
 *   /api/match/{id}/info    教练 / 伤停 / 裁判 / 天气 / 场地
 *
 * 输出 data/djyy.json，键为「日期|主队|客队」，与官方全称一致即可匹配。
 *
 * 注意：DJYY 对 GitHub Actions 的海外 IP 返回 403，所以必须在本地网络运行。
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const BASE = 'https://djyylive.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const args = process.argv.slice(2);
const arg = (n, d) => {
  const h = args.find((a) => a.startsWith('--' + n + '='));
  return h ? Number(h.split('=')[1]) : d;
};
const DAYS = arg('days', 2);

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function getJson(path, retries = 3) {
  let last;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(BASE + path, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 600 * (i + 1)));
    }
  }
  throw last;
}

const from = ymd(new Date());
const to = ymd(new Date(Date.now() + (DAYS - 1) * 86400000));

console.log(`抓取 DJYY 赛程 ${from} ~ ${to}…`);
const fixtures = await getJson(`/api/leagues/fixtures?date_from=${from}&date_to=${to}`);
console.log(`赛程 ${fixtures.length} 场`);

const out = { updatedAt: new Date().toISOString(), matches: {} };
let done = 0;

for (const f of fixtures) {
  const date = String(f.starting_at || '').slice(0, 10);
  const home = f.home && f.home.name_zh;
  const away = f.away && f.away.name_zh;
  if (!date || !home || !away) continue;

  let info = null;
  try {
    info = await getJson(`/api/match/${f.id}/info`);
  } catch (e) {
    /* 伤停接口失败不影响赛程 */
  }

  const pack = (side) => {
    const s = info && info[side];
    if (!s) return { sidelined: [], coach: null };
    return {
      coach: s.coach ? { name: s.coach.name_zh || s.coach.name, winPct: s.coach.record ? s.coach.record.win_pct : null } : null,
      sidelined: (s.sidelined || []).map((p) => ({
        player: p.player_zh || p.player,
        reason: p.reason_zh || p.reason,
        category: p.category,
        since: p.since,
        until: p.until,
        missed: p.games_missed || 0
      }))
    };
  };

  out.matches[`${date}|${home}|${away}`] = {
    fixtureId: f.id,
    date,
    start: f.starting_at,
    league: f.league ? f.league.name_zh : '',
    home,
    away,
    state: f.state,
    score: f.score || null,
    xg: f.xg || null,
    available: info ? info.available !== false : false,
    homeInfo: pack('home'),
    awayInfo: pack('away'),
    weather: info && info.weather ? info.weather : null,
    referees: info && info.referees ? info.referees : null
  };

  done++;
  if (done % 8 === 0) console.log(`  已处理 ${done}/${fixtures.length}…`);
  await new Promise((r) => setTimeout(r, 120));
}

writeFileSync(resolve(ROOT, 'data/djyy.json'), JSON.stringify(out), 'utf8');
const withInjury = Object.values(out.matches).filter((m) =>
  (m.homeInfo.sidelined.length + m.awayInfo.sidelined.length) > 0).length;
const withXg = Object.values(out.matches).filter((m) => m.xg).length;
console.log(`\n写入 data/djyy.json`);
console.log(`  场次 ${Object.keys(out.matches).length}`);
console.log(`  有伤停名单 ${withInjury}`);
console.log(`  有 xG 数据 ${withXg}`);
