// Railway redeploy trigger: chronological Work Order timeline is deployed from main.
const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const { Pool } = require("pg");
const QRCode = require("qrcode");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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
  limits: { fileSize: 10 * 1024 * 1024 }
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hospitals (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id SERIAL PRIMARY KEY,
      hospital_id INTEGER REFERENCES hospitals(id),
      asset_code TEXT NOT NULL,
      name TEXT NOT NULL,
      brand TEXT,
      model TEXT,
      serial_number TEXT,
      room TEXT,
      calibration_date DATE,
      due_date DATE,
      condition TEXT DEFAULT 'BAIK',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(hospital_id, asset_code)
    );

    CREATE TABLE IF NOT EXISTS equipment_identifiers (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      source TEXT DEFAULT 'CALIBRA',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(equipment_id, identifier_type, identifier_value)
    );

    CREATE TABLE IF NOT EXISTS calibrations (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      calibration_date DATE,
      due_date DATE,
      status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS inspections (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      condition TEXT,
      findings TEXT,
      inspected_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS field_reports (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      report TEXT NOT NULL,
      status TEXT DEFAULT 'OPEN',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
CREATE TABLE IF NOT EXISTS evidence_files (
  id SERIAL PRIMARY KEY,
  equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
  report_id INTEGER REFERENCES field_reports(id) ON DELETE CASCADE,
  original_name TEXT,
  mime_type TEXT NOT NULL,
  file_size INTEGER,
  file_data BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      action TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE evidence_files
    ADD COLUMN IF NOT EXISTS evidence_type TEXT DEFAULT 'ORIGINAL'
  `);

  await pool.query(`
    ALTER TABLE field_reports
    ADD COLUMN IF NOT EXISTS officer_username TEXT
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS actions (
      id SERIAL PRIMARY KEY,
      report_id INTEGER REFERENCES field_reports(id) ON DELETE CASCADE,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      assigned_to TEXT,
      status TEXT DEFAULT 'NEW',
      created_by TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS action_status_history (
      id SERIAL PRIMARY KEY,
      action_id INTEGER REFERENCES actions(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      changed_by TEXT,
      changed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`CREATE TABLE IF NOT EXISTS certificate_files (
    id SERIAL PRIMARY KEY,
    equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
    original_name TEXT,
    mime_type TEXT NOT NULL,
    file_size INTEGER,
    file_data BYTEA NOT NULL,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    recipient_role TEXT,
    recipient_username TEXT,
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    is_read BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`);

  // Backfill the initial status event for existing Work Orders.
  await pool.query(`
    INSERT INTO action_status_history (
      action_id, from_status, to_status, changed_by, changed_at
    )
    SELECT
      a.id,
      NULL,
      a.status,
      COALESCE(a.created_by, ''),
      a.created_at
    FROM actions a
    WHERE NOT EXISTS (
      SELECT 1 FROM action_status_history h WHERE h.action_id = a.id
    )
  `);

  // Seed satu Work Order demo agar alur PJ dapat langsung diuji.
  await pool.query(`
    INSERT INTO actions (
      report_id,
      equipment_id,
      title,
      description,
      assigned_to,
      status,
      created_by
    )
    SELECT
      fr.id,
      fr.equipment_id,
      'Pemeriksaan Patient Monitor',
      'Periksa alarm dan lakukan troubleshooting.',
      'Teknisi IPSRS',
      'NEW',
      'pj'
    FROM field_reports fr
    JOIN equipment e ON e.id = fr.equipment_id
    WHERE e.asset_code = 'ICU-101'
      AND NOT EXISTS (SELECT 1 FROM actions)
    ORDER BY fr.created_at DESC
    LIMIT 1
  `);


  await pool.query(`
    INSERT INTO hospitals (code, name)
    VALUES ('RS-DEMO', 'Rumah Sakit Demo')
    ON CONFLICT (code) DO NOTHING
  `);

  dbReady = true;
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

async function writeAudit(action, details, actor) {
  if (!pool || !dbReady) return;
  try {
    await pool.query(`INSERT INTO audit_logs (action, details) VALUES ($1,$2)`,
      [clean(action), JSON.stringify({ ...(details || {}), actor: clean(actor || "") })]);
  } catch (error) { console.error("Audit log gagal:", error.message); }
}

async function notify(recipientRole, recipientUsername, title, message) {
  if (!pool || !dbReady) return;
  try {
    await pool.query(`INSERT INTO notifications (recipient_role, recipient_username, title, message) VALUES ($1,$2,$3,$4)`,
      [clean(recipientRole), clean(recipientUsername), clean(title), clean(message)]);
  } catch (error) { console.error("Notification gagal:", error.message); }
}

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
        (SELECT COUNT(*)::int FROM field_reports WHERE status = 'OPEN') AS open_findings,
        (SELECT COUNT(*)::int FROM actions WHERE status NOT IN ('CLOSED')) AS open_actions
      FROM equipment
    `);

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
      ORDER BY id DESC
      LIMIT 500
    `);

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
app.post("/api/import-excel/preview", upload.single("file"), async (req, res) => {
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
app.post("/api/import-excel/confirm", upload.single("file"), async (req, res) => {
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
      "SELECT id FROM hospitals WHERE code = 'RS-DEMO'"
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
          equipment_id,
          calibration_date,
          due_date,
          status
        )
        VALUES ($1,$2,$3,$4)
      `, [
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
       WHERE asset_code = $1
       LIMIT 1`,
      [code]
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
app.post("/api/equipment/:id/qr", async (req, res) => {
  if (!needDb(res)) return;

  const id = Number(req.params.id);
  const mode = clean(req.body?.mode || "GENERATE").toUpperCase();
  let identifier = clean(req.body?.identifierValue);

  try {
    const equipment = await pool.query(
      "SELECT id, asset_code, name FROM equipment WHERE id = $1",
      [id]
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
        equipment_id,
        identifier_type,
        identifier_value,
        source
      )
      VALUES ($1,$2,$3,$4)
      ON CONFLICT DO NOTHING
    `, [
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
app.post("/api/inspection", async (req, res) => {
  if (!needDb(res)) return;

  try {
    const result = await pool.query(`
      INSERT INTO inspections (
        equipment_id,
        condition,
        findings
      )
      VALUES ($1,$2,$3)
      RETURNING *
    `, [
      Number(req.body.equipmentId),
      clean(req.body.condition || "BAIK"),
      clean(req.body.findings)
    ]);

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
app.post("/api/field-report", async (req, res) => {
  if (!needDb(res)) return;

  try {
    const result = await pool.query(`
      INSERT INTO field_reports (
        equipment_id,
        report,
        officer_username
      )
      VALUES ($1,$2,$3)
      RETURNING *
    `, [
      Number(req.body.equipmentId),
      clean(req.body.report),
      clean(req.body.officerUsername || "")
    ]);

    await writeAudit("FIELD_REPORT_CREATED",{reportId:result.rows[0].id,equipmentId:Number(req.body.equipmentId)},req.body.officerUsername);
    await notify("PENANGGUNG JAWAB","pj","Laporan lapangan baru","Laporan baru masuk untuk alat ID "+Number(req.body.equipmentId)+".");
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
  upload.single("photo"),
  async (req, res) => {

    if (!needDb(res)) return;

    try {

      const equipmentId =
        Number(req.body.equipmentId);

      const reportId =
        Number(req.body.reportId);

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

      const result = await pool.query(
        `
        INSERT INTO evidence_files (
          equipment_id,
          report_id,
          evidence_type,
          original_name,
          mime_type,
          file_size,
          file_data
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7)
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
          equipmentId,
          reportId,
          clean(req.body.evidenceType || "ORIGINAL").toUpperCase(),
          req.file.originalname,
          req.file.mimetype,
          req.file.size,
          req.file.buffer
        ]
      );

      await writeAudit("EVIDENCE_UPLOADED",{evidenceId:result.rows[0].id,reportId,equipmentId,evidenceType:clean(req.body.evidenceType||"ORIGINAL").toUpperCase()},"");
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
      WHERE id = $1
         OR (
           report_id = (
             SELECT report_id
             FROM evidence_files
             WHERE id = $1
             LIMIT 1
           )
           AND evidence_type = 'STAMPED'
         )
      ORDER BY
        CASE WHEN evidence_type = 'STAMPED' THEN 0 ELSE 1 END,
        created_at DESC
      LIMIT 1
      `,
      [id]
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
app.post("/api/actions", async (req, res) => {
  if (!needDb(res)) return;
  try {
    const result = await pool.query(
      `INSERT INTO actions (
        report_id, equipment_id, title, description, assigned_to, created_by
      ) VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *`,
      [
        Number(req.body.reportId),
        Number(req.body.equipmentId),
        clean(req.body.title),
        clean(req.body.description || ""),
        clean(req.body.assignedTo || ""),
        clean(req.body.createdBy || "")
      ]
    );
    await pool.query(
      `INSERT INTO action_status_history (
        action_id, from_status, to_status, changed_by
      ) VALUES ($1,$2,$3,$4)`,
      [result.rows[0].id, null, result.rows[0].status, clean(req.body.createdBy || "")]
    );
    await writeAudit("WORK_ORDER_CREATED",{actionId:result.rows[0].id,reportId:Number(req.body.reportId),equipmentId:Number(req.body.equipmentId)},req.body.createdBy);
    await notify("PENANGGUNG JAWAB","pj","Work Order dibuat","Work Order baru dibuat untuk alat ID "+Number(req.body.equipmentId)+".");
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
       ORDER BY a.created_at DESC
       LIMIT 200`
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
      `SELECT * FROM actions WHERE report_id = $1 ORDER BY created_at DESC`,
      [Number(req.params.reportId)]
    );
    res.json({ ok: true, actions: result.rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.patch("/api/actions/:id", async (req, res) => {
  if (!needDb(res)) return;
  try {
    const status = clean(req.body.status || "").toUpperCase();
    const allowed = ["NEW","ACKNOWLEDGED","IN PROGRESS","FIXED","VERIFIED","CLOSED"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ ok: false, error: "Status tindakan tidak valid." });
    }
    const current = await pool.query(
      `SELECT id, status, created_by FROM actions WHERE id = $1`,
      [Number(req.params.id)]
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
      `UPDATE actions SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, Number(req.params.id)]
    );

    const changedBy = clean(req.body.changedBy || current.rows[0].created_by || "");
    await pool.query(
      `INSERT INTO action_status_history (
        action_id, from_status, to_status, changed_by
      ) VALUES ($1,$2,$3,$4)`,
      [Number(req.params.id), previousStatus, status, changedBy]
    );

    await writeAudit("WORK_ORDER_STATUS_CHANGED",{actionId:Number(req.params.id),fromStatus:previousStatus,toStatus:status},changedBy);
    await notify("PENANGGUNG JAWAB","pj","Work Order berubah","Status Work Order #"+Number(req.params.id)+" menjadi "+status+".");
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
       WHERE report_id = $1 AND evidence_type = 'STAMPED'
       ORDER BY created_at DESC
       LIMIT 1`,
      [reportId]
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
app.post("/api/certificates",upload.single("file"),async(req,res)=>{
  if(!needDb(res))return;
  try{
    const equipmentId=Number(req.body.equipmentId);
    if(!equipmentId||!req.file)return res.status(400).json({ok:false,error:"Alat dan file sertifikat wajib diisi."});
    const result=await pool.query(`INSERT INTO certificate_files (equipment_id,original_name,mime_type,file_size,file_data,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,equipment_id,original_name,mime_type,file_size,uploaded_by,created_at`,[equipmentId,req.file.originalname,req.file.mimetype,req.file.size,req.file.buffer,clean(req.body.uploadedBy||"")]);
    await writeAudit("CERTIFICATE_UPLOADED",{certificateId:result.rows[0].id,equipmentId},req.body.uploadedBy);
    res.json({ok:true,certificate:result.rows[0]});
  }catch(error){res.status(500).json({ok:false,error:error.message});}
});
app.get("/api/certificates",async(req,res)=>{
  if(!needDb(res))return;
  try{const result=await pool.query(`SELECT c.id,c.equipment_id,e.asset_code,e.name AS equipment_name,c.original_name,c.mime_type,c.file_size,c.uploaded_by,c.created_at FROM certificate_files c LEFT JOIN equipment e ON e.id=c.equipment_id ORDER BY c.created_at DESC LIMIT 200`);res.json({ok:true,certificates:result.rows});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});
app.get("/api/certificates/:id",async(req,res)=>{
  if(!needDb(res))return;
  try{const result=await pool.query(`SELECT mime_type,original_name,file_data FROM certificate_files WHERE id=$1`,[Number(req.params.id)]);if(!result.rows.length)return res.status(404).json({ok:false,error:"Sertifikat tidak ditemukan."});res.setHeader("Content-Type",result.rows[0].mime_type);res.setHeader("Content-Disposition",`inline; filename="${result.rows[0].original_name}"`);res.send(result.rows[0].file_data);}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});

/* NOTIFICATIONS */
app.get("/api/notifications",async(req,res)=>{
  if(!needDb(res))return;
  try{const result=await pool.query(`SELECT id,title,message,is_read,created_at FROM notifications WHERE (recipient_username=$1 OR recipient_role=$2) ORDER BY created_at DESC LIMIT 50`,[clean(req.query.username||""),clean(req.query.role||"")]);res.json({ok:true,notifications:result.rows});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});
app.patch("/api/notifications/:id/read",async(req,res)=>{
  if(!needDb(res))return;
  try{await pool.query(`UPDATE notifications SET is_read=TRUE WHERE id=$1`,[Number(req.params.id)]);res.json({ok:true});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});

/* AUDIT */
app.get("/api/audit-logs",async(req,res)=>{
  if(!needDb(res))return;
  try{const result=await pool.query(`SELECT id,action,details,created_at FROM audit_logs ORDER BY created_at DESC,id DESC LIMIT 200`);res.json({ok:true,logs:result.rows});}
  catch(error){res.status(500).json({ok:false,error:error.message});}
});

/* EXPORT */
app.get("/api/export/report.csv",async(req,res)=>{
  if(!needDb(res))return;
  try{
    const result=await pool.query(`SELECT e.asset_code,e.name,e.brand,e.model,e.serial_number,e.room,e.calibration_date,e.due_date,CASE WHEN e.due_date IS NULL THEN 'UNKNOWN' WHEN e.due_date < CURRENT_DATE THEN 'EXPIRED' WHEN e.due_date < CURRENT_DATE + INTERVAL '31 days' THEN 'NEAR_DUE' ELSE 'VALID' END AS calibration_status FROM equipment e ORDER BY e.asset_code`);
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
  WHERE report_id = fr.id
  ORDER BY
    CASE WHEN evidence_type = 'STAMPED' THEN 0 ELSE 1 END,
    created_at DESC
  LIMIT 1
) ev ON true
      ORDER BY fr.created_at DESC
      LIMIT 100
    `);

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