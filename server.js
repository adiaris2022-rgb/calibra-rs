// Railway redeploy trigger: chronological Work Order timeline is deployed from main.
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const { Pool } = require("pg");
const QRCode = require("qrcode");
const crypto = require("crypto");
const app = express();
const PORT = process.env.PORT || 3000;

const AUTH_SECRET = process.env.CALIBRA_AUTH_SECRET || process.env.DATABASE_URL || "calibra-demo-secret-change-in-production";
const AUTH_TTL_SECONDS = 12 * 60 * 60;
const REQUIRE_TENANT = process.env.CALIBRA_REQUIRE_TENANT !== "false";
const ADMIN_RS_ROLE = "PENANGGUNG JAWAB";

const AUTH_USERS = {
  direksi: { password: process.env.CALIBRA_DIREKSI_PASSWORD || "calibra123", name: "Direksi", role: "DIREKSI", hospitalId: process.env.CALIBRA_DEMO_HOSPITAL_ID || null },
  pj: { password: process.env.CALIBRA_PJ_PASSWORD || "calibra123", name: "Penanggung Jawab", role: "PENANGGUNG JAWAB", hospitalId: process.env.CALIBRA_DEMO_HOSPITAL_ID || null },
  petugas: { password: process.env.CALIBRA_PETUGAS_PASSWORD || "calibra123", name: "Petugas Lapangan", role: "PETUGAS LAPANGAN", hospitalId: process.env.CALIBRA_DEMO_HOSPITAL_ID || null }
};

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function signToken(payload) {
  const body = base64Url(JSON.stringify(payload));
  const signature = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
  return body + "." + signature;
}

function verifyToken(token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = crypto.createHmac("sha256", AUTH_SECRET).update(body).digest("base64url");
  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

async function requireAuth(req, res, next) {
  if (req.path === "/health" || req.path === "/login") return next();
  const header = clean(req.headers.authorization || "");
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  const user = verifyToken(token);
  if (!user) {
    return res.status(401).json({ ok: false, error: "Sesi tidak valid atau sudah berakhir. Silakan login kembali." });
  }
  if (user.hospitalId) req.hospitalId = Number(user.hospitalId);
  if (pool && dbReady && user.username) {
    try {
      const r = await pool.query("SELECT status, hospital_id FROM users WHERE LOWER(username)=LOWER($1) LIMIT 1", [user.username]);
      if (r.rows.length) {
        if (r.rows[0].status !== "ACTIVE") return res.status(401).json({ok:false,error:"Akun tidak aktif. Silakan hubungi Admin IPSRS."});
        if (r.rows[0].hospital_id) req.hospitalId = Number(r.rows[0].hospital_id);
      }
    } catch (error) { console.error("Session user check gagal:",error.message); }
  }
  req.user = {...user,hospitalId:req.hospitalId||user.hospitalId||null};
  next();
}

function requireTenant(req, res, next) {
  // Railway healthchecks must remain public and tenant-independent.
  if (req.path === "/health") return next();
  if (REQUIRE_TENANT && !req.hospitalId) {
    return res.status(403).json({
      ok: false,
      error: "Hospital tenant belum ditetapkan untuk akun ini."
    });
  }
  next();
}

function requireRole(...roles) {
  return function(req, res, next) {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ ok: false, error: "Akses tidak diizinkan untuk peran ini." });
    }
    next();
  };
}

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

app.use("/api", requireAuth);
app.use("/api", requireTenant);

// Pastikan browser selalu mengambil frontend terbaru.
app.use(express.static(__dirname, {
  setHeaders: function(res, filePath) {
    if (filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
      res.setHeader("Pragma", "no-cache");
      res.setHeader("Expires", "0");
    }
  }
}));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 1,
    fields: 20,
    parts: 25,
    fieldSize: 64 * 1024,
    fieldNameSize: 100,
    fieldArrayIndexLimit: 100
  }
});

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 5000
    })
  : null;

let dbReady = false;

function clean(v) {
  return String(v ?? "").trim();
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, storedHash, salt) {
  if (!storedHash || !salt) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function isRsAdmin(user) {
  return !!user && user.role === ADMIN_RS_ROLE;
}

function dateValue(v) {
  if (!v) return null;

  if (v instanceof Date && !isNaN(v)) {
    return v.toISOString().slice(0, 10);
  }

  if (typeof v === "number") {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) {
      return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
    }
  }

  const text = clean(v);
  const d = new Date(text);

  if (!isNaN(d)) {
    return d.toISOString().slice(0, 10);
  }

  return null;
}

function value(row, names) {
  const keys = Object.keys(row);

  for (const name of names) {
    const key = keys.find(
      k => k.toLowerCase().replace(/[\s_\-]/g, "") ===
           name.toLowerCase().replace(/[\s_\-]/g, "")
    );

    if (key && clean(row[key])) return row[key];
  }

  return "";
}

function mapRow(row, number) {
  return {
    rowNumber: number + 2,
    assetCode: clean(value(row, [
      "Kode Aset", "Kode Asset", "Kode Alat", "Kode"
    ])),
    name: clean(value(row, [
      "Nama Alat", "Nama Peralatan", "Nama"
    ])),
    brand: clean(value(row, [
      "Merk", "Merek", "Brand"
    ])),
    model: clean(value(row, [
      "Model", "Tipe", "Type"
    ])),
    serialNumber: clean(value(row, [
      "Nomor Seri", "No Seri", "Serial Number"
    ])),
    room: clean(value(row, [
      "Ruangan", "Ruang", "Lokasi", "Room"
    ])),
    calibrationDate: dateValue(value(row, [
      "Tanggal Kalibrasi", "Tgl Kalibrasi", "Calibration Date"
    ])),
    dueDate: dateValue(value(row, [
      "Jatuh Tempo", "Tanggal Jatuh Tempo", "Due Date"
    ]))
  };
}

