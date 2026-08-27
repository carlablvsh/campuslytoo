import express from 'express';
import crypto from 'crypto';
import { dbRun, dbGet, dbAll } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { getOccurrencesForDateRange } from '../utils/scheduler.js';
import { awardXP } from './gamification.js';

const router = express.Router();

// ==========================================
// 1. SUBJECTS ENDPOINTS
// ==========================================

// Get all subjects
router.get('/subjects', authenticateToken, async (req, res) => {
  try {
    const subjects = await dbAll('SELECT * FROM subjects WHERE user_id = ? ORDER BY name ASC', [req.userId]);
    res.json(subjects);
  } catch (err) {
    console.error('Fetch subjects error:', err);
    res.status(500).json({ error: 'Server error fetching subjects.' });
  }
});

// Create subject
router.post('/subjects', authenticateToken, async (req, res) => {
  const { name, code, target_attendance, color } = req.body;

  if (!name || !code || !color) {
    return res.status(400).json({ error: 'Name, code, and color are required.' });
  }

  try {
    const existing = await dbGet(
      'SELECT * FROM subjects WHERE user_id = ? AND (LOWER(code) = LOWER(?) OR LOWER(name) = LOWER(?))',
      [req.userId, code.trim(), name.trim()]
    );
    if (existing) {
      return res.status(200).json(existing);
    }

    const subjectId = crypto.randomUUID();
    const target = target_attendance !== undefined ? parseInt(target_attendance, 10) : 75;
    
    await dbRun(
      'INSERT INTO subjects (id, user_id, name, code, target_attendance, color) VALUES (?, ?, ?, ?, ?, ?)',
      [subjectId, req.userId, name.trim(), code.trim(), target, color]
    );

    const newSubject = await dbGet('SELECT * FROM subjects WHERE id = ?', [subjectId]);
    res.status(201).json(newSubject);
  } catch (err) {
    console.error('Create subject error:', err);
    res.status(500).json({ error: 'Server error creating subject.' });
  }
});

// Update subject
router.put('/subjects/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { name, code, target_attendance, color } = req.body;

  try {
    // Verify subject belongs to user
    const subject = await dbGet('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found.' });
    }

    const updatedName = name || subject.name;
    const updatedCode = code || subject.code;
    const updatedTarget = target_attendance !== undefined ? parseInt(target_attendance, 10) : subject.target_attendance;
    const updatedColor = color || subject.color;

    await dbRun(
      'UPDATE subjects SET name = ?, code = ?, target_attendance = ?, color = ? WHERE id = ?',
      [updatedName, updatedCode, updatedTarget, updatedColor, id]
    );

    const updatedSubject = await dbGet('SELECT * FROM subjects WHERE id = ?', [id]);
    res.json(updatedSubject);
  } catch (err) {
    console.error('Update subject error:', err);
    res.status(500).json({ error: 'Server error updating subject.' });
  }
});

// Delete subject
router.delete('/subjects/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const subject = await dbGet('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found or unauthorized.' });
    }

    await dbRun('DELETE FROM subjects WHERE id = ?', [id]);
    res.json({ message: 'Subject deleted successfully.' });
  } catch (err) {
    console.error('Delete subject error:', err);
    res.status(500).json({ error: 'Server error deleting subject.' });
  }
});


// ==========================================
// 2. TIMETABLE/CLASSES ENDPOINTS
// ==========================================

// Get all classes
router.get('/classes', authenticateToken, async (req, res) => {
  try {
    const classes = await dbAll(`
      SELECT c.*, s.name as subject_name, s.code as subject_code, s.color as subject_color 
      FROM classes c
      JOIN subjects s ON c.subject_id = s.id
      WHERE s.user_id = ?
      ORDER BY c.day_of_week ASC, c.start_time ASC
    `, [req.userId]);
    
    res.json(classes);
  } catch (err) {
    console.error('Fetch classes error:', err);
    res.status(500).json({ error: 'Server error fetching classes.' });
  }
});

