// Bill Split server: no npm packages needed (Node 18+). Talks to Neon over HTTPS.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
try { for (const l of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
  const m = l.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
} } catch {}
const DB = process.env.DATABASE_URL, PORT = process.env.PORT || 3000;
const rid = p => p + crypto.randomBytes(5).toString('hex');
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(6), b => ALPHA[b % 32]).join('');

function neon() {
  const host = new URL(DB).host;
  const sql = async (query, params = []) => {
    const r = await fetch(`https://${host}/sql`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': DB },
      body: JSON.stringify({ query, params }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || 'Database error');
    return j.rows || [];
  };
  const ready = (async () => {
    await sql('create table if not exists groups(code text primary key, created_at timestamptz default now())');
    await sql('create table if not exists members(id text primary key, code text not null, name text, emoji text, color text, created_at timestamptz default now())');
    await sql('create table if not exists expenses(id text primary key, code text not null, kind text not null, title text, cents integer not null, payer text, split text, from_id text, to_id text, created_at timestamptz default now())');
  })();
  const w = f => async (...a) => { await ready; return f(...a); };
  return {
    hasGroup: w(async c => (await sql('select 1 from groups where code=$1', [c])).length > 0),
    createGroup: w(c => sql('insert into groups(code) values($1)', [c])),
    members: w(c => sql('select id,name,emoji,color from members where code=$1 order by created_at', [c])),
    addMember: w(m => sql('insert into members(id,code,name,emoji,color) values($1,$2,$3,$4,$5)', [m.id, m.code, m.name, m.emoji, m.color])),
    updMember: w((id, c, f) => sql('update members set name=$3,emoji=$4,color=$5 where id=$1 and code=$2', [id, c, f.name, f.emoji, f.color])),
    delMember: w((id, c) => sql('delete from members where id=$1 and code=$2', [id, c])),
    expenses: w(c => sql('select * from expenses where code=$1 order by created_at', [c])),
    addExpense: w(e => sql('insert into expenses(id,code,kind,title,cents,payer,split,from_id,to_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [e.id, e.code, e.kind, e.title, e.cents, e.payer, e.split, e.from_id, e.to_id])),
    delExpense: w((id, c) => sql('delete from expenses where id=$1 and code=$2', [id, c])),
    memberUsed: w(async (id, c) => (await sql("select 1 from expenses where code=$1 and (payer=$2 or from_id=$2 or to_id=$2 or (','||coalesce(split,'')||',') like $3) limit 1", [c, id, '%,' + id + ',%'])).length > 0),
  };
}
function memory() { // used when DATABASE_URL is empty (local testing only)
  const G = new Set(), M = [], E = [];
  return {
    hasGroup: async c => G.has(c), createGroup: async c => { G.add(c); },
    members: async c => M.filter(m => m.code === c).map(({ id, name, emoji, color }) => ({ id, name, emoji, color })),
    addMember: async m => { M.push(m); },
    updMember: async (id, c, f) => { const m = M.find(x => x.id === id && x.code === c); if (m) Object.assign(m, f); },
    delMember: async (id, c) => { const i = M.findIndex(x => x.id === id && x.code === c); if (i >= 0) M.splice(i, 1); },
    expenses: async c => E.filter(e => e.code === c),
    addExpense: async e => { E.push(e); },
    delExpense: async (id, c) => { const i = E.findIndex(x => x.id === id && x.code === c); if (i >= 0) E.splice(i, 1); },
    memberUsed: async (id, c) => E.some(e => e.code === c && (e.payer === id || e.from_id === id || e.to_id === id || (e.split || '').split(',').includes(id))),
  };
}
const S = DB ? neon() : memory();
console.log(DB ? 'Using Neon database' : 'No DATABASE_URL: using in-memory store (data is lost on restart)');

const toItem = r => r.kind === 'pay'
  ? { id: r.id, pay: 1, from: r.from_id, to: r.to_id, amt: r.cents }
  : { id: r.id, title: r.title, amt: r.cents / 100, payer: r.payer, split: (r.split || '').split(',').filter(Boolean) };
const send = (res, c, o) => { res.writeHead(c, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const readBody = req => new Promise(ok => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e5) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(d || '{}')); } catch { ok({}); } }); });
const clean = (s, n) => String(s || '').trim().slice(0, n);
const color = c => /^#[0-9a-f]{6}$/i.test(c) ? c : '#7B4DFF';

http.createServer(async (req, res) => {
  try {
    const p = new URL(req.url, 'http://x').pathname.split('/').filter(Boolean), m = req.method;
    if (p[0] !== 'api') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(__dirname, 'public', 'index.html')));
    }
    if (m === 'POST' && p[1] === 'groups') {
      let c; do { c = newCode(); } while (await S.hasGroup(c));
      await S.createGroup(c); return send(res, 200, { code: c });
    }
    if (p[1] !== 'g' || !p[2]) return send(res, 404, { error: 'Not found' });
    const code = p[2].toUpperCase(), sub = p[3], id = p[4];
    if (!(await S.hasGroup(code))) return send(res, 404, { error: 'Group not found' });
    if (m === 'GET' && !sub) return send(res, 200, { members: await S.members(code), items: (await S.expenses(code)).map(toItem) });
    const members = await S.members(code), has = x => members.some(y => y.id === x);
    if (sub === 'members') {
      if (m === 'POST' || (m === 'PATCH' && id)) {
        const b = await readBody(req), name = clean(b.name, 16);
        if (!name) return send(res, 400, { error: 'Name is required' });
        const f = { name, emoji: clean(b.emoji, 8) || '🙂', color: color(b.color) };
        if (m === 'PATCH') { await S.updMember(id, code, f); return send(res, 200, { id, ...f }); }
        if (members.length >= 30) return send(res, 400, { error: 'Group is full' });
        const mem = { id: rid('m'), code, ...f }; await S.addMember(mem);
        return send(res, 200, { id: mem.id, ...f });
      }
      if (m === 'DELETE' && id) {
        if (await S.memberUsed(id, code)) return send(res, 400, { error: 'Already in an expense' });
        await S.delMember(id, code); return send(res, 200, { ok: 1 });
      }
    }
    if (sub === 'expenses') {
      if (m === 'DELETE' && id) { await S.delExpense(id, code); return send(res, 200, { ok: 1 }); }
      if (m === 'POST') {
        const b = await readBody(req), cents = Math.round(Number(b.amt) * 100);
        if (!(cents > 0 && cents < 1e9)) return send(res, 400, { error: 'Enter a valid amount' });
        const e = { id: rid('e'), code, kind: b.kind === 'pay' ? 'pay' : 'expense', cents, title: null, payer: null, split: null, from_id: null, to_id: null };
        if (e.kind === 'pay') {
          if (!has(b.from) || !has(b.to)) return send(res, 400, { error: 'Unknown member' });
          e.from_id = b.from; e.to_id = b.to;
        } else {
          const split = (Array.isArray(b.split) ? b.split : []).filter(has);
          e.title = clean(b.title, 30);
          if (!e.title || !has(b.payer) || !split.length) return send(res, 400, { error: 'Add a title, payer and people to split with' });
          e.payer = b.payer; e.split = split.join(',');
        }
        await S.addExpense(e); return send(res, 200, toItem(e));
      }
    }
    send(res, 404, { error: 'Not found' });
  } catch (err) { console.error(err); send(res, 500, { error: 'Server error' }); }
}).listen(PORT, () => console.log('Bill Split running on http://localhost:' + PORT));
