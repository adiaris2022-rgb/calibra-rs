const express = require("express");
const path = require("path");
const multer = require("multer");
const XLSX = require("xlsx");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }
});

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("railway")
        ? { rejectUnauthorized: false }
        : false
    })
  : null;

const DEMO_HOSPITAL_CODE = "RS-DEMO";

function normalize(value) {
  return String(value ?? "").trim();
}

function normalizeHeader(value) {
  return normalize(value)
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function findColumn(headers, names) {
  for (const name of names) {
    const wanted = normalizeHeader(name);
    const found = headers.find(
      h => normalizeHeader(h) === wanted
    );
    if (found) return found;
  }
  return null;
}

function excelDate(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value instanceof Date && !isNaN(value)) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number") {
    const date = XLSX.SSF.parse_date_code(value);
    if (date) {
      return `${date.y}-${String(date.m).padStart(2, "0")}-${String(date.d).padStart(2, "0")}`;
    }
  }

  const text = normalize(value);

  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    return text.slice(0, 10);
  }

  const parsed = new Date(text);

  if (!isNaN(parsed)) {
    return parsed.toISOString().slice(0, 10);
  }

  return null;
}

function calibrationStatus(dueDate) {
  if (!dueDate) return "UNKNOWN";

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = new Date(`${dueDate}T00:00:00`);
  const diff = Math.ceil(
    (due - today) / (1000 * 60 * 60 * 24)
  );

  if (diff < 0) return "EXPIRED";
  if (diff <= 30) return "NEAR_DUE";
  return "VALID";
}

/* =========================
   DATABASE
========================= */