// Create timetable class
router.post('/classes', authenticateToken, async (req, res) => {
  const { 
    subject_id, 
    day_of_week, 
    start_time, 
    end_time, 
    location,
    start_date,
    end_date,
    recurrence_type,
    recurrence_days
  } = req.body;

  if (subject_id === undefined || day_of_week === undefined || !start_time || !end_time) {
    return res.status(400).json({ error: 'subject_id, day_of_week, start_time, and end_time are required.' });
  }

  const sDate = start_date || new Date().toISOString().split('T')[0];
  const eDate = end_date || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const recType = recurrence_type || 'weekly';
  const recDays = recurrence_days || null;

  try {
    // Verify subject belongs to user
    const subject = await dbGet('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found or unauthorized.' });
    }

    // Check for timetable conflict/overlapping classes
    const existingClasses = await dbAll(`
      SELECT c.*, s.name as subject_name 
      FROM classes c
      JOIN subjects s ON c.subject_id = s.id
      WHERE s.user_id = ?
    `, [req.userId]);

    const overlap = existingClasses.find(c => {
      const cStartDate = c.start_date || '1970-01-01';
      const cEndDate = c.end_date || '2099-12-31';
      const maxStart = sDate > cStartDate ? sDate : cStartDate;
      const minEnd = eDate < cEndDate ? eDate : cEndDate;
      if (maxStart > minEnd) return false;

      const days1 = recType === 'custom_days' ? (recDays || '').split(',').map(Number) : [parseInt(day_of_week, 10)];
      const days2 = c.recurrence_type === 'custom_days' ? (c.recurrence_days || '').split(',').map(Number) : [c.day_of_week];
      const hasSharedDay = days1.some(d => days2.includes(d));
      if (!hasSharedDay) return false;

      return start_time < c.end_time && end_time > c.start_time;
    });

    if (overlap) {
      if (overlap.subject_id === subject_id && overlap.start_time === start_time && overlap.end_time === end_time) {
        const existingClass = await dbGet(`
          SELECT c.*, s.name as subject_name, s.code as subject_code, s.color as subject_color 
          FROM classes c
          JOIN subjects s ON c.subject_id = s.id
          WHERE c.id = ?
        `, [overlap.id]);
        return res.status(200).json(existingClass);
      }
      return res.status(409).json({ 
        error: `Schedule conflict: This slot overlaps with ${overlap.subject_name} (${overlap.start_time} - ${overlap.end_time}).` 
      });
    }

    const classId = crypto.randomUUID();
    await dbRun(
      'INSERT INTO classes (id, subject_id, day_of_week, start_time, end_time, location, start_date, end_date, recurrence_type, recurrence_days) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        classId,
        subject_id,
        parseInt(day_of_week, 10),
        start_time,
        end_time,
        location || '',
        sDate,
        eDate,
        recType,
        recDays
      ]
    );

    const newClass = await dbGet(`
      SELECT c.*, s.name as subject_name, s.code as subject_code, s.color as subject_color 
      FROM classes c
      JOIN subjects s ON c.subject_id = s.id
      WHERE c.id = ?
    `, [classId]);

    res.status(201).json(newClass);
  } catch (err) {
    console.error('Create class error:', err);
    res.status(500).json({ error: 'Server error creating timetable class.' });
  }
});

// Update timetable class
router.put('/classes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { 
    subject_id, 
    day_of_week, 
    start_time, 
    end_time, 
    location,
    start_date,
    end_date,
    recurrence_type,
    recurrence_days
  } = req.body;

  if (subject_id === undefined || day_of_week === undefined || !start_time || !end_time) {
    return res.status(400).json({ error: 'subject_id, day_of_week, start_time, and end_time are required.' });
  }

  const sDate = start_date || new Date().toISOString().split('T')[0];
  const eDate = end_date || new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const recType = recurrence_type || 'weekly';
  const recDays = recurrence_days || null;

  try {
    // Verify class exists and belongs to user
    const existingClass = await dbGet(`
      SELECT c.id FROM classes c 
      JOIN subjects s ON c.subject_id = s.id 
      WHERE c.id = ? AND s.user_id = ?
    `, [id, req.userId]);

    if (!existingClass) {
      return res.status(404).json({ error: 'Class not found or unauthorized.' });
    }

    // Verify target subject belongs to user
    const subject = await dbGet('SELECT * FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found or unauthorized.' });
    }

    // Check for timetable conflict/overlapping classes (excluding current class)
    const existingClasses = await dbAll(`
      SELECT c.*, s.name as subject_name 
      FROM classes c
      JOIN subjects s ON c.subject_id = s.id
      WHERE s.user_id = ? AND c.id != ?
    `, [req.userId, id]);

    const overlap = existingClasses.find(c => {
      const cStartDate = c.start_date || '1970-01-01';
      const cEndDate = c.end_date || '2099-12-31';
      const maxStart = sDate > cStartDate ? sDate : cStartDate;
      const minEnd = eDate < cEndDate ? eDate : cEndDate;
      if (maxStart > minEnd) return false;

      const days1 = recType === 'custom_days' ? (recDays || '').split(',').map(Number) : [parseInt(day_of_week, 10)];
      const days2 = c.recurrence_type === 'custom_days' ? (c.recurrence_days || '').split(',').map(Number) : [c.day_of_week];
      const hasSharedDay = days1.some(d => days2.includes(d));
      if (!hasSharedDay) return false;

      return start_time < c.end_time && end_time > c.start_time;
    });

    if (overlap) {
      return res.status(409).json({ 
        error: `Schedule conflict: This slot overlaps with ${overlap.subject_name} (${overlap.start_time} - ${overlap.end_time}).` 
      });
    }

    await dbRun(
      'UPDATE classes SET subject_id = ?, day_of_week = ?, start_time = ?, end_time = ?, location = ?, start_date = ?, end_date = ?, recurrence_type = ?, recurrence_days = ? WHERE id = ?',
      [
        subject_id,
        parseInt(day_of_week, 10),
        start_time,
        end_time,
        location || '',
        sDate,
        eDate,
        recType,
        recDays,
        id
      ]
    );

    const updated = await dbGet(`
      SELECT c.*, s.name as subject_name, s.code as subject_code, s.color as subject_color 
      FROM classes c
      JOIN subjects s ON c.subject_id = s.id
      WHERE c.id = ?
    `, [id]);

    res.json(updated);
  } catch (err) {
    console.error('Update class error:', err);
    res.status(500).json({ error: 'Server error updating timetable class.' });
  }
});