async function initDb() {
  if (!pool) return;

  // 1) Base tenant + identity tables.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS hospitals (
      id SERIAL PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
      address TEXT, city TEXT, phone TEXT, email TEXT,
      logo_mime TEXT, logo_data BYTEA,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id) ON DELETE CASCADE,
      username TEXT UNIQUE NOT NULL, email TEXT, password_hash TEXT NOT NULL, password_salt TEXT NOT NULL,
      name TEXT NOT NULL, role TEXT NOT NULL, department TEXT, status TEXT DEFAULT 'ACTIVE',
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(), last_login_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS equipment (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id), asset_code TEXT NOT NULL, name TEXT NOT NULL,
      brand TEXT, model TEXT, serial_number TEXT, room TEXT, calibration_date DATE, due_date DATE,
      condition TEXT DEFAULT 'BAIK', created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(hospital_id, asset_code)
    );
    CREATE TABLE IF NOT EXISTS equipment_identifiers (
      id SERIAL PRIMARY KEY, equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      identifier_type TEXT NOT NULL, identifier_value TEXT NOT NULL, source TEXT DEFAULT 'CALIBRA',
      created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(equipment_id, identifier_type, identifier_value)
    );
    CREATE TABLE IF NOT EXISTS calibrations (
      id SERIAL PRIMARY KEY, equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      calibration_date DATE, due_date DATE, status TEXT, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS inspections (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id),
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE, condition TEXT, findings TEXT,
      inspected_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS field_reports (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id),
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE, report TEXT NOT NULL,
      status TEXT DEFAULT 'OPEN', created_at TIMESTAMPTZ DEFAULT NOW(), officer_username TEXT
    );
    CREATE TABLE IF NOT EXISTS evidence_files (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id),
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      report_id INTEGER REFERENCES field_reports(id) ON DELETE CASCADE, original_name TEXT,
      mime_type TEXT NOT NULL, file_size INTEGER, file_data BYTEA NOT NULL,
      evidence_type TEXT DEFAULT 'ORIGINAL', created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id),
      action TEXT NOT NULL, details JSONB, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS actions (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id),
      report_id INTEGER REFERENCES field_reports(id) ON DELETE CASCADE,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE, title TEXT NOT NULL,
      description TEXT, assigned_to TEXT, status TEXT DEFAULT 'NEW', created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS action_status_history (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id),
      action_id INTEGER REFERENCES actions(id) ON DELETE CASCADE, from_status TEXT,
      to_status TEXT NOT NULL, changed_by TEXT, changed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS certificate_files (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id),
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE, original_name TEXT,
      mime_type TEXT NOT NULL, file_size INTEGER, file_data BYTEA NOT NULL, uploaded_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY, hospital_id INTEGER REFERENCES hospitals(id),
      recipient_role TEXT, recipient_username TEXT, title TEXT NOT NULL, message TEXT NOT NULL,
      is_read BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  // 2) Forward-compatible columns for databases created by older CALIBRA versions.
  await pool.query(`ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS address TEXT`);
  await pool.query(`ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS city TEXT`);
  await pool.query(`ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS phone TEXT`);
  await pool.query(`ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS email TEXT`);
  await pool.query(`ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS logo_mime TEXT`);
  await pool.query(`ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS logo_data BYTEA`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS department TEXT`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'ACTIVE'`);
  await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`);
  await pool.query(`ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE inspections ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE field_reports ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE evidence_files ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE actions ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE action_status_history ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE certificate_files ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE calibrations ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE equipment_identifiers ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);
  await pool.query(`ALTER TABLE notifications ADD COLUMN IF NOT EXISTS hospital_id INTEGER REFERENCES hospitals(id)`);

  // 3) Ensure demo tenant exists before assigning legacy rows.
  await pool.query(`
    INSERT INTO hospitals (code,name) VALUES ('RS-DEMO','Rumah Sakit Demo')
    ON CONFLICT (code) DO NOTHING
  `);
  const demoHospital=await pool.query(`SELECT id FROM hospitals WHERE code='RS-DEMO' LIMIT 1`);
  const hid=demoHospital.rows[0]?.id||null;
  if(hid) await pool.query(`UPDATE equipment SET hospital_id=$1 WHERE hospital_id IS NULL`,[hid]);

  // 4) Backfill tenant ownership now that every referenced table exists.
  await pool.query(`UPDATE inspections i SET hospital_id=e.hospital_id FROM equipment e WHERE i.equipment_id=e.id AND i.hospital_id IS NULL`);
  await pool.query(`UPDATE field_reports r SET hospital_id=e.hospital_id FROM equipment e WHERE r.equipment_id=e.id AND r.hospital_id IS NULL`);
  await pool.query(`UPDATE evidence_files ev SET hospital_id=e.hospital_id FROM equipment e WHERE ev.equipment_id=e.id AND ev.hospital_id IS NULL`);
  await pool.query(`UPDATE actions a SET hospital_id=e.hospital_id FROM equipment e WHERE a.equipment_id=e.id AND a.hospital_id IS NULL`);
  await pool.query(`UPDATE action_status_history h SET hospital_id=a.hospital_id FROM actions a WHERE h.action_id=a.id AND h.hospital_id IS NULL`);
  await pool.query(`UPDATE certificate_files c SET hospital_id=e.hospital_id FROM equipment e WHERE c.equipment_id=e.id AND c.hospital_id IS NULL`);
  await pool.query(`UPDATE calibrations c SET hospital_id=e.hospital_id FROM equipment e WHERE c.equipment_id=e.id AND c.hospital_id IS NULL`);
  await pool.query(`UPDATE equipment_identifiers i SET hospital_id=e.hospital_id FROM equipment e WHERE i.equipment_id=e.id AND i.hospital_id IS NULL`);

  // 5) Seed/repair demo users.
  if(hid){
    const demoUsers=[
      {username:"direksi",email:"direksi@rs-demo.local",name:"Direksi",role:"DIREKSI",department:"Manajemen",password:process.env.CALIBRA_DIREKSI_PASSWORD||"calibra123"},
      {username:"pj",email:"ipsrs@rs-demo.local",name:"Admin IPSRS / Penanggung Jawab",role:"PENANGGUNG JAWAB",department:"IPSRS",password:process.env.CALIBRA_PJ_PASSWORD||"calibra123"},
      {username:"petugas",email:"petugas@rs-demo.local",name:"Petugas Lapangan",role:"PETUGAS LAPANGAN",department:"IPSRS",password:process.env.CALIBRA_PETUGAS_PASSWORD||"calibra123"}
    ];
    for(const u of demoUsers){
      const ex=await pool.query(`SELECT id FROM users WHERE username=$1 LIMIT 1`,[u.username]);
      if(!ex.rows.length){
        const hp=hashPassword(u.password);
        await pool.query(`INSERT INTO users(hospital_id,username,email,password_hash,password_salt,name,role,department,status)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE')`,[hid,u.username,u.email,hp.hash,hp.salt,u.name,u.role,u.department]);
      }
    }
  }

  // 6) Seed one demo work order only if no work order exists, and keep its tenant explicit.
  if(hid){
    await pool.query(`
      INSERT INTO actions(hospital_id,report_id,equipment_id,title,description,assigned_to,status,created_by)
      SELECT $1,fr.id,fr.equipment_id,'Pemeriksaan Patient Monitor',
             'Periksa alarm dan lakukan troubleshooting.','Teknisi IPSRS','NEW','pj'
      FROM field_reports fr JOIN equipment e ON e.id=fr.equipment_id
      WHERE e.hospital_id=$1 AND e.asset_code='ICU-101' AND NOT EXISTS(SELECT 1 FROM actions)
      ORDER BY fr.created_at DESC LIMIT 1
    `,[hid]);
    await pool.query(`
      INSERT INTO action_status_history(hospital_id,action_id,from_status,to_status,changed_by,changed_at)
      SELECT a.hospital_id,a.id,NULL,a.status,COALESCE(a.created_by,''),a.created_at
      FROM actions a
      WHERE NOT EXISTS(SELECT 1 FROM action_status_history h WHERE h.action_id=a.id)
    `);
  }

  dbReady=true;
  console.log("Database siap");
}