async function initDb() {
  if (!pool) {
    console.log("DATABASE_URL belum tersedia.");
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS hospitals (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      hospital_id INTEGER REFERENCES hospitals(id),
      username TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(hospital_id, username)
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
      status TEXT DEFAULT 'UNKNOWN',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(hospital_id, asset_code)
    );

    CREATE TABLE IF NOT EXISTS calibrations (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      calibration_date DATE,
      due_date DATE,
      status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS equipment_identifiers (
      id SERIAL PRIMARY KEY,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE CASCADE,
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      source TEXT,
      is_primary BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(identifier_type, identifier_value)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      hospital_id INTEGER REFERENCES hospitals(id),
      action TEXT NOT NULL,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await pool.query(
    `
    INSERT INTO hospitals (code, name)
    VALUES ($1, $2)
    ON CONFLICT (code) DO NOTHING
    `,
    [DEMO_HOSPITAL_CODE, "Rumah Sakit Demo CALIBRA"]
  );

  console.log("Database CALIBRA RS siap.");
}

/* =========================
   HEALTH
========================= */

app.get("/api/health", async (req, res) => {
  try {
    if (pool) {
      await pool.query("SELECT 1");
    }

    res.json({
      ok: true,
      app: "CALIBRA RS",
      database: Boolean(pool),
      message: "Server sedang berjalan"
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      app: "CALIBRA RS",
      message: "Database bermasalah"
    });
  }
});

/* =========================
   DASHBOARD
========================= */

app.get("/api/dashboard", async (req, res) => {
  try {
    if (!pool) {
      return res.json({
        equipment: 1248,
        valid: 1103,
        nearDue: 87,
        expired: 58,
        openFindings: 12,
        recent: [
          {
            equipment: "Patient Monitor",
            code: "ICU-003",
            finding: "Alarm tidak berbunyi",
            status: "OPEN",
            time: new Date().toISOString()
          }
        ]
      });
    }

    const hospital = await pool.query(
      `SELECT id FROM hospitals WHERE code = $1`,
      [DEMO_HOSPITAL_CODE]
    );

    const hospitalId = hospital.rows[0]?.id;

    if (!hospitalId) {
      return res.json({
        equipment: 0,
        valid: 0,
        nearDue: 0,
        expired: 0,
        openFindings: 0,
        recent: []
      });
    }

    const result = await pool.query(
      `
      SELECT
        COUNT(*)::int AS equipment,
        COUNT(*) FILTER (WHERE status = 'VALID')::int AS valid,
        COUNT(*) FILTER (WHERE status = 'NEAR_DUE')::int AS "nearDue",
        COUNT(*) FILTER (WHERE status = 'EXPIRED')::int AS expired
      FROM equipment
      WHERE hospital_id = $1
      `,
      [hospitalId]
    );

    res.json({
      equipment: result.rows[0].equipment,
      valid: result.rows[0].valid,
      nearDue: result.rows[0].nearDue,
      expired: result.rows[0].expired,
      openFindings: 0,
      recent: []
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Gagal mengambil dashboard"
    });
  }
});

/* =========================
   EQUIPMENT
========================= */

app.get("/api/equipment", async (req, res) => {
  try {
    if (!pool) {
      return res.json([]);
    }

    const result = await pool.query(`
      SELECT
        e.id,
        e.asset_code,
        e.name,
        e.brand,
        e.model,
        e.serial_number,
        e.room,
        e.calibration_date,
        e.due_date,
        e.status
      FROM equipment e
      JOIN hospitals h ON h.id = e.hospital_id
      WHERE h.code = $1
      ORDER BY e.asset_code
    `, [DEMO_HOSPITAL_CODE]);

    res.json(result.rows);

  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Gagal mengambil data alat"
    });
  }
});

/* =========================
   EXCEL PREVIEW
========================= */

app.post(
  "/api/import-excel/preview",
  upload.single("file"),
  async (req, res) => {

    try {

      if (!req.file) {
        return res.status(400).json({
          error: "File Excel belum dipilih."
        });
      }

      const workbook = XLSX.read(req.file.buffer, {
        type: "buffer",
        cellDates: true
      });

      const sheetName = workbook.SheetNames[0];

      if (!sheetName) {
        return res.status(400).json({
          error: "Sheet Excel tidak ditemukan."
        });
      }

      const sheet = workbook.Sheets[sheetName];

      const rows = XLSX.utils.sheet_to_json(sheet, {
        defval: ""
      });

      if (!rows.length) {
        return res.status(400).json({
          error: "Excel tidak memiliki data."
        });
      }

      const headers = Object.keys(rows[0]);

      const columns = {
        assetCode: findColumn(headers, [
          "asset_code",
          "kode aset",
          "kode alat",
          "kode",
          "no aset",
          "nomor aset"
        ]),

        name: findColumn(headers, [
          "name",
          "nama alat",
          "nama",
          "alat",
          "nama peralatan"
        ]),

        brand: findColumn(headers, [
          "brand",
          "merk",
          "merek"
        ]),

        model: findColumn(headers, [
          "model",
          "tipe",
          "type"
        ]),

        serial: findColumn(headers, [
          "serial_number",
          "nomor seri",
          "no seri",
          "serial"
        ]),

        room: findColumn(headers, [
          "room",
          "ruangan",
          "lokasi",
          "unit",
          "ruang"
        ]),

        calibrationDate: findColumn(headers, [
          "tanggal kalibrasi",
          "calibration date"
        ]),

        dueDate: findColumn(headers, [
          "jatuh tempo",
          "due date",
          "tanggal jatuh tempo"
        ])
      };

      const seen = new Set();
      const validation = [];
      const normalizedRows = [];

      rows.forEach((row, index) => {

        const rowNumber = index + 2;

        const assetCode = normalize(
          columns.assetCode ? row[columns.assetCode] : ""
        );

        const name = normalize(
          columns.name ? row[columns.name] : ""
        );

        const duplicate =
          assetCode && seen.has(assetCode);

        if (assetCode) {
          seen.add(assetCode);
        }

        const errors = [];

        if (!assetCode) {
          errors.push("Kode aset kosong");
        }

        if (!name) {
          errors.push("Nama alat kosong");
        }

        if (duplicate) {
          errors.push("Kode aset duplikat dalam file");
        }

        validation.push({
          row: rowNumber,
          assetCode,
          name,
          errors,
          valid: errors.length === 0
        });

        normalizedRows.push({
          assetCode,
          name,
          brand: normalize(
            columns.brand ? row[columns.brand] : ""
          ),
          model: normalize(
            columns.model ? row[columns.model] : ""
          ),
          serial: normalize(
            columns.serial ? row[columns.serial] : ""
          ),
          room: normalize(
            columns.room ? row[columns.room] : ""
          ),
          calibrationDate: excelDate(
            columns.calibrationDate
              ? row[columns.calibrationDate]
              : ""
          ),
          dueDate: excelDate(
            columns.dueDate
              ? row[columns.dueDate]
              : ""
          )
        });

      });

      const validCount =
        validation.filter(x => x.valid).length;

      const invalidCount =
        validation.filter(x => !x.valid).length;

      res.json({
        ok: true,
        sheet: sheetName,
        total: rows.length,
        valid: validCount,
        invalid: invalidCount,
        columns,
        validation: validation.slice(0, 100),
        rows: normalizedRows.slice(0, 100)
      });

    } catch (error) {

      console.error(error);

      res.status(500).json({
        error: "Gagal membaca Excel."
      });

    }
  }
);

/* =========================
   EXCEL CONFIRM IMPORT
========================= */

app.post(
  "/api/import-excel/confirm",
  async (req, res) => {

    if (!pool) {
      return res.status(503).json({
        error: "DATABASE_URL belum tersedia."
      });
    }

    const client = await pool.connect();

    try {

      const rows = Array.isArray(req.body.rows)
        ? req.body.rows
        : [];

      if (!rows.length) {
        return res.status(400).json({
          error: "Tidak ada data untuk diimport."
        });
      }

      const hospitalResult = await client.query(
        `SELECT id FROM hospitals WHERE code = $1`,
        [DEMO_HOSPITAL_CODE]
      );

      const hospitalId =
        hospitalResult.rows[0]?.id;

      if (!hospitalId) {
        throw new Error("Hospital tidak ditemukan.");
      }

      await client.query("BEGIN");

      let inserted = 0;
      let updated = 0;

      for (const row of rows) {

        if (!row.assetCode || !row.name) {
          continue;
        }

        const status =
          calibrationStatus(row.dueDate);

        const existing = await client.query(
          `
          SELECT id
          FROM equipment
          WHERE hospital_id = $1
          AND asset_code = $2
          `,
          [
            hospitalId,
            row.assetCode
          ]
        );

        const result = await client.query(
          `
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
            status,
            updated_at
          )
          VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW()
          )
          ON CONFLICT (hospital_id, asset_code)
          DO UPDATE SET
            name = EXCLUDED.name,
            brand = EXCLUDED.brand,
            model = EXCLUDED.model,
            serial_number = EXCLUDED.serial_number,
            room = EXCLUDED.room,
            calibration_date = EXCLUDED.calibration_date,
            due_date = EXCLUDED.due_date,
            status = EXCLUDED.status,
            updated_at = NOW()
          RETURNING id
          `,
          [
            hospitalId,
            row.assetCode,
            row.name,
            row.brand || null,
            row.model || null,
            row.serial || null,
            row.room || null,
            row.calibrationDate || null,
            row.dueDate || null,
            status
          ]
        );

        const equipmentId =
          result.rows[0].id;

        if (existing.rows.length) {
          updated++;
        } else {
          inserted++;
        }

        if (row.calibrationDate || row.dueDate) {

          await client.query(
            `
            INSERT INTO calibrations (
              equipment_id,
              calibration_date,
              due_date,
              status
            )
            VALUES ($1,$2,$3,$4)
            `,
            [
              equipmentId,
              row.calibrationDate || null,
              row.dueDate || null,
              status
            ]
          );

        }

      }

      await client.query(
        `
        INSERT INTO audit_logs (
          hospital_id,
          action,
          details
        )
        VALUES ($1,$2,$3)
        `,
        [
          hospitalId,
          "IMPORT_EXCEL_CONFIRM",
          JSON.stringify({
            inserted,
            updated,
            total: rows.length
          })
        ]
      );

      await client.query("COMMIT");

      res.json({
        ok: true,
        inserted,
        updated,
        total: rows.length,
        message: "Import berhasil disimpan ke PostgreSQL."
      });

    } catch (error) {

      await client.query("ROLLBACK");

      console.error(error);

      res.status(500).json({
        error: "Import gagal dan transaksi dibatalkan.",
        detail: error.message
      });

    } finally {

      client.release();

    }
  }
);

/* =========================
   QR IDENTITY
========================= */

/*
  3 MODE IDENTITAS QR:

  1. INTEGRATE
     QR/barcode RS yang sudah ada
     dipetakan ke equipment.

  2. GENERATE
     CALIBRA membuat identifier baru.

  3. COMPANION
     QR pendamping CALIBRA untuk
     alat yang punya kode lama tetapi
     tidak kompatibel.
*/

app.post(
  "/api/equipment/:id/identifier",
  async (req, res) => {

    if (!pool) {
      return res.status(503).json({
        error: "Database belum tersedia."
      });
    }

    const equipmentId =
      Number(req.params.id);

    const {
      mode,
      identifierValue,
      identifierType
    } = req.body;

    const allowedModes = [
      "INTEGRATE",
      "GENERATE",
      "COMPANION"
    ];

    if (!allowedModes.includes(mode)) {
      return res.status(400).json({
        error: "Mode QR tidak valid."
      });
    }

    try {

      const equipment = await pool.query(
        `
        SELECT id
        FROM equipment
        WHERE id = $1
        `,
        [equipmentId]
      );

      if (!equipment.rows.length) {
        return res.status(404).json({
          error: "Alat tidak ditemukan."
        });
      }

      let value =
        normalize(identifierValue);

      if (mode === "GENERATE" || mode === "COMPANION") {

        value =
          `CALIBRA-${equipmentId}-${Date.now()}`;

      }

      if (!value) {
        return res.status(400).json({
          error: "Nilai identifier wajib diisi."
        });
      }

      const type =
        identifierType ||
        (mode === "INTEGRATE"
          ? "EXIST