// Delete class
router.delete('/classes/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    // Verify class belongs to user's subject
    const classItem = await dbGet(`
      SELECT c.id FROM classes c 
      JOIN subjects s ON c.subject_id = s.id 
      WHERE c.id = ? AND s.user_id = ?
    `, [id, req.userId]);

    if (!classItem) {
      return res.status(404).json({ error: 'Timetable class not found or unauthorized.' });
    }

    await dbRun('DELETE FROM classes WHERE id = ?', [id]);
    res.json({ message: 'Timetable class deleted.' });
  } catch (err) {
    console.error('Delete class error:', err);
    res.status(500).json({ error: 'Server error deleting timetable class.' });
  }
});


// ==========================================
// 3. ATTENDANCE ENDPOINTS
// ==========================================

// Get attendance logs for a subject or all subjects
router.get('/attendance', authenticateToken, async (req, res) => {
  const { subject_id } = req.query;

  try {
    let logs;
    if (subject_id) {
      // Verify subject
      const subject = await dbGet('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found.' });
      }
      logs = await dbAll('SELECT * FROM attendance_logs WHERE subject_id = ? ORDER BY date DESC', [subject_id]);
    } else {
      logs = await dbAll(`
        SELECT a.*, s.name as subject_name, s.code as subject_code
        FROM attendance_logs a
        JOIN subjects s ON a.subject_id = s.id
        WHERE s.user_id = ?
        ORDER BY a.date DESC
      `, [req.userId]);
    }
    res.json(logs);
  } catch (err) {
    console.error('Fetch attendance error:', err);
    res.status(500).json({ error: 'Server error fetching attendance logs.' });
  }
});

// Log attendance (creates or updates for a specific subject and date)
router.post('/attendance', authenticateToken, async (req, res) => {
  const { subject_id, date, status } = req.body;

  if (!subject_id || !date || !status) {
    return res.status(400).json({ error: 'subject_id, date, and status are required.' });
  }

  if (!['present', 'absent', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: "status must be 'present', 'absent', or 'cancelled'." });
  }

  try {
    // Verify subject ownership
    const subject = await dbGet('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found or unauthorized.' });
    }

    // Clean up existing logs on the same date for the same subject
    await dbRun('DELETE FROM attendance_logs WHERE subject_id = ? AND date = ?', [subject_id, date]);

    const logId = crypto.randomUUID();
    await dbRun(
      'INSERT INTO attendance_logs (id, subject_id, date, status) VALUES (?, ?, ?, ?)',
      [logId, subject_id, date, status]
    );

    // Award server-controlled XP for attended classes (deduplicated by subject_id + date)
    if (status === 'present') {
      await awardXP(req.userId, 'attendance_marked', 'attendance', `att_${subject_id}_${date}`, {
        subject_name: subject.name,
        subject_code: subject.code,
        date
      });
    }

    res.status(201).json({ id: logId, subject_id, date, status });
  } catch (err) {
    console.error('Log attendance error:', err);
    res.status(500).json({ error: 'Server error tracking attendance.' });
  }
});

// Get attendance dashboard stats & simulator values
router.get('/attendance/stats', authenticateToken, async (req, res) => {
  try {
    // Get all subjects
    const subjects = await dbAll('SELECT * FROM subjects WHERE user_id = ? ORDER BY name ASC', [req.userId]);
    
    // Get all logs for calculations
    const logs = await dbAll(`
      SELECT a.* 
      FROM attendance_logs a
      JOIN subjects s ON a.subject_id = s.id
      WHERE s.user_id = ?
    `, [req.userId]);

    const stats = subjects.map(subject => {
      const subjectLogs = logs.filter(log => log.subject_id === subject.id);
      
      const present = subjectLogs.filter(log => log.status === 'present').length;
      const absent = subjectLogs.filter(log => log.status === 'absent').length;
      const cancelled = subjectLogs.filter(log => log.status === 'cancelled').length;
      
      const totalActive = present + absent;
      const currentPercentage = totalActive > 0 ? parseFloat(((present / totalActive) * 100).toFixed(1)) : 100.0;
      
      const target = subject.target_attendance;
      const targetFraction = target / 100;
      
      let classesCanMiss = 0;
      let classesToAttend = 0;
      
      if (totalActive === 0) {
        // If no classes logged yet, student is technically at 100% and has met target
        classesCanMiss = 0;
        classesToAttend = 0;
      } else {
        if (currentPercentage >= target) {
          // Can miss calculations: M <= (P - T(P + A)) / T
          const val = (present - targetFraction * totalActive) / targetFraction;
          classesCanMiss = Math.floor(val);
          // Just in case it evaluates to -0 or negative due to float precision
          if (classesCanMiss < 0) classesCanMiss = 0;
        } else {
          // Must attend consecutive classes: N >= (T(P + A) - P) / (1 - T)
          const val = (targetFraction * totalActive - present) / (1 - targetFraction);
          classesToAttend = Math.ceil(val);
        }
      }

      return {
        id: subject.id,
        name: subject.name,
        code: subject.code,
        color: subject.color,
        targetAttendance: target,
        presentCount: present,
        absentCount: absent,
        cancelledCount: cancelled,
        totalLogged: subjectLogs.length,
        totalActive,
        currentPercentage,
        classesCanMiss,
        classesToAttend,
        status: currentPercentage >= target ? 'safe' : 'danger'
      };
    });

    res.json(stats);
  } catch (err) {
    console.error('Fetch attendance stats error:', err);
    res.status(500).json({ error: 'Server error computing attendance calculations.' });
  }
});


