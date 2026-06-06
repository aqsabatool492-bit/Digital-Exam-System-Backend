// ============================================
// db/setup.js — DATABASE SETUP & SEEDING
// Run once with: node db/setup.js
// ============================================

require("dotenv").config();
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const path = require("path");
const fs = require("fs");

const dbPath = process.env.DB_PATH || "./db/exam_system.db";

// Make sure db folder exists
const dbDir = path.dirname(dbPath);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

console.log("📦 Setting up database...");

// ============================================
// CREATE TABLES
// ============================================

db.exec(`
  -- USERS table (students, teachers, admins all here)
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    email       TEXT    NOT NULL UNIQUE,
    password    TEXT    NOT NULL,
    role        TEXT    NOT NULL CHECK(role IN ('student','teacher','admin')),
    full_name   TEXT    NOT NULL,
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login  TEXT
  );

  -- EXAMS table
  CREATE TABLE IF NOT EXISTS exams (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT    NOT NULL,
    subject      TEXT    NOT NULL,
    exam_code    TEXT    NOT NULL UNIQUE,
    teacher_id   INTEGER NOT NULL REFERENCES users(id),
    duration_min INTEGER NOT NULL DEFAULT 30,
    total_marks  INTEGER NOT NULL DEFAULT 100,
    pass_marks   INTEGER NOT NULL DEFAULT 40,
    status       TEXT    NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','closed')),
    start_time   TEXT,
    end_time     TEXT,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- QUESTIONS table
  CREATE TABLE IF NOT EXISTS questions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    exam_id      INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    question_text TEXT   NOT NULL,
    option_a     TEXT    NOT NULL,
    option_b     TEXT    NOT NULL,
    option_c     TEXT    NOT NULL,
    option_d     TEXT    NOT NULL,
    correct_ans  INTEGER NOT NULL CHECK(correct_ans IN (0,1,2,3)),
    marks        INTEGER NOT NULL DEFAULT 1,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- EXAM SESSIONS — tracks a student sitting an exam
  CREATE TABLE IF NOT EXISTS exam_sessions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id   INTEGER NOT NULL REFERENCES users(id),
    exam_id      INTEGER NOT NULL REFERENCES exams(id),
    started_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    submitted_at TEXT,
    status       TEXT    NOT NULL DEFAULT 'ongoing' CHECK(status IN ('ongoing','submitted','flagged')),
    score        INTEGER,
    total_marks  INTEGER,
    percentage   REAL,
    result       TEXT    CHECK(result IN ('pass','fail',NULL)),
    UNIQUE(student_id, exam_id)
  );

  -- ANSWERS table — stores each answer a student gave
  CREATE TABLE IF NOT EXISTS answers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
    question_id  INTEGER NOT NULL REFERENCES questions(id),
    selected_ans INTEGER CHECK(selected_ans IN (0,1,2,3,NULL)),
    is_correct   INTEGER NOT NULL DEFAULT 0
  );

  -- CHEATING ALERTS table
  CREATE TABLE IF NOT EXISTS cheating_alerts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES exam_sessions(id),
    student_id   INTEGER NOT NULL REFERENCES users(id),
    alert_type   TEXT    NOT NULL,
    description  TEXT,
    severity     TEXT    NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high')),
    timestamp    TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

console.log("✅ Tables created.");

// ============================================
// SEED DEFAULT USERS
// ============================================

const seedUsers = db.transaction(() => {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (username, email, password, role, full_name)
    VALUES (?, ?, ?, ?, ?)
  `);

  const adminPass = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "Admin@1234", 10);
  insert.run("admin", process.env.ADMIN_EMAIL || "admin@examportal.com", adminPass, "admin", "System Administrator");

  const teacherPass = bcrypt.hashSync("Teacher@123", 10);
  insert.run("drkhan", "drkhan@examportal.com", teacherPass, "teacher", "Dr. Khan");
  insert.run("profayesha", "ayesha@examportal.com", teacherPass, "teacher", "Prof. Ayesha");

  const studentPass = bcrypt.hashSync("Student@123", 10);
  insert.run("ali_student", "ali@student.com", studentPass, "student", "Ali Ahmed");
  insert.run("sara_student", "sara@student.com", studentPass, "student", "Sara Khan");
  insert.run("usman_student", "usman@student.com", studentPass, "student", "Usman Malik");
  insert.run("ayesha_student", "ayesha_s@student.com", studentPass, "student", "Ayesha Raza");
});

seedUsers();
console.log("✅ Default users seeded.");
console.log("   👤 Admin    → username: admin       | password: Admin@1234");
console.log("   👨‍🏫 Teacher  → username: drkhan      | password: Teacher@123");
console.log("   👨‍🎓 Student  → username: ali_student | password: Student@123");

// ============================================
// SEED SAMPLE EXAM WITH QUESTIONS
// ============================================

