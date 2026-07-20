require('dotenv').config({ path: '/var/www/.env' });
const express = require('express');
const path = require('path');
const fs = require('fs');
const cookieParser = require('cookie-parser');
const { verifyToken, extractToken } = require('/var/www/auth-verify');
const app = express();
const PORT = process.env.MESSAGE_PORT || 3060;
const initSqlJs = require('sql.js');
const dbPath = path.join(__dirname, 'messages.db');
let db = null;

async function initDb() {
  const SQL = await initSqlJs();
  try { const buf = fs.readFileSync(dbPath); db = new SQL.Database(buf); }
  catch { db = new SQL.Database(); }
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, username TEXT DEFAULT '', nickname TEXT DEFAULT '', avatar_url TEXT DEFAULT '', title TEXT DEFAULT '', content TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'question', reply_count INTEGER DEFAULT 0, created_at DATETIME DEFAULT (datetime('now','localtime')), updated_at DATETIME DEFAULT (datetime('now','localtime')))");
  db.run("CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT DEFAULT '', nickname TEXT DEFAULT '', avatar_url TEXT DEFAULT '', parent_id INTEGER DEFAULT NULL, content TEXT NOT NULL, created_at DATETIME DEFAULT (datetime('now','localtime')))");
  db.run("CREATE INDEX IF NOT EXISTS idx_messages_cat ON messages(category)");
  db.run("CREATE INDEX IF NOT EXISTS idx_replies_msg ON replies(message_id)");
  saveDb(); console.log('DB ready');
}
function saveDb() { const data = db.export(); fs.writeFileSync(dbPath, Buffer.from(data)); }

app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'frontend')));

function getReqUser(req) {
  const t = extractToken(req);
  if (!t) return null;
  return verifyToken(t);
}

app.get('/api/messages', (req, res) => {
  const category = req.query.category || '';
  const sort = req.query.sort === 'hot' ? 'reply_count DESC' : 'created_at DESC';
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, parseInt(req.query.limit) || 20);
  const offset = (page - 1) * limit;
  let where = ''; const params = [];
  if (category && ['question','reflection'].includes(category)) { where = 'WHERE category = ?'; params.push(category); }
  try {
    const total = db.exec('SELECT COUNT(*) as c FROM messages ' + where, params)[0];
    const rows = db.exec('SELECT id, user_id, username, nickname, avatar_url, title, content, category, reply_count, created_at FROM messages ' + where + ' ORDER BY ' + sort + ' LIMIT ? OFFSET ?', params.concat([limit, offset]));
    const messages = rows && rows[0] ? rows[0].values.map(r => ({ id: r[0], user_id: r[1], username: r[2], nickname: r[3], avatar_url: r[4], title: r[5], content: (r[6]||'').substring(0,200), category: r[7], reply_count: r[8], created_at: r[9] })) : [];
    res.json({ success: true, data: { messages, total: total ? total.values[0][0] : 0, page, limit } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  const user = u.user; const { title, content, category } = req.body;
  if (!content || content.length < 2) return res.json({ success: false, error: '内容至少2字' });
  if (!['question','reflection'].includes(category)) return res.json({ success: false, error: '分类无效' });
  try {
    db.run('INSERT INTO messages (user_id, username, nickname, avatar_url, title, content, category) VALUES (?,?,?,?,?,?,?)',
      [user.id, user.username||'', user.nickname||user.username||'', user.avatar_url||'', title||'', content, category]);
    saveDb(); res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/messages/:id', (req, res) => {
  try {
    const msg = db.exec('SELECT id, user_id, username, nickname, avatar_url, title, content, category, reply_count, created_at FROM messages WHERE id = ?', [req.params.id]);
    if (!msg || !msg[0]) return res.json({ success: false, error: '不存在' });
    const m = msg[0].values[0];
    const message = { id: m[0], user_id: m[1], username: m[2], nickname: m[3], avatar_url: m[4], title: m[5], content: m[6], category: m[7], reply_count: m[8], created_at: m[9] };
    const reps = db.exec('SELECT id, user_id, username, nickname, avatar_url, parent_id, content, created_at FROM replies WHERE message_id = ? ORDER BY created_at ASC', [req.params.id]);
    const replies = reps && reps[0] ? reps[0].values.map(r => ({ id: r[0], user_id: r[1], username: r[2], nickname: r[3], avatar_url: r[4], parent_id: r[5], content: r[6], created_at: r[7] })) : [];
    res.json({ success: true, data: { message, replies } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages/:id/reply', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  const user = u.user; const { content } = req.body;
  if (!content) return res.json({ success: false, error: '请输入内容' });
  try {
    db.run('INSERT INTO replies (message_id, user_id, username, nickname, avatar_url, parent_id, content) VALUES (?,?,?,?,?,?,?)',
      [req.params.id, user.id, user.username||'', user.nickname||user.username||'', user.avatar_url||'', null, content]);
    db.run('UPDATE messages SET reply_count = reply_count + 1 WHERE id = ?', [req.params.id]);
    saveDb(); res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/messages/:id', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  try {
    const msg = db.exec('SELECT user_id FROM messages WHERE id = ?', [req.params.id]);
    if (!msg || !msg[0]) return res.json({ success: false, error: '不存在' });
    if (msg[0].values[0][0] !== u.user.id) return res.json({ success: false, error: '无权删除' });
    db.run('DELETE FROM messages WHERE id = ?', [req.params.id]);
    db.run('DELETE FROM replies WHERE message_id = ?', [req.params.id]);
    saveDb(); res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

initDb().then(() => app.listen(PORT, () => console.log('messages on :' + PORT)));