// ==========================================
// 4. ASSIGNMENTS / DEADLINES ENDPOINTS
// ==========================================

// Get all assignments
router.get('/assignments', authenticateToken, async (req, res) => {
  try {
    const assignments = await dbAll(`
      SELECT a.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM assignments a
      JOIN subjects s ON a.subject_id = s.id
      WHERE a.user_id = ?
      ORDER BY a.due_date ASC
    `, [req.userId]);
    res.json(assignments);
  } catch (err) {
    console.error('Fetch assignments error:', err);
    res.status(500).json({ error: 'Server error fetching assignments.' });
  }
});

// Create assignment
router.post('/assignments', authenticateToken, async (req, res) => {
  const { subject_id, title, description, due_date } = req.body;

  if (!subject_id || !title || !due_date) {
    return res.status(400).json({ error: 'subject_id, title, and due_date are required.' });
  }

  try {
    // Verify subject ownership
    const subject = await dbGet('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found or unauthorized.' });
    }

    // Prevent accidental duplicate submission within the same minute
    const recentDup = await dbGet(
      'SELECT id FROM assignments WHERE user_id = ? AND subject_id = ? AND title = ? AND due_date = ? LIMIT 1',
      [req.userId, subject_id, title.trim(), due_date]
    );
    if (recentDup) {
      const existingAssignment = await dbGet(`
        SELECT a.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
        FROM assignments a
        JOIN subjects s ON a.subject_id = s.id
        WHERE a.id = ?
      `, [recentDup.id]);
      return res.status(200).json(existingAssignment);
    }

    const assignmentId = crypto.randomUUID();
    await dbRun(
      'INSERT INTO assignments (id, user_id, subject_id, title, description, due_date, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [assignmentId, req.userId, subject_id, title.trim(), description || '', due_date, 'pending']
    );

    const newAssignment = await dbGet(`
      SELECT a.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM assignments a
      JOIN subjects s ON a.subject_id = s.id
      WHERE a.id = ?
    `, [assignmentId]);

    res.status(201).json(newAssignment);
  } catch (err) {
    console.error('Create assignment error:', err);
    res.status(500).json({ error: 'Server error creating assignment.' });
  }
});

// Update assignment (status or text content)
router.put('/assignments/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { title, description, due_date, status } = req.body;

  try {
    // Verify ownership
    const assignment = await dbGet('SELECT * FROM assignments WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found or unauthorized.' });
    }

    const updatedTitle = title !== undefined ? title : assignment.title;
    const updatedDesc = description !== undefined ? description : assignment.description;
    const updatedDueDate = due_date !== undefined ? due_date : assignment.due_date;
    const updatedStatus = status !== undefined ? status : assignment.status;

    await dbRun(
      'UPDATE assignments SET title = ?, description = ?, due_date = ?, status = ? WHERE id = ?',
      [updatedTitle, updatedDesc, updatedDueDate, updatedStatus, id]
    );

    const updatedAssignment = await dbGet(`
      SELECT a.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM assignments a
      JOIN subjects s ON a.subject_id = s.id
      WHERE a.id = ?
    `, [id]);

    // Award server-controlled XP on marking assignment completed (deduplicated by assignment id)
    if (updatedStatus === 'completed' && assignment.status !== 'completed') {
      await awardXP(req.userId, 'assignment_completed', 'assignments', `ass_${id}`, {
        assignment_title: updatedTitle,
        subject_code: updatedAssignment?.subject_code
      });
    }

    res.json(updatedAssignment);
  } catch (err) {
    console.error('Update assignment error:', err);
    res.status(500).json({ error: 'Server error updating assignment.' });
  }
});

// Delete assignment
router.delete('/assignments/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const assignment = await dbGet('SELECT * FROM assignments WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!assignment) {
      return res.status(404).json({ error: 'Assignment not found or unauthorized.' });
    }

    await dbRun('DELETE FROM assignments WHERE id = ?', [id]);
    res.json({ message: 'Assignment deleted successfully.' });
  } catch (err) {
    console.error('Delete assignment error:', err);
    res.status(500).json({ error: 'Server error deleting assignment.' });
  }
});


