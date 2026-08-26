import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;
const useTurso = !!tursoUrl;

let db = null;
let client = null;

if (useTurso) {
  client = createClient({
    url: tursoUrl,
    authToken: tursoToken
  });
  console.log('Connected to persistent Turso cloud database at:', tursoUrl);
} else {
  // Local SQLite fallback path
  let dbPath = path.resolve(__dirname, 'campusly.db');

  if (process.env.VERCEL) {
    const tmpPath = '/tmp/campusly.db';
    try {
      if (!fs.existsSync(tmpPath)) {
        fs.copyFileSync(dbPath, tmpPath);
        console.log('Database copied to temporary write space:', tmpPath);
      }
      dbPath = tmpPath;
    } catch (copyErr) {
      console.error('Failed to copy database to write space:', copyErr);
    }
  }

  db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening database', err.message);
    } else {
      console.log('Connected to SQLite database at:', dbPath);
    }
  });
}

// Helper utilities to wrap sqlite3 or Turso client queries in Promises
export const dbRun = (sql, params = []) => {
  if (useTurso) {
    return new Promise(async (resolve, reject) => {
      try {
        const res = await client.execute({ sql, args: params });
        const lastID = res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null;
        resolve({ id: lastID, changes: res.rowsAffected });
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) {
          reject(err);
        } else {
          resolve({ id: this.lastID, changes: this.changes });
        }
      });
    });
  }
};

export const dbGet = (sql, params = []) => {
  if (useTurso) {
    return new Promise(async (resolve, reject) => {
      try {
        const res = await client.execute({ sql, args: params });
        resolve(res.rows[0] || undefined);
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) {
          reject(err);
        } else {
          resolve(row);
        }
      });
    });
  }
};

export const dbAll = (sql, params = []) => {
  if (useTurso) {
    return new Promise(async (resolve, reject) => {
      try {
        const res = await client.execute({ sql, args: params });
        resolve(res.rows || []);
      } catch (err) {
        reject(err);
      }
    });
  } else {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows);
        }
      });
    });
  }
};

// Initialize database schema tables
export const initDB = async () => {
  try {
    if (!useTurso) {
      // Enable Foreign Keys support (disabled on Vercel to allow serverless stateless operation)
      await dbRun(process.env.VERCEL ? 'PRAGMA foreign_keys = OFF;' : 'PRAGMA foreign_keys = ON;');
    }

    // Users Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        avatar_url TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migration: Add columns to users table if they don't exist
    try {
      await dbRun('ALTER TABLE users ADD COLUMN avatar_url TEXT');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN reset_token TEXT');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN reset_token_expires DATETIME');
      if (!useTurso) {
        console.log('Database migration: verified user table columns.');
      }
    } catch (err) {}

    // Subjects Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS subjects (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        target_attendance INTEGER DEFAULT 75,
        color TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Classes / Timetable Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS classes (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        day_of_week INTEGER NOT NULL, -- 0=Sunday, 1=Monday, ..., 6=Saturday
        start_time TEXT NOT NULL,      -- 'HH:MM'
        end_time TEXT NOT NULL,        -- 'HH:MM'
        location TEXT,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Attendance Logs Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS attendance_logs (
        id TEXT PRIMARY KEY,
        subject_id TEXT NOT NULL,
        date TEXT NOT NULL,            -- 'YYYY-MM-DD'
        status TEXT NOT NULL,          -- 'present', 'absent', 'cancelled'
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Assignments Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS assignments (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        due_date TEXT NOT NULL,        -- 'YYYY-MM-DD'
        status TEXT DEFAULT 'pending', -- 'pending', 'completed'
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Exams Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS exams (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        title TEXT NOT NULL,
        date TEXT NOT NULL,            -- 'YYYY-MM-DD'
        start_time TEXT NOT NULL,      -- 'HH:MM'
        location TEXT,
        syllabus TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Notes Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        subject_id TEXT NOT NULL,
        title TEXT NOT NULL,
        file_name TEXT NOT NULL,
        content_extracted TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Calendar Notes Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS calendar_notes (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        date TEXT NOT NULL, -- 'YYYY-MM-DD'
        note TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Notifications Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL,
        reference_id TEXT,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        is_read INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Soften existing dark preset colors in SQLite database to pastel counterparts
    await dbRun("UPDATE subjects SET color = '#ffd1dc' WHERE color = '#ef4444';");
    await dbRun("UPDATE subjects SET color = '#cce4f6' WHERE color = '#06b6d4';");
    await dbRun("UPDATE subjects SET color = '#e5dbfb' WHERE color = '#6366f1' OR color = '#8b5cf6';");
    await dbRun("UPDATE subjects SET color = '#c7ebd7' WHERE color = '#10b981';");
    await dbRun("UPDATE subjects SET color = '#ffecb3' WHERE color = '#f59e0b';");

    console.log('All database tables initialized successfully.');
  } catch (error) {
    console.error('Error initializing database tables:', error);
  }
};

export default db;