function needDb(res) {
  if (!pool || !dbReady) {
    res.status(503).json({
      ok: false,
      error: "Database sedang disiapkan."
    });
    return false;
  }

  return true;
}

async function writeAudit(action, details, actor, hospitalId) {
  if (!pool || !dbReady) return;
  try {
    await pool.query(`INSERT INTO audit_logs (hospital_id, action, details) VALUES ($1,$2,$3)`,
      [hospitalId || null, clean(action), JSON.stringify({ ...(details || {}), actor: clean(actor || "") })]);
  } catch (error) { console.error("Audit log gagal:", error.message); }
}

async function notify(recipientRole, recipientUsername, title, message, hospitalId) {
  if (!pool || !dbReady) return;
  try {
    await pool.query(`INSERT INTO notifications (hospital_id, recipient_role, recipient_username, title, message) VALUES ($1,$2,$3,$4,$5)`,
      [hospitalId || null, clean(recipientRole), clean(recipientUsername), clean(title), clean(message)]);
  } catch (error) { console.error("Notification gagal:", error.message); }
}

/* AUTH */
app.post("/api/login", async (req, res) => {
  const username = clean(req.body?.username).toLowerCase();
  const password = String(req.body?.password || "");
  let account = null;

  if (pool && dbReady) {
    try {
      const result = await pool.query(`
        SELECT id, username, email, password_hash, password_salt, name, role, hospital_id, department, status
        FROM users WHERE LOWER(username) = $1 LIMIT 1
      `, [username]);
      const u = result.rows[0];
      if (u && u.status === "ACTIVE" && verifyPassword(password, u.password_hash, u.password_salt)) {
        account = { id:u.id, username:u.username, email:u.email, name:u.name, role:u.role, hospitalId:u.hospital_id, department:u.department };
        await pool.query(`UPDATE users SET last_login_at = NOW() WHERE id = $1`, [u.id]);
      }
    } catch (error) {
      console.error("DB login gagal:", error.message);
    }
  }

  if (!account) {
    const demo = AUTH_USERS[username];
    if (!demo || demo.password !== password) {
      return res.status(401).json({ ok: false, error: "Username atau password salah." });
    }
    account = { username, name: demo.name, role: demo.role, hospitalId: demo.hospitalId || null, department: null };
  }

  const now = Math.floor(Date.now() / 1000);
  const token = signToken({
    username: account.username, name: account.name, role: account.role,
    hospitalId: account.hospitalId, department: account.department,
    iat: now, exp: now + AUTH_TTL_SECONDS
  });

  res.json({ ok:true, token, user:account, expiresAt:new Date((now + AUTH_TTL_SECONDS)*1000).toISOString() });
});

