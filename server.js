const express = require('express');
const app = express();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { promisify } = require('util');
const sqlite3 = require('/var/www/auth.xianbao.online/node_modules/sqlite3');

const { verifyToken, extractToken } = require('/var/www/auth-verify.js');

const PORT = 3060;
const dbPath = path.join(__dirname, 'messages.db');
const AUTH_DB_PATH = path.join(__dirname, '..', 'auth.xianbao.online', 'database', 'auth.db');

app.use(express.json({ limit: '5mb' }));
app.use(require('cookie-parser')());
app.use(express.static(path.join(__dirname, 'frontend'), { maxAge: 0, etag: false }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

let rdb, rdbAll, rdbRun, rdbGet;

async function initDb() {
  rdb = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);
  rdbRun = promisify(rdb.run.bind(rdb));
  rdbAll = promisify(rdb.all.bind(rdb));
  rdbGet = promisify(rdb.get.bind(rdb));

  await rdbRun(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER,
    username TEXT, nickname TEXT, avatar_url TEXT,
    title TEXT NOT NULL, content TEXT NOT NULL, category TEXT DEFAULT 'question',
    reply_count INTEGER DEFAULT 0, like_count INTEGER DEFAULT 0,
    pinned INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await rdbRun(`CREATE TABLE IF NOT EXISTS replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER,
    user_id INTEGER, username TEXT, nickname TEXT, avatar_url TEXT,
    parent_id INTEGER DEFAULT NULL, content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await rdbRun(`CREATE TABLE IF NOT EXISTS likes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    UNIQUE(message_id, user_id)
  )`);

  try { await rdbRun("ATTACH DATABASE '" + AUTH_DB_PATH + "' AS auth"); }
  catch(e) { console.log('ATTACH failed:', e.message); }
}
async function getReqUser(req) {
  const t = extractToken(req);
  if (!t) return null;
  return verifyToken(t);
}

app.post('/api/messages', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  const user = u.user;
  const { title, content, category } = req.body;
  if (!title || !content) return res.json({ success: false, error: '标题和内容不能为空' });
  try {
    const result = await rdbRun('INSERT INTO messages (user_id, username, nickname, avatar_url, title, content, category) VALUES (?,?,?,?,?,?,?)',
      [user.id, user.username||'', user.nickname||user.username||'', user.avatar_url||'', title, content, category||'question']);
    const lastRow = await rdbGet('SELECT last_insert_rowid() as id');
    res.json({ success: true, id: lastRow ? lastRow.id : null });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/messages', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  const category = req.query.category;
  const mine = req.query.mine;
  const sort = req.query.sort === 'hot' ? 'm.reply_count DESC' : 'm.created_at DESC';

  let where = 'WHERE 1=1', params = [];
  if (category) { where += ' AND m.category = ?'; params.push(category); }
  if (mine === '1') {
    const u = await getReqUser(req);
    if (u && u.success) { where += ' AND m.user_id = ?'; params.push(u.user.id); }
  }

  try {
    const total = await rdbGet('SELECT COUNT(*) as c FROM messages m ' + where, params);
    const rows = await rdbAll('SELECT m.id, m.user_id, m.username, COALESCE(u.nickname,m.nickname) AS nickname, COALESCE(u.avatar_url,m.avatar_url) AS avatar_url, m.title, m.content, m.category, m.reply_count, m.like_count, m.pinned, m.created_at, m.updated_at FROM messages m LEFT JOIN auth.users u ON m.user_id=u.id ' + where + ' ORDER BY m.pinned DESC, ' + sort + ' LIMIT ? OFFSET ?', [...params, limit, offset]);
    res.json({ success: true, data: { messages: rows, total: total ? total.c : 0, page, limit } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/messages/search', async (req, res) => {
  const keyword = req.query.q || '';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const offset = (page - 1) * limit;
  if (!keyword) return res.json({ success: false, error: '请输入关键词' });

  try {
    const like = '%' + keyword + '%';    const total = await rdbGet('SELECT COUNT(*) as c FROM messages m WHERE m.title LIKE ? OR m.content LIKE ?', [like, like]);
    const rows = await rdbAll('SELECT m.id, m.user_id, m.username, COALESCE(u.nickname,m.nickname) AS nickname, COALESCE(u.avatar_url,m.avatar_url) AS avatar_url, m.title, m.content, m.category, m.reply_count, m.like_count, m.pinned, m.created_at, m.updated_at FROM messages m LEFT JOIN auth.users u ON m.user_id=u.id WHERE m.title LIKE ? OR m.content LIKE ? ORDER BY m.created_at DESC LIMIT ? OFFSET ?', [like, like, limit, offset]);
    res.json({ success: true, data: { messages: rows, total: total ? total.c : 0, page, limit } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.get('/api/messages/:id', async (req, res) => {
  try {
    const m = await rdbGet('SELECT m.id, m.user_id, m.username, COALESCE(u.nickname,m.nickname) AS nickname, COALESCE(u.avatar_url,m.avatar_url) AS avatar_url, m.title, m.content, m.category, m.reply_count, m.like_count, m.pinned, m.created_at, m.updated_at FROM messages m LEFT JOIN auth.users u ON m.user_id=u.id WHERE m.id = ?', [req.params.id]);
    if (!m) return res.json({ success: false, error: '不存在' });

    const u = await getReqUser(req);
    const liked = u && u.success ? !!(await rdbGet('SELECT id FROM likes WHERE message_id = ? AND user_id = ?', [req.params.id, u.user.id])) : false;

    var reps = []; try { reps = await rdbAll('SELECT r.id, r.user_id, r.username, COALESCE(u.nickname,r.nickname) AS nickname, COALESCE(u.avatar_url,r.avatar_url) AS avatar_url, r.parent_id, r.content, r.created_at FROM replies r LEFT JOIN auth.users u ON r.user_id=u.id WHERE r.message_id = ? ORDER BY r.created_at', [req.params.id]); } catch(e) { console.log("REPLY_QUERY_ERROR:", e.message); reps = []; }

    res.json({ success: true, data: { message: m, replies: reps } });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages/:id/reply', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  const user = u.user;
  const { content } = req.body;
  if (!content) return res.json({ success: false, error: '请输入内容' });
  try {
    await rdbRun('INSERT INTO replies (message_id, user_id, username, nickname, avatar_url, parent_id, content) VALUES (?,?,?,?,?,?,?)',
      [req.params.id, user.id, user.username||'', user.nickname||user.username||'', user.avatar_url||'', null, content]);
    await rdbRun('UPDATE messages SET reply_count = reply_count + 1 WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages/:id/like', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  try {
    const existing = await rdbGet('SELECT id FROM likes WHERE message_id = ? AND user_id = ?', [req.params.id, u.user.id]);
    if (existing) {
      await rdbRun('DELETE FROM likes WHERE message_id = ? AND user_id = ?', [req.params.id, u.user.id]);
      await rdbRun('UPDATE messages SET like_count = MAX(0, like_count - 1) WHERE id = ?', [req.params.id]);
      const cnt = await rdbGet('SELECT like_count FROM messages WHERE id = ?', [req.params.id]);
      res.json({ success: true, liked: false, like_count: cnt ? cnt.like_count : 0 });
    } else {
      await rdbRun('INSERT INTO likes (message_id, user_id) VALUES (?,?)', [req.params.id, u.user.id]);
      await rdbRun('UPDATE messages SET like_count = like_count + 1 WHERE id = ?', [req.params.id]);
      const cnt = await rdbGet('SELECT like_count FROM messages WHERE id = ?', [req.params.id]);
      res.json({ success: true, liked: true, like_count: cnt ? cnt.like_count : 0 });
    }  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/messages/:id/pin', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  if (u.user.role !== 'admin') return res.json({ success: false, error: '仅管理员可操作' });
  try {
    const msg = await rdbGet('SELECT pinned FROM messages WHERE id = ?', [req.params.id]);
    if (!msg) return res.json({ success: false, error: '不存在' });
    var newPinned = msg.pinned ? 0 : 1;
    await rdbRun('UPDATE messages SET pinned = ? WHERE id = ?', [newPinned, req.params.id]);
    res.json({ success: true, pinned: newPinned === 1 });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.delete('/api/messages/:id', async (req, res) => {
  const u = await getReqUser(req);
  if (!u || !u.success) return res.json({ success: false, error: 'need_login' });
  try {
    const msg = await rdbGet('SELECT user_id FROM messages WHERE id = ?', [req.params.id]);
    if (!msg) return res.json({ success: false, error: '不存在' });
    if (msg.user_id !== u.user.id && u.user.role !== 'admin') return res.json({ success: false, error: '无权删除' });
    await rdbRun('DELETE FROM messages WHERE id = ?', [req.params.id]);
    await rdbRun('DELETE FROM replies WHERE message_id = ?', [req.params.id]);
    await rdbRun('DELETE FROM likes WHERE message_id = ?', [req.params.id]);
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

initDb().then(() => app.listen(PORT, () => console.log('messages on :' + PORT)));
