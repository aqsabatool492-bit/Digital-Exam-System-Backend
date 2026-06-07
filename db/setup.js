// ============================================
// db/setup.js — PostgreSQL Setup & Seeding
// Run once with: node db/setup.js
// ============================================

require("dotenv").config();
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function setup() {
  const client = await pool.connect();
  console.log("📦 Setting up PostgreSQL database...");

  try {
    // ── CREATE TABLES ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        username    TEXT NOT NULL UNIQUE,
        email       TEXT NOT NULL UNIQUE,
        password    TEXT NOT NULL,
        role        TEXT NOT NULL CHECK(role IN ('student','teacher','admin')),
        full_name   TEXT NOT NULL,
        is_active   INTEGER NOT NULL DEFAULT 1,
        created_at  TIMESTAMP DEFAULT NOW(),
        last_login  TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS exams (
        id           SERIAL PRIMARY KEY,
        title        TEXT NOT NULL,
        subject      TEXT NOT NULL,
        exam_code    TEXT NOT NULL UNIQUE,
        teacher_id   INTEGER NOT NULL REFERENCES users(id),
        duration_min INTEGER NOT NULL DEFAULT 30,
        total_marks  INTEGER NOT NULL DEFAULT 100,
        pass_marks   INTEGER NOT NULL DEFAULT 40,
        status       TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','closed')),
        start_time   TIMESTAMP,
        end_time     TIMESTAMP,
        created_at   TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS questions (
        id            SERIAL PRIMARY KEY,
        exam_id       INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
        question_text TEXT NOT NULL,
        option_a      TEXT NOT NULL,
        option_b      TEXT NOT NULL,
        option_c      TEXT NOT NULL,
        option_d      TEXT NOT NULL,
        correct_ans   INTEGER NOT NULL CHECK(correct_ans IN (0,1,2,3)),
        marks         INTEGER NOT NULL DEFAULT 1,
        created_at    TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS exam_sessions (
        id           SERIAL PRIMARY KEY,
        student_id   INTEGER NOT NULL REFERENCES users(id),
        exam_id      INTEGER NOT NULL REFERENCES exams(id),
        started_at   TIMESTAMP DEFAULT NOW(),
        submitted_at TIMESTAMP,
        status       TEXT NOT NULL DEFAULT 'ongoing' CHECK(status IN ('ongoing','submitted','flagged')),
        score        INTEGER,
        total_marks  INTEGER,
        percentage   REAL,
        result       TEXT CHECK(result IN ('pass','fail',NULL)),
        UNIQUE(student_id, exam_id)
      );

      CREATE TABLE IF NOT EXISTS answers (
        id           SERIAL PRIMARY KEY,
        session_id   INTEGER NOT NULL REFERENCES exam_sessions(id) ON DELETE CASCADE,
        question_id  INTEGER NOT NULL REFERENCES questions(id),
        selected_ans INTEGER CHECK(selected_ans IN (0,1,2,3,NULL)),
        is_correct   INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS cheating_alerts (
        id           SERIAL PRIMARY KEY,
        session_id   INTEGER NOT NULL REFERENCES exam_sessions(id),
        student_id   INTEGER NOT NULL REFERENCES users(id),
        alert_type   TEXT NOT NULL,
        description  TEXT,
        severity     TEXT NOT NULL DEFAULT 'low' CHECK(severity IN ('low','medium','high')),
        timestamp    TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log("✅ Tables created.");

    // ── SEED USERS ──
    const adminPass   = bcrypt.hashSync(process.env.ADMIN_PASSWORD || "Admin@1234", 10);
    const teacherPass = bcrypt.hashSync("Teacher@123", 10);
    const studentPass = bcrypt.hashSync("Student@123", 10);

    const users = [
      ["admin",          "admin@examportal.com",    adminPass,   "admin",   "System Administrator"],
      ["drkhan",         "drkhan@examportal.com",   teacherPass, "teacher", "Dr. Khan"],
      ["profayesha",     "ayesha@examportal.com",   teacherPass, "teacher", "Prof. Ayesha"],
      ["ali_student",    "ali@student.com",          studentPass, "student", "Ali Ahmed"],
      ["sara_student",   "sara@student.com",         studentPass, "student", "Sara Khan"],
      ["usman_student",  "usman@student.com",        studentPass, "student", "Usman Malik"],
      ["ayesha_student", "ayesha_s@student.com",     studentPass, "student", "Ayesha Raza"],
    ];

    for (const [username, email, password, role, full_name] of users) {
      await client.query(`
        INSERT INTO users (username, email, password, role, full_name)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (username) DO NOTHING
      `, [username, email, password, role, full_name]);
    }

    console.log("✅ Default users seeded.");
    console.log("   👤 Admin    → username: admin       | password: Admin@1234");
    console.log("   👨‍🏫 Teacher  → username: drkhan      | password: Teacher@123");
    console.log("   👨‍🎓 Student  → username: ali_student | password: Student@123");

    // ── SEED EXAMS ──
    const teacher = await client.query("SELECT id FROM users WHERE username = 'drkhan'");
    const teacherId = teacher.rows[0].id;

    const exams = [
      ["Software Engineering Mid Term", "Software Engineering", "SE_MID_2024", teacherId, 30, 10, 4],
      ["DBMS Mid Term", "Database Management Systems", "DBMS_MID_2024", teacherId, 30, 10, 4],
      ["Operating Systems Mid Term", "Operating Systems", "OS_MID_2024", teacherId, 30, 10, 4],
    ];

    for (const [title, subject, exam_code, tid, duration_min, total_marks, pass_marks] of exams) {
      await client.query(`
        INSERT INTO exams (title, subject, exam_code, teacher_id, duration_min, total_marks, pass_marks, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'active')
        ON CONFLICT (exam_code) DO NOTHING
      `, [title, subject, exam_code, tid, duration_min, total_marks, pass_marks]);
    }

    // ── SEED QUESTIONS ──
    const seExam  = await client.query("SELECT id FROM exams WHERE exam_code='SE_MID_2024'");
    const dbExam  = await client.query("SELECT id FROM exams WHERE exam_code='DBMS_MID_2024'");
    const osExam  = await client.query("SELECT id FROM exams WHERE exam_code='OS_MID_2024'");

    const addQ = async (examId, qs) => {
      for (const [qt, a, b, c, d, ans] of qs) {
        await client.query(`
          INSERT INTO questions (exam_id,question_text,option_a,option_b,option_c,option_d,correct_ans,marks)
          VALUES ($1,$2,$3,$4,$5,$6,$7,1)
        `, [examId, qt, a, b, c, d, ans]);
      }
    };

    if (seExam.rows.length) {
      await addQ(seExam.rows[0].id, [
        ["What does SDLC stand for?","Software Development Life Cycle","System Data Logic Code","Server Design Language","Software Design Code",0],
        ["Agile methodology is?","Iterative and incremental model","A programming language","A database system","A hardware spec",0],
        ["Waterfall model is?","A sequential development model","A type of hardware","A computer virus","A compiler",0],
        ["Which phase comes first in SDLC?","Requirement Analysis","Testing","Deployment","Coding",0],
        ["Purpose of software testing?","Finding and fixing bugs","Design phase","Planning meetings","Network setup",0],
        ["UML stands for?","Unified Modeling Language","Universal Machine Language","User Module Layout","Unified Memory Layer",0],
        ["Which model uses sprints?","Scrum (Agile)","Waterfall","V-Model","Spiral",0],
        ["SRS document stands for?","Software Requirements Specification","System Runtime Script","Server Resource Summary","Source Release Sheet",0],
        ["Black box testing focuses on?","Input/output without internal knowledge","Internal code structure","Database queries","Network packets",0],
        ["Coupling means?","Dependency between modules","Speed of execution","Memory usage","Screen resolution",0],
      ]);
    }

    if (dbExam.rows.length) {
      await addQ(dbExam.rows[0].id, [
        ["DBMS stands for?","Database Management System","Data Basic Model System","Digital Basic Machine","None of above",0],
        ["A primary key must be?","Unique and not null","Duplicate allowed","Can be null","Any random value",0],
        ["SQL stands for?","Structured Query Language","System Query Layer","Simple Queue Logic","Standard Quick Language",0],
        ["A foreign key is used to?","Link two tables","Speed up CPU","Allocate memory","Manage files",0],
        ["Normalization is done to?","Reduce data redundancy","Increase database size","Delete database","Encrypt OS",0],
        ["Which SQL command retrieves data?","SELECT","INSERT","DELETE","UPDATE",0],
        ["ERD stands for?","Entity Relationship Diagram","External Record Data","Error Report Document","Execution Runtime Driver",0],
        ["ACID stands for?","Atomicity Consistency Isolation Durability","Add Copy Insert Delete","Automatic Code Index Driver","Access Control Identity",0],
        ["Which join returns all rows from both tables?","FULL OUTER JOIN","INNER JOIN","LEFT JOIN","CROSS JOIN",0],
        ["A view in SQL is?","A virtual table based on query","A physical storage file","An index file","A backup copy",0],
      ]);
    }

    if (osExam.rows.length) {
      await addQ(osExam.rows[0].id, [
        ["Operating System manages?","Hardware and software resources","Only games","Only internet","Only compiler",0],
        ["The kernel is?","Core of the operating system","A user application","A text file","A virus",0],
        ["A process is?","A program in execution","A static file","A memory chip","A CPU model",0],
        ["CPU scheduling is responsible for?","Allocating CPU to processes","Designing UI","Managing storage","Network security",0],
        ["Deadlock occurs when?","Processes wait indefinitely","System runs too fast","Data is backed up","System updated",0],
        ["Virtual memory is?","Using disk space as extra RAM","A type of ROM","A graphics card","A network card",0],
        ["Semaphore is used for?","Process synchronization","File compression","Screen resolution","DNS lookup",0],
        ["Thrashing means?","Excessive paging causing slowdown","Very fast processing","Data encryption","Power saving",0],
        ["Round Robin scheduling uses?","Time quantum/slice","Priority levels only","Random selection","FIFO only",0],
        ["Paging in OS is?","Dividing memory into fixed pages","Printing documents","Scanning files","Network routing",0],
      ]);
    }

    console.log("✅ Sample exams and questions seeded.");
    console.log("\n🚀 PostgreSQL Database ready!");

  } catch (err) {
    console.error("❌ Setup error:", err.message);
  } finally {
    client.release();
    await pool.end();
  }
}

setup();