/* IDENTITY / USER & HOSPITAL SETTINGS */
app.get("/api/me", async (req,res)=>{
  if(!pool || !dbReady) return res.status(503).json({ok:false,error:"Database belum siap."});
  try{
    const r=await pool.query(`
      SELECT u.id,u.username,u.email,u.name,u.role,u.department,u.status,u.last_login_at,
             h.id AS hospital_id,h.code AS hospital_code,h.name AS hospital_name,h.address,h.city,h.phone,h.email AS hospital_email,
             CASE WHEN h.logo_data IS NOT NULL THEN '/api/hospital/logo' ELSE NULL END AS logo_url
      FROM users u LEFT JOIN hospitals h ON h.id=u.hospital_id
      WHERE u.username=$1 LIMIT 1`,[req.user.username]);
    if(!r.rows.length) return res.status(404).json({ok:false,error:"User tidak ditemukan."});
    res.json({ok:true,user:r.rows[0]});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.patch("/api/me/password", async (req,res)=>{
  if(!pool || !dbReady) return res.status(503).json({ok:false,error:"Database belum siap."});
  const current=String(req.body?.currentPassword||""), next=String(req.body?.newPassword||"");
  if(next.length<8) return res.status(400).json({ok:false,error:"Password baru minimal 8 karakter."});
  try{
    const r=await pool.query(`SELECT id,password_hash,password_salt FROM users WHERE username=$1 LIMIT 1`,[req.user.username]);
    const u=r.rows[0];
    if(!u || !verifyPassword(current,u.password_hash,u.password_salt)) return res.status(400).json({ok:false,error:"Password saat ini salah."});
    const hp=hashPassword(next);
    await pool.query(`UPDATE users SET password_hash=$1,password_salt=$2,updated_at=NOW() WHERE id=$3`,[hp.hash,hp.salt,u.id]);
    await writeAudit("CHANGE_PASSWORD",{username:req.user.username},req.user.username,req.hospitalId);
    res.json({ok:true,message:"Password berhasil diubah."});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.get("/api/hospital", async (req,res)=>{
  if(!pool || !dbReady) return res.status(503).json({ok:false,error:"Database belum siap."});
  try{
    const r=await pool.query(`SELECT id,code,name,address,city,phone,email,logo_mime,CASE WHEN logo_data IS NOT NULL THEN encode(logo_data,'base64') ELSE NULL END AS logo_base64 FROM hospitals WHERE id=$1 LIMIT 1`,[req.hospitalId||0]);
    if(!r.rows.length) return res.status(404).json({ok:false,error:"Rumah sakit tidak ditemukan."});
    res.json({ok:true,hospital:r.rows[0]});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.patch("/api/hospital", requireRole("PENANGGUNG JAWAB"), async (req,res)=>{
  if(!pool || !dbReady) return res.status(503).json({ok:false,error:"Database belum siap."});
  const {name,code,address,city,phone,email}=req.body||{};
  if(!clean(name)) return res.status(400).json({ok:false,error:"Nama rumah sakit wajib diisi."});
  try{
    const r=await pool.query(`UPDATE hospitals SET name=$1,code=$2,address=$3,city=$4,phone=$5,email=$6,updated_at=NOW() WHERE id=$7 RETURNING id,code,name,address,city,phone,email`,[clean(name),clean(code)||"RS-DEMO",clean(address),clean(city),clean(phone),clean(email),req.hospitalId||0]);
    if(!r.rows.length) return res.status(404).json({ok:false,error:"Rumah sakit tidak ditemukan."});
    await writeAudit("UPDATE_HOSPITAL",r.rows[0],req.user.username,req.hospitalId);
    res.json({ok:true,hospital:r.rows[0]});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post("/api/hospital/logo", requireRole("PENANGGUNG JAWAB"), upload.single("logo"), async (req,res)=>{
  if(!pool || !dbReady) return res.status(503).json({ok:false,error:"Database belum siap."});
  if(!req.file) return res.status(400).json({ok:false,error:"Logo belum dipilih."});
  if(!["image/png","image/jpeg","image/webp"].includes(req.file.mimetype)) return res.status(400).json({ok:false,error:"Logo harus PNG, JPG, atau WebP."});
  if(req.file.size>2*1024*1024) return res.status(400).json({ok:false,error:"Ukuran logo maksimal 2 MB."});
  try{
    await pool.query(`UPDATE hospitals SET logo_mime=$1,logo_data=$2,updated_at=NOW() WHERE id=$3`,[req.file.mimetype,req.file.buffer,req.hospitalId||0]);
    await writeAudit("UPDATE_HOSPITAL_LOGO",{mime:req.file.mimetype,size:req.file.size},req.user.username,req.hospitalId);
    res.json({ok:true,logoUrl:"/api/hospital/logo?t="+Date.now()});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.get("/api/hospital/logo", async (req,res)=>{
  if(!pool || !dbReady) return res.status(404).end();
  try{
    const r=await pool.query(`SELECT logo_mime,logo_data FROM hospitals WHERE id=$1 LIMIT 1`,[req.hospitalId||0]);
    if(!r.rows.length || !r.rows[0].logo_data) return res.status(404).end();
    res.setHeader("Content-Type",r.rows[0].logo_mime||"image/png"); res.setHeader("Cache-Control","no-store"); res.end(r.rows[0].logo_data);
  }catch(error){res.status(500).end();}
});

app.get("/api/users", requireRole("PENANGGUNG JAWAB"), async (req,res)=>{
  if(!pool || !dbReady) return res.status(503).json({ok:false,error:"Database belum siap."});
  try{
    const r=await pool.query(`SELECT id,username,email,name,role,department,status,last_login_at,created_at FROM users WHERE hospital_id=$1 ORDER BY name`,[req.hospitalId||0]);
    res.json({ok:true,users:r.rows});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.post("/api/users", requireRole("PENANGGUNG JAWAB"), async (req,res)=>{
  if(!pool || !dbReady) return res.status(503).json({ok:false,error:"Database belum siap."});
  const {username,email,name,role,department,password}=req.body||{};
  if(!clean(username)||!clean(name)||!clean(role)||String(password||"").length<8) return res.status(400).json({ok:false,error:"Username, nama, role, dan password minimal 8 karakter wajib diisi."});
  const allowed=["DIREKSI","PENANGGUNG JAWAB","PETUGAS LAPANGAN","TEKNISI"];
  if(!allowed.includes(role)) return res.status(400).json({ok:false,error:"Role tidak valid."});
  try{
    const hp=hashPassword(password);
    const r=await pool.query(`INSERT INTO users(hospital_id,username,email,password_hash,password_salt,name,role,department,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ACTIVE') RETURNING id,username,email,name,role,department,status`,[req.hospitalId||0,clean(username).toLowerCase(),clean(email),hp.hash,hp.salt,clean(name),role,clean(department)]);
    await writeAudit("CREATE_USER",{username:clean(username).toLowerCase(),role},req.user.username,req.hospitalId);
    res.json({ok:true,user:r.rows[0]});
  }catch(error){res.status(400).json({ok:false,error:error.message});}
});

app.patch("/api/users/:id/status", requireRole("PENANGGUNG JAWAB"), async (req,res)=>{
  if(!pool || !dbReady) return res.status(503).json({ok:false,error:"Database belum siap."});
  const status=clean(req.body?.status).toUpperCase();
  if(!["ACTIVE","DISABLED"].includes(status)) return res.status(400).json({ok:false,error:"Status tidak valid."});
  try{
    const r=await pool.query(`UPDATE users SET status=$1,updated_at=NOW() WHERE id=$2 AND hospital_id=$3 RETURNING id,username,status`,[status,Number(req.params.id),req.hospitalId||0]);
    if(!r.rows.length) return res.status(404).json({ok:false,error:"User tidak ditemukan."});
    await writeAudit("UPDATE_USER_STATUS",r.rows[0],req.user.username,req.hospitalId);
    res.json({ok:true,user:r.rows[0]});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

/* HEALTHCHECK RAILWAY */
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "CALIBRA RS",
    message: "Server sedang berjalan"
  });
});

/* DATABASE HEALTH */
app.get("/api/health/db", async (req, res) => {
  if (!pool) {
    return res.status(503).json({
      ok: false,
      database: false
    });
  }

  try {
    await pool.query("SELECT 1");

    res.json({
      ok: true,
      database: true,
      initialized: dbReady
    });
  } catch (error) {
    res.status(503).json({
      ok: false,
      database: false,
      error: error.message
    });
  }
});

/* DASHBOARD */
app.get("/api/dashboard", async (req, res) => {
  if (!pool || !dbReady) {
    return res.json({
      equipment: 1248,
      valid: 1103,
      nearDue: 87,
      expired: 58,
      openFindings: 12,
      database: false
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS equipment,
        COUNT(*) FILTER (
          WHERE due_date >= CURRENT_DATE + INTERVAL '31 days'
        )::int AS valid,
        COUNT(*) FILTER (
          WHERE due_date >= CURRENT_DATE
          AND due_date < CURRENT_DATE + INTERVAL '31 days'
        )::int AS near_due,
        COUNT(*) FILTER (
          WHERE due_date < CURRENT_DATE
        )::int AS expired,
        (SELECT COUNT(*)::int FROM field_reports WHERE status = 'OPEN' AND hospital_id = $1) AS open_findings,
        (SELECT COUNT(*)::int FROM actions WHERE status NOT IN ('CLOSED') AND hospital_id = $1) AS open_actions
      FROM equipment
      WHERE hospital_id = $1
    `,[req.hospitalId||0]);

    const r = result.rows[0];

    res.json({
      equipment: r.equipment,
      valid: r.valid,
      nearDue: r.near_due,
      expired: r.expired,
      openFindings: r.open_findings,
      openActions: r.open_actions,
      database: true
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* DAFTAR ALAT */
app.get("/api/equipment", async (req, res) => {
  if (!needDb(res)) return;

  try {
    const result = await pool.query(`
      SELECT *,
        CASE
          WHEN due_date IS NULL THEN 'UNKNOWN'
          WHEN due_date < CURRENT_DATE THEN 'EXPIRED'
          WHEN due_date < CURRENT_DATE + INTERVAL '31 days'
            THEN 'NEAR_DUE'
          ELSE 'VALID'
        END AS calibration_status
      FROM equipment
      WHERE hospital_id = COALESCE($1::int, hospital_id)
      ORDER BY id DESC
      LIMIT 500
    `, [req.hospitalId || null]);

    res.json({
      ok: true,
      equipment: result.rows
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* PREVIEW EXCEL */
app.post("/api/import-excel/preview", requireRole("PENANGGUNG JAWAB"), upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "File Excel belum dipilih."
    });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, {
      type: "buffer",
      cellDates: true
    });

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: ""
    });

    const mapped = rows.map(mapRow);

    const codes = new Set();
    const duplicates = [];

    for (const item of mapped) {
      if (codes.has(item.assetCode) && item.assetCode) {
        duplicates.push(item.assetCode);
      }
      codes.add(item.assetCode);
    }

    res.json({
      ok: true,
      totalRows: mapped.length,
      validRows: mapped.filter(x => x.assetCode && x.name).length,
      duplicates,
      rows: mapped.slice(0, 100)
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error.message
    });
  }
});

/* CONFIRM IMPORT EXCEL */
app.post("/api/import-excel/confirm", requireRole("PENANGGUNG JAWAB"), upload.single("file"), async (req, res) => {
  if (!needDb(res)) return;

  if (!req.file) {
    return res.status(400).json({
      ok: false,
      error: "File Excel belum dipilih."
    });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, {
      type: "buffer",
      cellDates: true
    });

    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, {
      defval: ""
    });

    const hospital = await pool.query(
      "SELECT id FROM hospitals WHERE id = $1",
      [req.hospitalId||0]
    );

    const hospitalId = hospital.rows[0].id;

    let imported = 0;
    let skipped = 0;

    for (const raw of rows) {
      const item = mapRow(raw, imported + skipped);

      if (!item.assetCode || !item.name) {
        skipped++;
        continue;
      }

      const result = await pool.query(`
        INSERT INTO equipment (
          hospital_id,
          asset_code,
          name,
          brand,
          model,
          serial_number,
          room,
          calibration_date,
          due_date,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
   ON CONFLICT (hospital_id, asset_code)
DO NOTHING
RETURNING id
          
      `, [
        hospitalId,
        item.assetCode,
        item.name,
        item.brand || null,
        item.model || null,
        item.serialNumber || null,
        item.room || null,
        item.calibrationDate || null,
        item.dueDate || null
      ]);
if (!result.rows.length) {
  skipped++;
  continue;
}
      const equipmentId = result.rows[0].id;

      await pool.query(`
        INSERT INTO calibrations (
          hospital_id,
          equipment_id,
          calibration_date,
          due_date,
          status
        )
        VALUES ($1,$2,$3,$4,$5)
      `, [
        req.hospitalId||0,
        equipmentId,
        item.calibrationDate || null,
        item.dueDate || null,
        item.dueDate && new Date(item.dueDate) < new Date()
          ? "EXPIRED"
          : "VALID"
      ]);

      imported++;
    }

    res.json({
      ok: true,
      imported,
      skipped,
      message: `${imported} data alat berhasil masuk.`
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
/* QR: GET BY ASSET CODE */
app.get("/api/equipment/:code/qr", async (req, res) => {
  if (!needDb(res)) return;

  const code = clean(req.params.code);

  if (!code) {
    return res.status(400).json({
      ok: false,
      error: "Kode alat wajib diisi."
    });
  }

  try {
    const result = await pool.query(
      `SELECT id, asset_code, name
       FROM equipment
       WHERE asset_code = $1 AND hospital_id = $2
       LIMIT 1`,
      [code,req.hospitalId||0]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Alat dengan kode tersebut tidak ditemukan."
      });
    }

    const equipment = result.rows[0];

    const qrData = JSON.stringify({
      app: "CALIBRA RS",
      equipmentId: equipment.id,
      assetCode: equipment.asset_code
    });

    const qr = await QRCode.toDataURL(qrData);

    res.json({
      ok: true,
      id: equipment.id,
      code: equipment.asset_code,
      name: equipment.name,
      qr
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
/* QR: INTEGRATE / GENERATE / COMPANION */
app.post("/api/equipment/:id/qr", requireRole("PENANGGUNG JAWAB"), async (req, res) => {
  if (!needDb(res)) return;

  const id = Number(req.params.id);
  const mode = clean(req.body?.mode || "GENERATE").toUpperCase();
  let identifier = clean(req.body?.identifierValue);

  try {
    const equipment = await pool.query(
      "SELECT id, asset_code, name FROM equipment WHERE id = $1 AND hospital_id = $2",
      [id,req.hospitalId||0]
    );

    if (!equipment.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Alat tidak ditemukan."
      });
    }

    if (mode !== "INTEGRATE") {
      identifier = identifier || `CALIBRA-${id}-${Date.now()}`;
    }

    if (!identifier) {
      return res.status(400).json({
        ok: false,
        error: "Identifier wajib diisi."
      });
    }

    const type =
      mode === "INTEGRATE"
        ? "HOSPITAL_QR"
        : "CALIBRA_QR";

    await pool.query(`
      INSERT INTO equipment_identifiers (
        hospital_id,
        equipment_id,
        identifier_type,
        identifier_value,
        source
      )
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING
    `, [
      req.hospitalId||0,
      id,
      type,
      identifier,
      mode === "INTEGRATE" ? "HOSPITAL" : "CALIBRA"
    ]);

    res.json({
      ok: true,
      mode,
      identifier: {
        type,
        value: identifier
      }
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* INSPEKSI */
app.post("/api/inspection", requireRole("PETUGAS LAPANGAN", "PENANGGUNG JAWAB"), async (req, res) => {
  if (!needDb(res)) return;

  try {
    const equipment = await pool.query("SELECT id FROM equipment WHERE id=$1 AND hospital_id=$2 LIMIT 1",[Number(req.body.equipmentId),req.hospitalId||0]);
    if(!equipment.rows.length) return res.status(404).json({ok:false,error:"Alat tidak ditemukan pada tenant ini."});
    const result = await pool.query(`
      INSERT INTO inspections (hospital_id,equipment_id,condition,findings)
      VALUES ($1,$2,$3,$4)
      RETURNING *
    `,[req.hospitalId||0,Number(req.body.equipmentId),clean(req.body.condition || "BAIK"),clean(req.body.findings)]);

    res.json({
      ok: true,
      inspection: result.rows[0],
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

/* LAPORAN PETUGAS */
app.post("/api/field-report", requireRole("PETUGAS LAPANGAN", "PENANGGUNG JAWAB"), async (req, res) => {
  if (!needDb(res)) return;

  try {
    const equipment = await pool.query("SELECT id FROM equipment WHERE id=$1 AND hospital_id=$2 LIMIT 1",[Number(req.body.equipmentId),req.hospitalId||0]);
    if(!equipment.rows.length) return res.status(404).json({ok:false,error:"Alat tidak ditemukan pada tenant ini."});
    const result = await pool.query(`
      INSERT INTO field_reports (hospital_id,equipment_id,report,officer_username)
      VALUES ($1,$2,$3,$4)
      RETURNING *
    `,[req.hospitalId||0,Number(req.body.equipmentId),clean(req.body.report),clean(req.user.username)]);

    await writeAudit("FIELD_REPORT_CREATED",{reportId:result.rows[0].id,equipmentId:Number(req.body.equipmentId)},req.user.username,req.hospitalId);
    await notify("PENANGGUNG JAWAB",null,"Laporan lapangan baru","Laporan baru masuk untuk alat ID "+Number(req.body.equipmentId)+".",req.hospitalId);
    res.json({
      ok: true,
      report: result.rows[0],
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
/* UPLOAD FOTO EVIDENCE */

app.post(
  "/api/evidence",
  requireRole("PETUGAS LAPANGAN", "PENANGGUNG JAWAB"),
  upload.single("photo"),
  async (req, res) => {

    if (!needDb(res)) return;

    try {

      const equipmentId =
        Number(req.body.equipmentId);

      const reportId =
        Number(req.body.reportId);
      const ownership = await pool.query("SELECT e.id FROM equipment e JOIN field_reports fr ON fr.id=$2 AND fr.equipment_id=e.id WHERE e.id=$1 AND e.hospital_id=$3 AND fr.hospital_id=$3 LIMIT 1",[equipmentId,reportId,req.hospitalId||0]);
      if(!ownership.rows.length) return res.status(404).json({ok:false,error:"Alat atau laporan tidak berada pada tenant ini."});

      if (!equipmentId || !reportId) {
        return res.status(400).json({
          ok: false,
          error: "equipmentId dan reportId wajib diisi."
        });
      }

      if (!req.file) {
        return res.status(400).json({
          ok: false,
          error: "Foto evidence wajib dipilih."
        });
      }

      const allowedEvidenceTypes = ["image/jpeg", "image/png", "image/webp"];
      if (!allowedEvidenceTypes.includes(req.file.mimetype)) {
        return res.status(400).json({
          ok: false,
          error: "Format evidence harus JPG, PNG, atau WEBP."
        });
      }

      const result = await pool.query(
        `
        INSERT INTO evidence_files (
          hospital_id,
          equipment_id,
          report_id,
          evidence_type,
          original_name,
          mime_type,
          file_size,
          file_data
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING
          id,
          equipment_id,
          report_id,
          original_name,
          mime_type,
          file_size,
          created_at
        `,
        [
          req.hospitalId||0,
          equipmentId,
          reportId,
          clean(req.body.evidenceType || "ORIGINAL").toUpperCase(),
          req.file.originalname,
          req.file.mimetype,
          req.file.size,
          req.file.buffer
        ]
      );

      await writeAudit("EVIDENCE_UPLOADED",{evidenceId:result.rows[0].id,reportId,equipmentId,evidenceType:clean(req.body.evidenceType||"ORIGINAL").toUpperCase()},req.user.username,req.hospitalId);
      res.json({
        ok: true,
        evidence: result.rows[0],
        serverTime: new Date().toISOString()
      });

    } catch (error) {

      res.status(500).json({
        ok: false,
        error: error.message
      });

    }
  }
);/* LIHAT FOTO EVIDENCE */

app.get("/api/evidence/:id", async (req, res) => {

  if (!needDb(res)) return;

  const id = Number(req.params.id);

  if (!id) {
    return res.status(400).json({
      ok: false,
      error: "ID evidence tidak valid."
    });
  }

  try {

    const result = await pool.query(
      `
      SELECT
        mime_type,
        file_size,
        file_data,
        evidence_type
      FROM evidence_files
      WHERE hospital_id = $2 AND id = $1
         OR (
           report_id = (
             SELECT report_id
             FROM evidence_files
             WHERE hospital_id = $2 AND id = $1
             LIMIT 1
           )
           AND evidence_type = 'STAMPED'
         )
      ORDER BY
        CASE WHEN evidence_type = 'STAMPED' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
      `,
      [id,req.hospitalId||0]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        ok: false,
        error: "Evidence tidak ditemukan."
      });
    }

    const evidence = result.rows[0];

    res.setHeader(
      "Content-Type",
      evidence.mime_type
    );

    res.setHeader(
      "Content-Disposition",
      "inline"
    );

    res.send(evidence.file_data);

  } catch (error) {

    res.status(500).json({
      ok: false,
      error: error.message
    });

  }

});
/* ACTION / WORK ORDER */
app.post("/api/actions", requireRole("PENANGGUNG JAWAB"), async (req, res) => {
  if (!needDb(res)) return;
  try {
    const ownership=await pool.query("SELECT e.id FROM equipment e JOIN field_reports fr ON fr.id=$2 AND fr.equipment_id=e.id WHERE e.id=$1 AND e.hospital_id=$3 AND fr.hospital_id=$3 LIMIT 1",[Number(req.body.equipmentId),Number(req.body.reportId),req.hospitalId||0]);
    if(!ownership.rows.length)return res.status(404).json({ok:false,error:"Alat atau laporan tidak berada pada tenant ini."});
    const result = await pool.query(
      `INSERT INTO actions (
        hospital_id, report_id, equipment_id, title, description, assigned_to, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`,
      [
        req.hospitalId||0,
        Number(req.body.reportId),
        Number(req.body.equipmentId),
        clean(req.body.title),
        clean(req.body.description || ""),
        clean(req.body.assignedTo || ""),
        clean(req.user.username)
      ]
    );
    await pool.query(
      `INSERT INTO action_status_history (
        hospital_id, action_id, from_status, to_status, changed_by
      ) VALUES ($1,$2,$3,$4,$5)`,
      [req.hospitalId||0,result.rows[0].id, null, result.rows[0].status, clean(req.user.username)]
    );
    await writeAudit("WORK_ORDER_CREATED",{actionId:result.rows[0].id,reportId:Number(req.body.reportId),equipmentId:Number(req.body.equipmentId)},req.user.username,req.hospitalId);
    await notify("PENANGGUNG JAWAB",null,"Work Order dibuat","Work Order baru dibuat untuk alat ID "+Number(req.body.equipmentId)+".",req.hospitalId);
    res.json({ ok: true, action: result.rows[0], serverTime: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/actions/all", async (req, res) => {
  if (!needDb(res)) return;
  try {
    const result = await pool.query(
      `SELECT
          a.*,
          e.asset_code,
          e.name AS equipment_name,
          COALESCE((
            SELECT json_agg(
              json_build_object(
                'id', x.id,
                'from_status', x.from_status,
                'to_status', x.to_status,
                'changed_by', x.changed_by,
                'changed_at', x.changed_at
              )
              ORDER BY x.changed_at ASC, x.id ASC
            )
            FROM (
              SELECT
                id,
                from_status,
                to_status,
                changed_by,
                changed_at
              FROM (
                SELECT
                  h.*,
                  ROW_NUMBER() OVER (
                    PARTITION BY h.to_status
                    ORDER BY h.changed_at DESC, h.id DESC
                  ) AS rn
                FROM action_status_history h
                WHERE h.action_id = a.id
              ) ranked
              WHERE ranked.rn = 1
            ) x
          ), '[]'::json) AS timeline
       FROM actions a
       LEFT JOIN equipment e ON e.id = a.equipment_id
       WHERE a.hospital_id = $1
       ORDER BY a.created_at DESC
       LIMIT 200`,[req.hospitalId||0]
    );
    res.json({ ok: true, actions: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.get("/api/actions/:reportId", async (req, res) => {
  if (!needDb(res)) return;
  try {
    const result = await pool.query(
      `SELECT * FROM actions WHERE report_id = $1 AND hospital_id = $2 ORDER BY created_at DESC`,
      [Number(req.params.reportId),req.hospitalId||0]
    );
    res.json({ ok: true, actions: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch("/api/actions/:id", requireRole("PENANGGUNG JAWAB"), async (req, res) => {
  if (!needDb(res)) return;
  try {
    const status = clean(req.body.status || "").toUpperCase();
    const allowed = ["NEW","ACKNOWLEDGED","IN PROGRESS","FIXED","VERIFIED","CLOSED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ ok: false, error: "Status tindakan tidak valid." });
    }
    const current = await pool.query(
      `SELECT id, status, created_by FROM actions WHERE id = $1 AND hospital_id = $2`,
      [Number(req.params.id),req.hospitalId||0]
    );
    if (!current.rows.length) return res.status(404).json({ ok: false, error: "Tindakan tidak ditemukan." });

    const previousStatus = current.rows[0].status;
    if (previousStatus === status) {
      return res.json({
        ok: true,
        action: current.rows[0],
        serverTime: new Date().toISOString()
      });
    }

    const result = await pool.query(
      `UPDATE actions SET status = $1, updated_at = NOW() WHERE id = $2 AND hospital_id = $3 RETURNING *`,
      [status, Number(req.params.id),req.hospitalId||0]
    );

    const changedBy = clean(req.user.username);
    await pool.query(
      `INSERT INTO action_status_history (
        hospital_id, action_id, from_status, to_status, changed_by
      ) VALUES ($1,$2,$3,$4,$5)`,
      [req.hospitalId||0,Number(req.params.id), previousStatus, status, changedBy]
    );

    await writeAudit("WORK_ORDER_STATUS_CHANGED",{actionId:Number(req.params.id),fromStatus:previousStatus,toStatus:status},changedBy,req.hospitalId);
    await notify("PENANGGUNG JAWAB",null,"Work Order berubah","Status Work Order #"+Number(req.params.id)+" menjadi "+status+".",req.hospitalId);
    res.json({ ok: true, action: result.rows[0], serverTime: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* GET STAMPED EVIDENCE BY REPORT */
app.get("/api/field-report/:id/stamped-evidence", async (req, res) => {
  if (!needDb(res)) return;

  const reportId = Number(req.params.id);
  if (!reportId) {
    return res.status(400).json({ ok: false, error: "ID laporan tidak valid." });
  }

  try {
    const result = await pool.query(
      `SELECT id, mime_type, file_size, evidence_type, created_at
       FROM evidence_files
       WHERE hospital_id=$2 AND report_id = $1 AND evidence_type = 'STAMPED'
       ORDER BY created_at DESC
       LIMIT 1`,
      [reportId,req.hospitalId||0]
    );

    if (!result.rows.length) {
      return res.status(404).json({ ok: false, error: "Stamped evidence belum tersedia." });
    }

    res.json({ ok: true, evidence: result.rows[0] });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

/* GET LAPORAN PETUGAS */
/* CERTIFICATE / DOCUMENT VAULT */
app.post("/api/certificates",requireRole("PENANGGUNG JAWAB"),upload.single("file"),async(req,res)=>{
  if(!needDb(res))return;
  try{
    const equipmentId=Number(req.body.equipmentId);
    if(!equipmentId||!req.file)return res.status(400).json({ok:false,error:"Alat dan file sertifikat wajib diisi."});
    const equipment=await pool.query("SELECT id FROM equipment WHERE id=$1 AND hospital_id=$2 LIMIT 1",[equipmentId,req.hospitalId||0]);
    if(!equipment.rows.length)return res.status(404).json({ok:false,error:"Alat tidak ditemukan pada tenant ini."});
    const allowedCertificateTypes = ["application/pdf", "image/jpeg", "image/png", "image/webp"];
    if (!allowedCertificateTypes.includes(req.file.mimetype)) {
      return res.status(400).json({ok:false,error:"Format sertifikat harus PDF, JPG, PNG, atau WEBP."});
    }
    const result=await pool.query(`INSERT INTO certificate_files (hospital_id,equipment_id,original_name,mime_type,file_size,file_data,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,equipment_id,original_name,mime_type,file_size,uploaded_by,created_at`,[req.hospitalId||0,equipmentId,req.file.originalname,req.file.mimetype,req.file.size,req.file.buffer,clean(req.user.username)]);
    await writeAudit("CERTIFICATE_UPLOADED",{certificateId:result.rows[0].id,equipmentId},req.user.username,req.hospitalId);
    res.json({ok:true,certificate:result.rows[0]});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});
app.get("/api/certificates",requireRole("PENANGGUNG JAWAB","DIREKSI"),async(req,res)=>{
  if(!needDb(res))return;
  try{const result=await pool.query(`SELECT c.id,c.equipment_id,e.asset_code,e.name AS equipment_name,c.original_name,c.mime_type,c.file_size,c.uploaded_by,c.created_at FROM certificate_files c LEFT JOIN equipment e ON e.id=c.equipment_id WHERE c.hospital_id=$1 ORDER BY c.created_at DESC LIMIT 200`,[req.hospitalId||0]);res.json({ok:true,certificates:result.rows});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});
app.get("/api/certificates/:id",requireRole("PENANGGUNG JAWAB","DIREKSI"),async(req,res)=>{
  if(!needDb(res))return;
  try{const result=await pool.query(`SELECT mime_type,original_name,file_data FROM certificate_files WHERE id=$1 AND hospital_id=$2`,[Number(req.params.id),req.hospitalId||0]);if(!result.rows.length)return res.status(404).json({ok:false,error:"Sertifikat tidak ditemukan."});res.setHeader("Content-Type",result.rows[0].mime_type);const safeFilename = String(result.rows[0].original_name || "certificate").replace(/[\r\n"]/g, "_").slice(0, 180);
    res.setHeader("Content-Disposition",`inline; filename="${safeFilename}"`);res.send(result.rows[0].file_data);}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});

/* NOTIFICATIONS */
app.get("/api/notifications",async(req,res)=>{
  if(!needDb(res))return;
  try{const result=await pool.query(`SELECT id,title,message,is_read,created_at FROM notifications WHERE hospital_id=$3 AND (recipient_username=$1 OR recipient_role=$2) ORDER BY created_at DESC LIMIT 50`,[clean(req.user.username),clean(req.user.role),req.hospitalId||0]);res.json({ok:true,notifications:result.rows});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});
app.patch("/api/notifications/:id/read",async(req,res)=>{
  if(!needDb(res))return;
  try{await pool.query(`UPDATE notifications SET is_read=TRUE WHERE id=$1 AND hospital_id=$4 AND (recipient_username=$2 OR recipient_role=$3)`,[Number(req.params.id),clean(req.user.username),clean(req.user.role),req.hospitalId||0]);res.json({ok:true});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});

/* AUDIT */
app.get("/api/audit-logs",requireRole("PENANGGUNG JAWAB","DIREKSI"),async(req,res)=>{
  if(!needDb(res))return;
  try{const result=await pool.query(`SELECT id,action,details,created_at FROM audit_logs WHERE hospital_id=$1 ORDER BY created_at DESC,id DESC LIMIT 200`,[req.hospitalId||0]);res.json({ok:true,logs:result.rows});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});

/* EXPORT */
app.get("/api/export/report.csv",requireRole("PENANGGUNG JAWAB","DIREKSI"),async(req,res)=>{
  if(!needDb(res))return;
  try{
    const result=await pool.query(`SELECT e.asset_code,e.name,e.brand,e.model,e.serial_number,e.room,e.calibration_date,e.due_date,CASE WHEN e.due_date IS NULL THEN 'UNKNOWN' WHEN e.due_date < CURRENT_DATE THEN 'EXPIRED' WHEN e.due_date < CURRENT_DATE + INTERVAL '31 days' THEN 'NEAR_DUE' ELSE 'VALID' END AS calibration_status FROM equipment e WHERE e.hospital_id=$1 ORDER BY e.asset_code`,[req.hospitalId||0]);
    const header=["Kode Aset","Nama Alat","Merk","Model","Nomor Seri","Ruangan","Tanggal Kalibrasi","Jatuh Tempo","Status"];
    const csv=[header,...result.rows.map(r=>[r.asset_code,r.name,r.brand,r.model,r.serial_number,r.room,r.calibration_date,r.due_date,r.calibration_status])].map(row=>row.map(v=>`"${String(v??"").replace(/"/g,'""')}"`).join(",")).join("\n");
    res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",'attachment; filename="CALIBRA_RS_Report.csv"');res.send("\ufeff"+csv);
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});

app.get("/api/field-report", async (req, res) => {
  if (!needDb(res)) return;

  try {
    const result = await pool.query(`
      SELECT
  fr.id,
  fr.equipment_id,
  e.asset_code,
  e.name AS equipment_name,
  fr.report,
  fr.created_at,
  ev.id AS evidence_id
FROM field_reports fr
LEFT JOIN equipment e
  ON e.id = fr.equipment_id
LEFT JOIN LATERAL (
  SELECT id
  FROM evidence_files
  WHERE hospital_id=$2 AND report_id = fr.id
  ORDER BY
    CASE WHEN evidence_type = 'STAMPED' THEN 0 ELSE 1 END,
    created_at DESC
  LIMIT 1
) ev ON true
      WHERE fr.hospital_id=$1
      ORDER BY fr.created_at DESC
      LIMIT 100
    `,[req.hospitalId||0,req.hospitalId||0]);

    res.json({
      ok: true,
      total: result.rows.length,
      reports: result.rows,
      serverTime: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
  /* PENTING:
  Server LISTEN DULU.
  PostgreSQL menyusul di background.
  Ini memperbaiki Railway Healthcheck.
*/
app.listen(PORT, () => {
  console.log(`CALIBRA RS berjalan di port ${PORT}`);

  initDb().catch(error => {
    console.error("Database init gagal:", error.message);
  });
});