// ==========================================
// 5. EXAMS ENDPOINTS
// ==========================================

// Get all exams
router.get('/exams', authenticateToken, async (req, res) => {
  try {
    const exams = await dbAll(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM exams e
      JOIN subjects s ON e.subject_id = s.id
      WHERE e.user_id = ?
      ORDER BY e.date ASC, e.start_time ASC
    `, [req.userId]);
    res.json(exams);
  } catch (err) {
    console.error('Fetch exams error:', err);
    res.status(500).json({ error: 'Server error fetching exams.' });
  }
});

// Create exam
router.post('/exams', authenticateToken, async (req, res) => {
  const { subject_id, title, date, start_time, location, syllabus } = req.body;

  if (!subject_id || !title || !date || !start_time) {
    return res.status(400).json({ error: 'subject_id, title, date, and start_time are required.' });
  }

  try {
    // Verify subject ownership
    const subject = await dbGet('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found or unauthorized.' });
    }

    // Prevent duplicate exam creation
    const dupExam = await dbGet(
      'SELECT id FROM exams WHERE user_id = ? AND subject_id = ? AND title = ? AND date = ? AND start_time = ?',
      [req.userId, subject_id, title.trim(), date, start_time]
    );
    if (dupExam) {
      const existingExam = await dbGet(`
        SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
        FROM exams e
        JOIN subjects s ON e.subject_id = s.id
        WHERE e.id = ?
      `, [dupExam.id]);
      return res.status(200).json(existingExam);
    }

    const examId = crypto.randomUUID();
    await dbRun(
      'INSERT INTO exams (id, user_id, subject_id, title, date, start_time, location, syllabus) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [examId, req.userId, subject_id, title.trim(), date, start_time, location || '', syllabus || '']
    );

    const newExam = await dbGet(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM exams e
      JOIN subjects s ON e.subject_id = s.id
      WHERE e.id = ?
    `, [examId]);

    res.status(201).json(newExam);
  } catch (err) {
    console.error('Create exam error:', err);
    res.status(500).json({ error: 'Server error creating exam schedule.' });
  }
});

