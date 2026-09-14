import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { createClient } from '@libsql/client';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const tursoUrl = process.env.TURSO_DATABASE_URL;
const tursoToken = process.env.TURSO_AUTH_TOKEN;
const useTurso = !!tursoUrl;

let client = null;

if (useTurso) {
  client = createClient({
    url: tursoUrl,
    authToken: tursoToken
  });
  console.log('Connected to persistent Turso cloud database at:', tursoUrl);
} else {
  // Local SQLite / LibSQL file path
  let dbPath = path.resolve(__dirname, 'campusly.db');

  if (process.env.VERCEL) {
    const tmpPath = '/tmp/campusly.db';
    try {
      if (!fs.existsSync(tmpPath)) {
        if (fs.existsSync(dbPath)) {
          fs.copyFileSync(dbPath, tmpPath);
          console.log('Database copied to temporary write space:', tmpPath);
        } else {
          console.log('Template database not present in bundle, initializing new database in /tmp');
        }
      }
      dbPath = tmpPath;
    } catch (copyErr) {
      console.error('Database write space notice:', copyErr.message);
      dbPath = tmpPath;
    }
  }

  // Ensure file protocol prefix for LibSQL local file driver
  const fileUrl = dbPath.startsWith('file:') ? dbPath : `file:${dbPath}`;
  client = createClient({
    url: fileUrl
  });
  console.log('Connected to LibSQL database at:', fileUrl);
}

// Helper utilities to wrap LibSQL client queries in Promises
export const dbRun = async (sql, params = []) => {
  try {
    const res = await client.execute({ sql, args: params });
    const lastID = res.lastInsertRowid !== undefined ? Number(res.lastInsertRowid) : null;
    return { id: lastID, changes: res.rowsAffected };
  } catch (err) {
    throw err;
  }
};

export const dbGet = async (sql, params = []) => {
  try {
    const res = await client.execute({ sql, args: params });
    return res.rows[0] || undefined;
  } catch (err) {
    throw err;
  }
};

export const dbAll = async (sql, params = []) => {
  try {
    const res = await client.execute({ sql, args: params });
    return res.rows || [];
  } catch (err) {
    throw err;
  }
};

// Initialize database schema tables
export const initDB = async () => {
  try {
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
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN spotify_access_token TEXT');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN spotify_refresh_token TEXT');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN spotify_token_expires_at INTEGER');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN is_verified INTEGER DEFAULT 0');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN otp_code TEXT');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN otp_expires_at INTEGER');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN otp_last_sent_at INTEGER');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE users ADD COLUMN gemini_api_key TEXT');
    } catch (err) {}

    // Ensure existing users prior to OTP feature release are marked verified
    try {
      await dbRun('UPDATE users SET is_verified = 1 WHERE is_verified IS NULL OR is_verified = 0 AND (otp_code IS NULL AND created_at < CURRENT_TIMESTAMP)');
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
        start_date TEXT,               -- 'YYYY-MM-DD'
        end_date TEXT,                 -- 'YYYY-MM-DD'
        recurrence_type TEXT DEFAULT 'weekly', -- 'none', 'weekly', 'biweekly', 'monthly', 'yearly', 'custom_days'
        recurrence_days TEXT,          -- comma-separated list of day numbers (0=Sun, 1=Mon, etc.)
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE CASCADE
      )
    `);

    // Class Table Migration
    try {
      await dbRun('ALTER TABLE classes ADD COLUMN start_date TEXT');
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE classes ADD COLUMN end_date TEXT');
    } catch (err) {}
    try {
      await dbRun("ALTER TABLE classes ADD COLUMN recurrence_type TEXT DEFAULT 'weekly'");
    } catch (err) {}
    try {
      await dbRun('ALTER TABLE classes ADD COLUMN recurrence_days TEXT');
    } catch (err) {}

    // Breaks Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS breaks (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        start_date TEXT NOT NULL, -- 'YYYY-MM-DD'
        end_date TEXT NOT NULL,   -- 'YYYY-MM-DD'
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Class Exceptions Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS class_exceptions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        class_id TEXT NOT NULL,
        original_date TEXT NOT NULL, -- 'YYYY-MM-DD'
        exception_type TEXT NOT NULL, -- 'skip', 'move'
        new_date TEXT,               -- 'YYYY-MM-DD'
        new_start_time TEXT,         -- 'HH:MM'
        new_end_time TEXT,           -- 'HH:MM'
        new_location TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(class_id) REFERENCES classes(id) ON DELETE CASCADE
      )
    `);

    // Calendar Events Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS calendar_events (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        type TEXT NOT NULL,          -- 'class_extra', 'work', 'study', 'personal', 'other'
        subject_id TEXT,             -- references subjects(id) ON DELETE SET NULL
        date TEXT NOT NULL,          -- 'YYYY-MM-DD'
        start_time TEXT NOT NULL,    -- 'HH:MM'
        end_time TEXT NOT NULL,      -- 'HH:MM'
        location TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(subject_id) REFERENCES subjects(id) ON DELETE SET NULL
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

    // Gamification XP Logs Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS xp_logs (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        xp_amount INTEGER NOT NULL,
        source TEXT NOT NULL,
        reference_id TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Gamification User Achievements Table
    await dbRun(`
      CREATE TABLE IF NOT EXISTS user_achievements (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        achievement_id TEXT NOT NULL,
        unlocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, achievement_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      )
    `);

    // Performance Indexes for fast queries
    await dbRun('CREATE INDEX IF NOT EXISTS idx_subjects_user ON subjects(user_id);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_classes_subject ON classes(subject_id);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_attendance_subject_date ON attendance_logs(subject_id, date);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_assignments_user ON assignments(user_id, status);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_exams_user ON exams(user_id);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_calendar_events_user ON calendar_events(user_id, date);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_xp_logs_user ON xp_logs(user_id);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_xp_logs_ref ON xp_logs(user_id, reference_id);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_user_achievements_user ON user_achievements(user_id);');
    await dbRun('CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);');

    console.log('All database tables and performance indexes initialized successfully.');
  } catch (error) {
    console.error('Error initializing database tables:', error);
  }
};

export default client;