const seedExam = db.transaction(() => {
  const teacher = db.prepare("SELECT id FROM users WHERE username = 'drkhan'").get();
  if (!teacher) return;

  const examInsert = db.prepare(`
    INSERT OR IGNORE INTO exams (title, subject, exam_code, teacher_id, duration_min, total_marks, pass_marks, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
  `);

  examInsert.run("Software Engineering Mid Term", "Software Engineering", "SE_MID_2024", teacher.id, 30, 10, 4);
  examInsert.run("DBMS Mid Term", "Database Management Systems", "DBMS_MID_2024", teacher.id, 30, 10, 4);
  examInsert.run("Operating Systems Mid Term", "Operating Systems", "OS_MID_2024", teacher.id, 30, 10, 4);

  const seExam = db.prepare("SELECT id FROM exams WHERE exam_code = 'SE_MID_2024'").get();
  const dbExam = db.prepare("SELECT id FROM exams WHERE exam_code = 'DBMS_MID_2024'").get();
  const osExam = db.prepare("SELECT id FROM exams WHERE exam_code = 'OS_MID_2024'").get();

  const qInsert = db.prepare(`
    INSERT OR IGNORE INTO questions (exam_id, question_text, option_a, option_b, option_c, option_d, correct_ans, marks)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  // SE Questions
  if (seExam) {
    const seQs = [
      ["What does SDLC stand for?", "Software Development Life Cycle", "System Data Logic Code", "Server Design Language Compiler", "Software Design Language Code", 0],
      ["Agile methodology is best described as?", "Iterative and incremental model", "A programming language", "A database system", "A hardware specification", 0],
      ["Waterfall model is?", "A sequential software development model", "A type of hardware", "A computer virus", "A compiler design", 0],
      ["Which phase comes first in SDLC?", "Requirement Analysis", "Testing", "Deployment", "Coding", 0],
      ["The purpose of software testing is?", "Finding and fixing bugs", "Design phase", "Planning meetings", "Network setup", 0],
      ["UML stands for?", "Unified Modeling Language", "Universal Machine Language", "User Module Layout", "Unified Memory Layer", 0],
      ["Which model uses sprints?", "Scrum (Agile)", "Waterfall", "V-Model", "Spiral", 0],
      ["SRS document stands for?", "Software Requirements Specification", "System Runtime Script", "Server Resource Summary", "Source Release Sheet", 0],
      ["Black box testing focuses on?", "Input/output without internal knowledge", "Internal code structure", "Database queries", "Network packets", 0],
      ["Coupling in software engineering means?", "Dependency between modules", "Speed of execution", "Memory usage", "Screen resolution", 0],
    ];
    seQs.forEach(q => qInsert.run(seExam.id, ...q));
  }

  // DBMS Questions
  if (dbExam) {
    const dbQs = [
      ["DBMS stands for?", "Database Management System", "Data Basic Model System", "Digital Basic Machine Script", "None of the above", 0],
      ["A primary key must be?", "Unique and not null", "Duplicate allowed", "Can be null", "Any random value", 0],
      ["SQL stands for?", "Structured Query Language", "System Query Layer", "Simple Queue Logic", "Standard Quick Language", 0],
      ["A foreign key is used to?", "Link two tables together", "Speed up CPU", "Allocate memory", "Manage files", 0],
      ["Normalization is done to?", "Reduce data redundancy", "Increase database size", "Delete the database", "Encrypt the OS", 0],
      ["Which SQL command retrieves data?", "SELECT", "INSERT", "DELETE", "UPDATE", 0],
      ["An ERD stands for?", "Entity Relationship Diagram", "External Record Data", "Error Report Document", "Execution Runtime Driver", 0],
      ["ACID in DBMS stands for?", "Atomicity Consistency Isolation Durability", "Add Copy Insert Delete", "Automatic Code Index Driver", "Access Control Identity Domain", 0],
      ["Which join returns all rows from both tables?", "FULL OUTER JOIN", "INNER JOIN", "LEFT JOIN", "CROSS JOIN", 0],
      ["A view in SQL is?", "A virtual table based on a query", "A physical storage file", "An index file", "A backup copy", 0],
    ];
    dbQs.forEach(q => qInsert.run(dbExam.id, ...q));
  }

  // OS Questions
  if (osExam) {
    const osQs = [
      ["Operating System manages?", "Hardware and software resources", "Only games", "Only the internet", "Only compiler", 0],
      ["The kernel is?", "The core of the operating system", "A user application", "A text file", "A virus", 0],
      ["A process is?", "A program in execution", "A static file", "A memory chip", "A CPU model", 0],
      ["CPU scheduling is responsible for?", "Allocating CPU to processes", "Designing UI", "Managing storage", "Network security", 0],
      ["Deadlock occurs when?", "Processes wait for each other indefinitely", "System runs too fast", "Data is backed up", "System is updated", 0],
      ["Virtual memory is?", "Using disk space as extra RAM", "A type of ROM", "A graphics card", "A network card", 0],
      ["Semaphore is used for?", "Process synchronization", "File compression", "Screen resolution", "DNS lookup", 0],
      ["Thrashing in OS means?", "Excessive paging causing slowdown", "Very fast processing", "Data encryption", "Power saving mode", 0],
      ["Round Robin scheduling uses?", "Time quantum/slice", "Priority levels only", "Random selection", "FIFO queue only", 0],
      ["Paging in OS is?", "Dividing memory into fixed-size pages", "Printing documents", "Scanning files", "Network routing", 0],
    ];
    osQs.forEach(q => qInsert.run(osExam.id, ...q));
  }
});

seedExam();
console.log("✅ Sample exams and questions seeded.");
console.log("\n🚀 Database ready! Run: npm start");

db.close();