// Update exam
router.put('/exams/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { title, date, start_time, location, syllabus } = req.body;

  try {
    // Verify ownership
    const exam = await dbGet('SELECT * FROM exams WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found or unauthorized.' });
    }

    const updatedTitle = title !== undefined ? title : exam.title;
    const updatedDate = date !== undefined ? date : exam.date;
    const updatedTime = start_time !== undefined ? start_time : exam.start_time;
    const updatedLoc = location !== undefined ? location : exam.location;
    const updatedSyllabus = syllabus !== undefined ? syllabus : exam.syllabus;

    await dbRun(
      'UPDATE exams SET title = ?, date = ?, start_time = ?, location = ?, syllabus = ? WHERE id = ?',
      [updatedTitle, updatedDate, updatedTime, updatedLoc, updatedSyllabus, id]
    );

    const updatedExam = await dbGet(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM exams e
      JOIN subjects s ON e.subject_id = s.id
      WHERE e.id = ?
    `, [id]);

    res.json(updatedExam);
  } catch (err) {
    console.error('Update exam error:', err);
    res.status(500).json({ error: 'Server error updating exam schedule.' });
  }
});

// Delete exam
router.delete('/exams/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const exam = await dbGet('SELECT * FROM exams WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!exam) {
      return res.status(404).json({ error: 'Exam not found or unauthorized.' });
    }

    await dbRun('DELETE FROM exams WHERE id = ?', [id]);
    res.json({ message: 'Exam deleted successfully.' });
  } catch (err) {
    console.error('Delete exam error:', err);
    res.status(500).json({ error: 'Server error deleting exam.' });
  }
});

// ==========================================
// 6. CALENDAR NOTES ENDPOINTS
// ==========================================

// Get all calendar notes
router.get('/calendar-notes', authenticateToken, async (req, res) => {
  try {
    const notes = await dbAll('SELECT * FROM calendar_notes WHERE user_id = ? ORDER BY date ASC', [req.userId]);
    res.json(notes);
  } catch (err) {
    console.error('Fetch calendar notes error:', err);
    res.status(500).json({ error: 'Server error fetching calendar notes.' });
  }
});

// Upsert calendar note (creates, updates, or deletes if empty)
router.post('/calendar-notes', authenticateToken, async (req, res) => {
  const { date, note } = req.body;

  if (!date || note === undefined) {
    return res.status(400).json({ error: 'date and note content are required.' });
  }

  try {
    const existing = await dbGet('SELECT * FROM calendar_notes WHERE user_id = ? AND date = ?', [req.userId, date]);
    
    if (existing) {
      if (!note.trim()) {
        // Delete note if text cleared
        await dbRun('DELETE FROM calendar_notes WHERE id = ?', [existing.id]);
        return res.json({ message: 'Calendar note cleared successfully.', action: 'deleted' });
      } else {
        // Update note
        await dbRun('UPDATE calendar_notes SET note = ? WHERE id = ?', [note.trim(), existing.id]);
        const updated = await dbGet('SELECT * FROM calendar_notes WHERE id = ?', [existing.id]);
        return res.json({ message: 'Calendar note updated successfully.', note: updated, action: 'updated' });
      }
    } else {
      if (note.trim()) {
        const id = crypto.randomUUID();
        await dbRun(
          'INSERT INTO calendar_notes (id, user_id, date, note) VALUES (?, ?, ?, ?)',
          [id, req.userId, date, note.trim()]
        );
        const created = await dbGet('SELECT * FROM calendar_notes WHERE id = ?', [id]);
        return res.status(201).json({ message: 'Calendar note created successfully.', note: created, action: 'created' });
      } else {
        return res.json({ message: 'No action taken for empty note.', action: 'none' });
      }
    }
  } catch (err) {
    console.error('Upsert calendar note error:', err);
    res.status(500).json({ error: 'Server error saving calendar note.' });
  }
});

// Batch import save timetable classes
router.post('/classes/import', authenticateToken, async (req, res) => {
  const { classes } = req.body; // Array of { day, start_time, end_time, subject_name, subject_code, class_type, room }

  if (!classes || !Array.isArray(classes)) {
    return res.status(400).json({ error: 'An array of classes is required.' });
  }

  try {
    // 1. Fetch user's existing subjects and classes
    const existingSubjects = await dbAll('SELECT * FROM subjects WHERE user_id = ?', [req.userId]);
    const subjectsMap = new Map(); // code/name -> subjectId
    existingSubjects.forEach(s => {
      subjectsMap.set(s.code.toLowerCase(), s.id);
      subjectsMap.set(s.name.toLowerCase(), s.id);
    });

    const pastelColors = ['#ffd1dc', '#cce4f6', '#e5dbfb', '#c7ebd7', '#ffecb3', '#ffe2cb'];

    // Map day strings to integers: 0=Sunday, 1=Monday, ..., 6=Saturday
    const dayMap = {
      'sunday': 0, 'sun': 0,
      'monday': 1, 'mon': 1,
      'tuesday': 2, 'tue': 2,
      'wednesday': 3, 'wed': 3,
      'thursday': 4, 'thu': 4,
      'friday': 5, 'fri': 5,
      'saturday': 6, 'sat': 6
    };

    const savedClasses = [];

    for (const item of classes) {
      const { day, start_time, end_time, subject_name, subject_code, class_type, room } = item;
      
      const dayLower = day ? day.toLowerCase().trim() : '';
      const dayOfWeek = dayMap[dayLower] !== undefined ? dayMap[dayLower] : 1; // Default to Monday if not matched
      
      const cleanTime = (t) => {
        if (!t) return '';
        const match = t.match(/(\d{1,2}):(\d{2})/);
        if (match) {
          const hours = match[1].padStart(2, '0');
          const minutes = match[2];
          return `${hours}:${minutes}`;
        }
        return t;
      };

      const cleanStart = cleanTime(start_time);
      const cleanEnd = cleanTime(end_time);

      if (!subject_name || !cleanStart || !cleanEnd) continue;

      // Resolve/create subject
      let subjectId = null;
      const codeKey = (subject_code || subject_name).toLowerCase().trim();
      const nameKey = subject_name.toLowerCase().trim();

      if (subjectsMap.has(codeKey)) {
        subjectId = subjectsMap.get(codeKey);
      } else if (subjectsMap.has(nameKey)) {
        subjectId = subjectsMap.get(nameKey);
      } else {
        // Create new subject
        subjectId = crypto.randomUUID();
        const randomColor = pastelColors[Math.floor(Math.random() * pastelColors.length)];
        await dbRun(
          'INSERT INTO subjects (id, user_id, name, code, target_attendance, color) VALUES (?, ?, ?, ?, ?, ?)',
          [subjectId, req.userId, subject_name, subject_code || subject_name.substring(0, 5).toUpperCase(), 75, randomColor]
        );
        subjectsMap.set(codeKey, subjectId);
        subjectsMap.set(nameKey, subjectId);
      }

      // Check overlapping for this user's day slot
      const existing = await dbAll(
        'SELECT * FROM classes WHERE subject_id IN (SELECT id FROM subjects WHERE user_id = ?) AND day_of_week = ?',
        [req.userId, dayOfWeek]
      );
      
      const duplicateClass = existing.find(c => 
        c.subject_id === subjectId && 
        c.start_time === cleanStart && 
        c.end_time === cleanEnd
      );

      if (duplicateClass) {
        await dbRun('UPDATE classes SET location = ? WHERE id = ?', [room || '', duplicateClass.id]);
        savedClasses.push(duplicateClass);
        continue;
      }

      const conflictingIds = existing.filter(c => cleanStart < c.end_time && cleanEnd > c.start_time).map(c => c.id);
      for (const cId of conflictingIds) {
        await dbRun('DELETE FROM classes WHERE id = ?', [cId]);
      }

      // Create class
      const classId = crypto.randomUUID();
      await dbRun(
        'INSERT INTO classes (id, subject_id, day_of_week, start_time, end_time, location) VALUES (?, ?, ?, ?, ?, ?)',
        [classId, subjectId, dayOfWeek, cleanStart, cleanEnd, room || '']
      );

      savedClasses.push({
        id: classId,
        subject_id: subjectId,
        day_of_week: dayOfWeek,
        start_time: cleanStart,
        end_time: cleanEnd,
        location: room || ''
      });
    }

    res.status(201).json({ success: true, count: savedClasses.length });
  } catch (err) {
    console.error('Batch create classes error:', err);
    res.status(500).json({ error: 'Server error saving imported timetable.' });
  }
});

// ==========================================
// 6. BREAKS ENDPOINTS
// ==========================================

// Get all breaks
router.get('/breaks', authenticateToken, async (req, res) => {
  try {
    const breaks = await dbAll('SELECT * FROM breaks WHERE user_id = ? ORDER BY start_date ASC', [req.userId]);
    res.json(breaks);
  } catch (err) {
    console.error('Fetch breaks error:', err);
    res.status(500).json({ error: 'Server error fetching breaks.' });
  }
});

// Create break
router.post('/breaks', authenticateToken, async (req, res) => {
  const { name, start_date, end_date } = req.body;

  if (!name || !start_date || !end_date) {
    return res.status(400).json({ error: 'name, start_date, and end_date are required.' });
  }

  try {
    const breakId = crypto.randomUUID();
    await dbRun(
      'INSERT INTO breaks (id, user_id, name, start_date, end_date) VALUES (?, ?, ?, ?, ?)',
      [breakId, req.userId, name, start_date, end_date]
    );

    const newBreak = await dbGet('SELECT * FROM breaks WHERE id = ?', [breakId]);
    res.status(201).json(newBreak);
  } catch (err) {
    console.error('Create break error:', err);
    res.status(500).json({ error: 'Server error creating break period.' });
  }
});

// Delete break
router.delete('/breaks/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await dbGet('SELECT id FROM breaks WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Break not found or unauthorized.' });
    }

    await dbRun('DELETE FROM breaks WHERE id = ?', [id]);
    res.json({ message: 'Break period deleted.' });
  } catch (err) {
    console.error('Delete break error:', err);
    res.status(500).json({ error: 'Server error deleting break period.' });
  }
});

// ==========================================
// 7. CALENDAR EVENTS ENDPOINTS (WORK, STUDY, ETC.)
// ==========================================

// Get all calendar events
router.get('/calendar-events', authenticateToken, async (req, res) => {
  try {
    const events = await dbAll(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM calendar_events e
      LEFT JOIN subjects s ON e.subject_id = s.id
      WHERE e.user_id = ?
      ORDER BY e.date ASC, e.start_time ASC
    `, [req.userId]);
    res.json(events);
  } catch (err) {
    console.error('Fetch calendar events error:', err);
    res.status(500).json({ error: 'Server error fetching calendar events.' });
  }
});

