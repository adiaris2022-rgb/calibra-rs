const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "CALIBRA RS",
    message: "Server sedang berjalan"
  });
});

app.get("/api/dashboard", (req, res) => {
  res.json({
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
});


app.listen(PORT, () => {
  console.log(`CALIBRA RS berjalan di port ${PORT}`);
});