// Create calendar event
router.post('/calendar-events', authenticateToken, async (req, res) => {
  const { title, type, subject_id, date, start_time, end_time, location } = req.body;

  if (!title || !type || !date || !start_time || !end_time) {
    return res.status(400).json({ error: 'title, type, date, start_time, and end_time are required.' });
  }

  try {
    if (subject_id) {
      const subject = await dbGet('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found or unauthorized.' });
      }
    }

    const eventId = crypto.randomUUID();
    await dbRun(`
      INSERT INTO calendar_events (id, user_id, title, type, subject_id, date, start_time, end_time, location)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [eventId, req.userId, title, type, subject_id || null, date, start_time, end_time, location || '']);

    const newEvent = await dbGet(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM calendar_events e
      LEFT JOIN subjects s ON e.subject_id = s.id
      WHERE e.id = ?
    `, [eventId]);

    res.status(201).json(newEvent);
  } catch (err) {
    console.error('Create calendar event error:', err);
    res.status(500).json({ error: 'Server error creating calendar event.' });
  }
});

// Update calendar event
router.put('/calendar-events/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { title, type, subject_id, date, start_time, end_time, location } = req.body;

  if (!title || !type || !date || !start_time || !end_time) {
    return res.status(400).json({ error: 'title, type, date, start_time, and end_time are required.' });
  }

  try {
    const existing = await dbGet('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Calendar event not found or unauthorized.' });
    }

    if (subject_id) {
      const subject = await dbGet('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
      if (!subject) {
        return res.status(404).json({ error: 'Subject not found or unauthorized.' });
      }
    }

    await dbRun(`
      UPDATE calendar_events
      SET title = ?, type = ?, subject_id = ?, date = ?, start_time = ?, end_time = ?, location = ?
      WHERE id = ? AND user_id = ?
    `, [title, type, subject_id || null, date, start_time, end_time, location || '', id, req.userId]);

    const updatedEvent = await dbGet(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM calendar_events e
      LEFT JOIN subjects s ON e.subject_id = s.id
      WHERE e.id = ?
    `, [id]);

    res.json(updatedEvent);
  } catch (err) {
    console.error('Update calendar event error:', err);
    res.status(500).json({ error: 'Server error updating calendar event.' });
  }
});

// Delete calendar event
router.delete('/calendar-events/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await dbGet('SELECT id FROM calendar_events WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Calendar event not found or unauthorized.' });
    }

    await dbRun('DELETE FROM calendar_events WHERE id = ?', [id]);
    res.json({ message: 'Calendar event deleted.' });
  } catch (err) {
    console.error('Delete calendar event error:', err);
    res.status(500).json({ error: 'Server error deleting calendar event.' });
  }
});

// ==========================================
// 8. CLASS EXCEPTIONS ENDPOINTS (SKIP / MOVE)
// ==========================================

// Get all exceptions
router.get('/class-exceptions', authenticateToken, async (req, res) => {
  try {
    const exceptions = await dbAll('SELECT * FROM class_exceptions WHERE user_id = ?', [req.userId]);
    res.json(exceptions);
  } catch (err) {
    console.error('Fetch class exceptions error:', err);
    res.status(500).json({ error: 'Server error fetching class exceptions.' });
  }
});

// Create/Update exception
router.post('/class-exceptions', authenticateToken, async (req, res) => {
  const { 
    class_id, 
    original_date, 
    exception_type, 
    new_date, 
    new_start_time, 
    new_end_time, 
    new_location 
  } = req.body;

  if (!class_id || !original_date || !exception_type) {
    return res.status(400).json({ error: 'class_id, original_date, and exception_type are required.' });
  }

  try {
    // Verify class belongs to user
    const classItem = await dbGet(`
      SELECT c.id FROM classes c 
      JOIN subjects s ON c.subject_id = s.id 
      WHERE c.id = ? AND s.user_id = ?
    `, [class_id, req.userId]);

    if (!classItem) {
      return res.status(404).json({ error: 'Class not found or unauthorized.' });
    }

    const existing = await dbGet('SELECT id FROM class_exceptions WHERE user_id = ? AND class_id = ? AND original_date = ?', [req.userId, class_id, original_date]);
    
    if (existing) {
      await dbRun(`
        UPDATE class_exceptions
        SET exception_type = ?, new_date = ?, new_start_time = ?, new_end_time = ?, new_location = ?
        WHERE id = ?
      `, [exception_type, new_date || null, new_start_time || null, new_end_time || null, new_location || null, existing.id]);
      
      const updated = await dbGet('SELECT * FROM class_exceptions WHERE id = ?', [existing.id]);
      res.json(updated);
    } else {
      const exceptionId = crypto.randomUUID();
      await dbRun(`
        INSERT INTO class_exceptions (id, user_id, class_id, original_date, exception_type, new_date, new_start_time, new_end_time, new_location)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [exceptionId, req.userId, class_id, original_date, exception_type, new_date || null, new_start_time || null, new_end_time || null, new_location || null]);

      const created = await dbGet('SELECT * FROM class_exceptions WHERE id = ?', [exceptionId]);
      res.status(201).json(created);
    }
  } catch (err) {
    console.error('Save class exception error:', err);
    res.status(500).json({ error: 'Server error saving class exception.' });
  }
});

// Delete class exception
router.delete('/class-exceptions/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await dbGet('SELECT id FROM class_exceptions WHERE id = ? AND user_id = ?', [id, req.userId]);
    if (!existing) {
      return res.status(404).json({ error: 'Class exception not found or unauthorized.' });
    }

    await dbRun('DELETE FROM class_exceptions WHERE id = ?', [id]);
    res.json({ message: 'Class exception deleted.' });
  } catch (err) {
    console.error('Delete class exception error:', err);
    res.status(500).json({ error: 'Server error deleting class exception.' });
  }
});

// ==========================================
// 9. UNIFIED SCHEDULER OCCURRENCE TIMELINE
// ==========================================

router.get('/calendar/occurrences', authenticateToken, async (req, res) => {
  const { startDate, endDate } = req.query;

  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate parameters are required (YYYY-MM-DD).' });
  }

  try {
    const classes = await dbAll(`
      SELECT c.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM classes c
      JOIN subjects s ON c.subject_id = s.id
      WHERE s.user_id = ?
    `, [req.userId]);

    const breaks = await dbAll('SELECT * FROM breaks WHERE user_id = ?', [req.userId]);
    const exceptions = await dbAll('SELECT * FROM class_exceptions WHERE user_id = ?', [req.userId]);
    const events = await dbAll(`
      SELECT e.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM calendar_events e
      LEFT JOIN subjects s ON e.subject_id = s.id
      WHERE e.user_id = ?
    `, [req.userId]);

    const occurrences = getOccurrencesForDateRange(classes, breaks, exceptions, events, startDate, endDate);
    res.json(occurrences);
  } catch (err) {
    console.error('Fetch occurrences error:', err);
    res.status(500).json({ error: 'Server error computing calendar schedule.' });
  }
});

export default router;
